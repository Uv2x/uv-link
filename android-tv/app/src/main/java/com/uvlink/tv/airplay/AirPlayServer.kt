package com.uvlink.tv.airplay

import com.uvlink.tv.airplay.fairplay.FairPlayHandshake
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.DataInputStream
import java.io.IOException
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.Collections
import kotlin.concurrent.thread
import kotlin.math.pow

/** Events from the receiver. Called on network threads, so implementations must be thread-safe. */
interface AirPlayListener {
    /** A sender started screen mirroring; [client] is its name, e.g. "Yousef's iPhone". */
    fun onMirrorStarted(client: String)

    /** H.264 parameter sets for the frames that follow (sent at start and whenever the size changes). */
    fun onCodecConfig(sps: ByteArray, pps: ByteArray)

    /** One H.264 access unit in Annex B form (start codes). */
    fun onVideoFrame(annexB: ByteArray, ptsUs: Long, keyframe: Boolean)

    fun onMirrorStopped()

    /** [compressionType]: 8 = AAC-ELD (mirroring), 4 = AAC-LC, 2 = ALAC. */
    fun onAudioStarted(compressionType: Int, samplesPerFrame: Int)

    /** One decrypted audio frame in the stream's codec. */
    fun onAudioFrame(frame: ByteArray)

    fun onAudioStopped()

    /** Linear gain 0..1 from the sender's volume control. */
    fun onVolume(gain: Float)
}

/**
 * AirPlay screen-mirroring receiver (the AirPlay 1 / "legacy pairing" protocol that UxPlay and
 * java-airplay also implement): RTSP control connection, pairing, FairPlay key exchange, then a
 * TCP stream of encrypted H.264 and a UDP stream of encrypted AAC-ELD.
 */
class AirPlayServer(private val config: AirPlayConfig, private val listener: AirPlayListener) {

    @Volatile
    private var serverSocket: ServerSocket? = null
    private val connections = Collections.synchronizedSet(LinkedHashSet<Connection>())
    private val lock = Any()
    private var mirroring: Connection? = null // guarded by lock
    private var playingAudio: Connection? = null // guarded by lock
    @Volatile
    private var volumeDb = 0.0

    /** The control port iPhones connect to (advertise this one). */
    val port: Int get() = serverSocket?.localPort ?: 0

    fun start(preferredPort: Int = DEFAULT_PORT): Int {
        check(serverSocket == null) { "AirPlay server already started" }
        val socket = bind(preferredPort) ?: bind(0)!!
        serverSocket = socket
        thread(name = "UvAirPlay-accept", isDaemon = true) { acceptLoop(socket) }
        AirPlayLog.i("AirPlay receiver \"${config.name}\" listening on port ${socket.localPort}")
        return socket.localPort
    }

    fun stop() {
        val socket = serverSocket ?: return
        serverSocket = null
        runCatching { socket.close() }
        disconnectAll()
    }

    /** Ends every sender's session (their phones show that mirroring stopped). */
    fun disconnectAll() {
        val all = synchronized(connections) { connections.toList() }
        all.forEach { it.close() }
    }

    private fun bind(port: Int): ServerSocket? = try {
        ServerSocket().apply {
            reuseAddress = true
            bind(InetSocketAddress(port), 16)
        }
    } catch (e: IOException) {
        if (port == 0) throw e
        AirPlayLog.i("Port $port is busy, using another one")
        null
    }

    private fun acceptLoop(socket: ServerSocket) {
        while (!socket.isClosed) {
            val client = try {
                socket.accept()
            } catch (e: IOException) {
                break
            }
            if (connections.size >= MAX_CONNECTIONS) {
                runCatching { client.close() }
                continue
            }
            val connection = Connection(client)
            connections.add(connection)
            thread(name = "UvAirPlay-control", isDaemon = true) { connection.run() }
        }
    }

    // ------------------------------------------------------------------ Control connection

    private inner class Connection(private val socket: Socket) {
        private val who = socket.inetAddress?.hostAddress ?: "?"
        private val pairing = PairingSession(config.identity)
        private val fairPlay = FairPlayHandshake()
        private var sessionKey: ByteArray? = null
        private var audioIv: ByteArray? = null
        private var clientName = "iPhone"

        @Volatile
        private var mirror: MirrorStream? = null
        @Volatile
        private var audio: AudioStream? = null
        @Volatile
        private var closed = false

        fun run() {
            try {
                socket.tcpNoDelay = true
                val input = BufferedInputStream(socket.getInputStream())
                val output = BufferedOutputStream(socket.getOutputStream())
                while (!closed) {
                    val request = Rtsp.read(input) ?: break
                    val response = try {
                        handle(request)
                    } catch (e: PairingException) {
                        AirPlayLog.i("Pairing with $who failed: ${e.message}")
                        RtspResponse(403, "Forbidden").also { it.close = true }
                    } catch (e: Exception) {
                        AirPlayLog.i("${request.method} ${request.path} from $who failed: $e")
                        RtspResponse(500, "Internal Server Error")
                    }
                    Rtsp.write(output, request, response)
                    if (response.close) break
                }
            } catch (e: IOException) {
                if (!closed) AirPlayLog.i("Connection from $who ended: ${e.message}")
            } finally {
                close()
            }
        }

        fun close() {
            if (closed) return
            closed = true
            stopMirror()
            stopAudio()
            runCatching { socket.close() }
            connections.remove(this)
        }

        private fun handle(request: RtspRequest): RtspResponse {
            val method = request.method
            val path = request.path
            return when {
                method == "GET" && path == "/info" -> info(request)
                method == "POST" && path == "/pair-setup" -> {
                    AirPlayLog.i("Pairing with $who")
                    RtspResponse().octets(pairing.setup())
                }
                method == "POST" && path == "/pair-verify" -> RtspResponse().octets(pairing.verify(request.body)).also {
                    if (pairing.verified) AirPlayLog.i("Paired with $who")
                }
                method == "POST" && path == "/fp-setup" -> {
                    val reply = fairPlay.setup(request.body)
                    if (reply == null) {
                        AirPlayLog.i("Unsupported FairPlay request (${request.body.size} bytes) from $who")
                        RtspResponse(400, "Bad Request")
                    } else {
                        RtspResponse().octets(reply)
                    }
                }
                method == "SETUP" -> setup(request)
                method == "GET_PARAMETER" -> RtspResponse().text("volume: %.6f\r\n".format(java.util.Locale.US, volumeDb))
                method == "SET_PARAMETER" -> setParameter(request)
                method == "RECORD" -> RtspResponse().also {
                    it.headers["Audio-Latency"] = "11025"
                    it.headers["Audio-Jack-Status"] = "connected; type=analog"
                }
                method == "FLUSH" -> RtspResponse()
                method == "TEARDOWN" -> teardown(request)
                method == "OPTIONS" -> RtspResponse().also {
                    it.headers["Public"] = "SETUP, RECORD, FLUSH, TEARDOWN, OPTIONS, GET_PARAMETER, SET_PARAMETER, POST, GET"
                }
                method == "POST" && (path == "/feedback" || path == "/audioMode") -> RtspResponse()
                method == "GET" && path == "/uvlink/log" -> RtspResponse().text(AirPlayLog.dump(), "text/plain; charset=utf-8")
                else -> {
                    AirPlayLog.i("Not supported: $method ${request.uri} from $who")
                    RtspResponse(404, "Not Found")
                }
            }
        }

        private fun info(request: RtspRequest): RtspResponse {
            val reply = LinkedHashMap<String, Any?>()
            val contentType = request.header("Content-Type")
            if (contentType != null && request.body.isNotEmpty()) {
                // The first /info asks only for our TXT record ("qualifier": ["txtAirPlay"]).
                val qualifier = ((runCatching { BinaryPlist.parse(request.body) }.getOrNull() as? Map<*, *>)
                    ?.get("qualifier") as? List<*>)?.firstOrNull() as? String
                when (qualifier) {
                    "txtAirPlay" -> reply["txtAirPlay"] = AirPlayTxt.wire(AirPlayTxt.airplay(config))
                    "txtRAOP" -> reply["txtRAOP"] = AirPlayTxt.wire(AirPlayTxt.raop(config))
                }
                return RtspResponse().plist(reply)
            }
            reply["deviceID"] = config.deviceId
            reply["macAddress"] = config.deviceId
            reply["pk"] = config.identity.publicKey
            reply["features"] = AirPlayTxt.FEATURES
            reply["name"] = config.name
            reply["pi"] = config.pairingId
            reply["vv"] = 2L
            reply["statusFlags"] = AirPlayTxt.STATUS_FLAGS
            reply["keepAliveLowPower"] = 1L
            reply["sourceVersion"] = AirPlayTxt.SOURCE_VERSION
            reply["keepAliveSendStatsAsBody"] = true
            reply["model"] = AirPlayTxt.MODEL
            reply["audioLatencies"] = listOf(100L, 101L).map {
                mapOf("type" to it, "inputLatencyMicros" to 0L, "audioType" to "default", "outputLatencyMicros" to false)
            }
            reply["audioFormats"] = listOf(100L, 101L).map {
                mapOf("type" to it, "audioInputFormats" to 0x3fffffcL, "audioOutputFormats" to 0x3fffffcL)
            }
            val width = config.displayWidth.toLong()
            val height = config.displayHeight.toLong()
            reply["displays"] = listOf(
                mapOf(
                    "uuid" to DISPLAY_UUID,
                    "widthPhysical" to 0L,
                    "heightPhysical" to 0L,
                    "width" to width,
                    "height" to height,
                    "widthPixels" to width,
                    "heightPixels" to height,
                    "rotation" to false,
                    "refreshRate" to 1.0 / 60.0,
                    "maxFPS" to config.maxFps.toLong(),
                    "overscanned" to false,
                    "features" to 14L
                )
            )
            return RtspResponse().plist(reply)
        }

        private fun setup(request: RtspRequest): RtspResponse {
            val body = BinaryPlist.parse(request.body) as? Map<*, *>
                ?: return RtspResponse(400, "Bad Request")
            val reply = LinkedHashMap<String, Any?>()

            val ekey = body["ekey"] as? ByteArray
            val eiv = body["eiv"] as? ByteArray
            if (ekey != null && eiv != null) {
                val fairPlayKey = fairPlay.decryptAesKey(ekey)
                sessionKey = AirPlayKeys.sessionKey(fairPlayKey, pairing.sharedSecret)
                audioIv = eiv.copyOf(16)
                clientName = (body["name"] as? String)?.takeIf { it.isNotBlank() }
                    ?: (body["model"] as? String) ?: "iPhone"
                AirPlayLog.i("Session keys from \"$clientName\" (${body["model"] ?: "?"}, $who), paired=${pairing.verified}")
            }

            val streams = body["streams"] as? List<*>
            if (streams != null) {
                val key = sessionKey ?: run {
                    AirPlayLog.i("SETUP of streams before the session keys from $who")
                    return RtspResponse(400, "Bad Request")
                }
                val replies = ArrayList<Any?>()
                for (entry in streams) {
                    val stream = entry as? Map<*, *> ?: continue
                    when ((stream["type"] as? Long)?.toInt()) {
                        STREAM_MIRROR -> {
                            val id = (stream["streamConnectionID"] as? Long) ?: 0L
                            val dataPort = startMirror(key, id.toULong().toString())
                            replies.add(mapOf("type" to STREAM_MIRROR.toLong(), "dataPort" to dataPort.toLong()))
                            reply["eventPort"] = port.toLong()
                            reply["timingPort"] = 0L
                        }
                        STREAM_AUDIO -> {
                            val compression = (stream["ct"] as? Long)?.toInt() ?: 0
                            val samplesPerFrame = (stream["spf"] as? Long)?.toInt() ?: 0
                            val iv = audioIv ?: ByteArray(16)
                            val (dataPort, controlPort) = startAudio(key, iv, compression, samplesPerFrame)
                            replies.add(
                                mapOf(
                                    "type" to STREAM_AUDIO.toLong(),
                                    "dataPort" to dataPort.toLong(),
                                    "controlPort" to controlPort.toLong()
                                )
                            )
                        }
                        else -> AirPlayLog.i("Unknown stream type ${stream["type"]} from $who")
                    }
                }
                reply["streams"] = replies
            }
            return if (reply.isEmpty()) RtspResponse() else RtspResponse().plist(reply)
        }

        private fun setParameter(request: RtspRequest): RtspResponse {
            if (request.header("Content-Type")?.contains("text/parameters") == true) {
                for (line in String(request.body, Charsets.UTF_8).split('\n')) {
                    val trimmed = line.trim()
                    if (!trimmed.startsWith("volume:", ignoreCase = true)) continue
                    val db = trimmed.substringAfter(':').trim().toDoubleOrNull() ?: continue
                    volumeDb = db
                    listener.onVolume(gainFromDecibels(db))
                }
            }
            return RtspResponse().also { it.headers["Audio-Jack-Status"] = "connected; type=analog" }
        }

        private fun teardown(request: RtspRequest): RtspResponse {
            val body = if (request.body.isEmpty()) null else runCatching { BinaryPlist.parse(request.body) }.getOrNull() as? Map<*, *>
            val streams = body?.get("streams") as? List<*>
            if (streams == null) {
                stopMirror()
                stopAudio()
            } else {
                for (entry in streams) {
                    when (((entry as? Map<*, *>)?.get("type") as? Long)?.toInt()) {
                        STREAM_MIRROR -> stopMirror()
                        STREAM_AUDIO -> stopAudio()
                    }
                }
            }
            return RtspResponse()
        }

        // -------------------------------------------------------------- Streams

        private fun startMirror(key: ByteArray, streamConnectionId: String): Int {
            stopMirror()
            val stream = MirrorStream(this, MirrorCipher(key, streamConnectionId))
            mirror = stream
            val previous = synchronized(lock) {
                val old = mirroring
                mirroring = this
                old
            }
            if (previous != null && previous !== this) {
                AirPlayLog.i("Another device took over the screen")
                previous.close()
            }
            AirPlayLog.i("\"$clientName\" started mirroring (video port ${stream.port})")
            listener.onMirrorStarted(clientName)
            stream.start()
            return stream.port
        }

        fun stopMirror() {
            val stream = synchronized(this) {
                val current = mirror ?: return
                mirror = null
                current
            }
            stream.close()
            val wasOnScreen = synchronized(lock) {
                if (mirroring === this) {
                    mirroring = null
                    true
                } else {
                    false
                }
            }
            if (wasOnScreen) {
                AirPlayLog.i("\"$clientName\" stopped mirroring")
                listener.onMirrorStopped()
            }
        }

        fun mirrorEnded(stream: MirrorStream) {
            if (mirror === stream) stopMirror()
        }

        private fun startAudio(key: ByteArray, iv: ByteArray, compression: Int, samplesPerFrame: Int): Pair<Int, Int> {
            stopAudio()
            val stream = AudioStream(this, AudioCipher(key, iv))
            audio = stream
            val previous = synchronized(lock) {
                val old = playingAudio
                playingAudio = this
                old
            }
            if (previous != null && previous !== this) previous.stopAudio()
            AirPlayLog.i("Audio from \"$clientName\": ${codecName(compression)}, $samplesPerFrame samples per frame")
            listener.onAudioStarted(compression, samplesPerFrame)
            stream.start()
            return stream.dataPort to stream.controlPort
        }

        fun stopAudio() {
            val stream = synchronized(this) {
                val current = audio ?: return
                audio = null
                current
            }
            stream.close()
            val wasPlaying = synchronized(lock) {
                if (playingAudio === this) {
                    playingAudio = null
                    true
                } else {
                    false
                }
            }
            if (wasPlaying) listener.onAudioStopped()
        }

        fun audioEnded(stream: AudioStream) {
            if (audio === stream) stopAudio()
        }

        fun isCurrentMirror(stream: MirrorStream) = mirror === stream
        fun isCurrentAudio(stream: AudioStream) = audio === stream
    }

    // ------------------------------------------------------------------ Video (TCP)

    private inner class MirrorStream(private val owner: Connection, private val cipher: MirrorCipher) {
        private val server = ServerSocket(0).apply { soTimeout = 30_000 }
        @Volatile
        private var socket: Socket? = null
        @Volatile
        private var stopped = false
        val port: Int = server.localPort

        fun start() {
            thread(name = "UvAirPlay-video", isDaemon = true) { run() }
        }

        private fun run() {
            var frames = 0L
            var undecryptable = 0L
            try {
                val connection = server.accept()
                socket = connection
                runCatching { server.close() }
                if (stopped) return
                connection.tcpNoDelay = true
                connection.receiveBufferSize = 1 shl 20
                val input = DataInputStream(BufferedInputStream(connection.getInputStream(), 256 * 1024))
                val header = ByteArray(128)
                while (!stopped) {
                    input.readFully(header)
                    val size = littleEndianInt(header, 0)
                    if (size < 0 || size > MAX_VIDEO_PACKET) throw IOException("bad video packet size $size")
                    val payload = ByteArray(size)
                    input.readFully(payload)
                    when (header[4].toInt() and 0xff) {
                        PACKET_VIDEO -> {
                            cipher.crypt(payload)
                            if (!owner.isCurrentMirror(this)) continue
                            if (lengthPrefixedToAnnexB(payload)) {
                                frames++
                                listener.onVideoFrame(payload, presentationTimeUs(header), header[5].toInt() and 0x10 != 0)
                            } else {
                                undecryptable++
                                if (undecryptable == 1L || undecryptable % 300 == 0L) {
                                    AirPlayLog.i("Video packet didn't decrypt to H.264 ($undecryptable so far)")
                                }
                            }
                        }
                        PACKET_CODEC -> {
                            val parameterSets = parseAvcConfig(payload)
                            if (parameterSets == null) {
                                AirPlayLog.i("Unreadable video format packet (${payload.size} bytes, option 0x%02x)".format(java.util.Locale.US, header[6].toInt() and 0xff))
                            } else if (owner.isCurrentMirror(this)) {
                                val width = Math.round(littleEndianFloat(header, 16))
                                val height = Math.round(littleEndianFloat(header, 20))
                                AirPlayLog.i("Video format: H.264 ${width}x$height")
                                listener.onCodecConfig(parameterSets.first, parameterSets.second)
                            }
                        }
                        // 2 = heartbeat, 5 = sender statistics: nothing to do.
                    }
                }
            } catch (e: SocketTimeoutException) {
                if (!stopped) AirPlayLog.i("The sender never opened the video connection")
            } catch (e: IOException) {
                if (!stopped) AirPlayLog.i("Video connection ended after $frames frames: ${e.message ?: e.javaClass.simpleName}")
            } finally {
                close()
                owner.mirrorEnded(this)
            }
        }

        fun close() {
            stopped = true
            runCatching { server.close() }
            runCatching { socket?.close() }
        }
    }

    // ------------------------------------------------------------------ Audio (UDP / RTP)

    private inner class AudioStream(private val owner: Connection, private val cipher: AudioCipher) {
        private val data = DatagramSocket(0).apply { receiveBufferSize = 256 * 1024 }
        private val control = DatagramSocket(0)
        @Volatile
        private var stopped = false
        val dataPort: Int = data.localPort
        val controlPort: Int = control.localPort

        fun start() {
            thread(name = "UvAirPlay-audio", isDaemon = true) { receiveAudio() }
            // Sync and retransmit packets arrive here; playback runs without them.
            thread(name = "UvAirPlay-audio-control", isDaemon = true) {
                val buffer = ByteArray(2048)
                val packet = DatagramPacket(buffer, buffer.size)
                while (!stopped) {
                    try {
                        control.receive(packet)
                    } catch (e: IOException) {
                        break
                    }
                }
            }
        }

        private fun receiveAudio() {
            val buffer = ByteArray(4096)
            val packet = DatagramPacket(buffer, buffer.size)
            var lastSequence = -1
            try {
                while (!stopped) {
                    packet.setData(buffer)
                    data.receive(packet)
                    val length = packet.length
                    if (length < 12 || (buffer[1].toInt() and 0x7f) != RTP_AUDIO) continue
                    // Each AAC-ELD frame arrives three times; play every sequence number once, in order.
                    val sequence = ((buffer[2].toInt() and 0xff) shl 8) or (buffer[3].toInt() and 0xff)
                    if (lastSequence >= 0) {
                        val ahead = (sequence - lastSequence) and 0xffff
                        if (ahead == 0 || ahead > 0x8000) continue
                    }
                    lastSequence = sequence
                    val payloadLength = length - 12
                    if (payloadLength <= 0) continue
                    if (payloadLength == 4 && buffer[12].toInt() == 0x00 && buffer[13].toInt() == 0x68 &&
                        buffer[14].toInt() == 0x34 && buffer[15].toInt() == 0x00
                    ) {
                        continue // "no data yet" marker at the start of a stream
                    }
                    val frame = buffer.copyOfRange(12, length)
                    cipher.decrypt(frame)
                    if (owner.isCurrentAudio(this)) listener.onAudioFrame(frame)
                }
            } catch (e: IOException) {
                if (!stopped) AirPlayLog.i("Audio stream ended: ${e.message}")
            } finally {
                close()
                owner.audioEnded(this)
            }
        }

        fun close() {
            stopped = true
            data.close()
            control.close()
        }
    }

    companion object {
        const val DEFAULT_PORT = 7000
        private const val MAX_CONNECTIONS = 12
        private const val MAX_VIDEO_PACKET = 32 * 1024 * 1024
        private const val STREAM_MIRROR = 110
        private const val STREAM_AUDIO = 96
        private const val PACKET_VIDEO = 0
        private const val PACKET_CODEC = 1
        private const val RTP_AUDIO = 0x60
        private const val DISPLAY_UUID = "e0ff8a27-6738-3d56-8a16-cc53aacee925"

        fun gainFromDecibels(db: Double): Float {
            if (db <= -144.0) return 0f
            return 10.0.pow(db.coerceIn(-30.0, 0.0) / 20.0).toFloat()
        }

        fun codecName(compression: Int): String = when (compression) {
            2 -> "ALAC"
            4 -> "AAC"
            8 -> "AAC-ELD"
            else -> "codec $compression"
        }

        /**
         * Mirror payloads are NAL units each prefixed by a 4-byte big-endian length; rewrite those
         * into start codes. Returns false (wrong key, damaged data) when the lengths don't add up.
         */
        internal fun lengthPrefixedToAnnexB(payload: ByteArray): Boolean {
            var pos = 0
            if (payload.size < 5) return false
            while (pos < payload.size) {
                if (pos + 4 > payload.size) return false
                val nalLength = ((payload[pos].toInt() and 0xff) shl 24) or ((payload[pos + 1].toInt() and 0xff) shl 16) or
                    ((payload[pos + 2].toInt() and 0xff) shl 8) or (payload[pos + 3].toInt() and 0xff)
                if (nalLength <= 0 || nalLength > payload.size - pos - 4) return false
                if (payload[pos + 4].toInt() and 0x80 != 0) return false // forbidden_zero_bit
                payload[pos] = 0
                payload[pos + 1] = 0
                payload[pos + 2] = 0
                payload[pos + 3] = 1
                pos += 4 + nalLength
            }
            return true
        }

        /** SPS and PPS out of an avcC record (the payload of a video-format packet). */
        internal fun parseAvcConfig(payload: ByteArray): Pair<ByteArray, ByteArray>? {
            if (payload.size < 11 || payload[0].toInt() != 1) return null
            val spsLength = ((payload[6].toInt() and 0xff) shl 8) or (payload[7].toInt() and 0xff)
            val ppsCountAt = 8 + spsLength
            if (spsLength == 0 || ppsCountAt + 3 > payload.size) return null
            val ppsLength = ((payload[ppsCountAt + 1].toInt() and 0xff) shl 8) or (payload[ppsCountAt + 2].toInt() and 0xff)
            val ppsAt = ppsCountAt + 3
            if (ppsLength == 0 || ppsAt + ppsLength > payload.size) return null
            return payload.copyOfRange(8, 8 + spsLength) to payload.copyOfRange(ppsAt, ppsAt + ppsLength)
        }

        private fun littleEndianInt(bytes: ByteArray, at: Int): Int =
            (bytes[at].toInt() and 0xff) or ((bytes[at + 1].toInt() and 0xff) shl 8) or
                ((bytes[at + 2].toInt() and 0xff) shl 16) or ((bytes[at + 3].toInt() and 0xff) shl 24)

        private fun littleEndianFloat(bytes: ByteArray, at: Int): Float = java.lang.Float.intBitsToFloat(littleEndianInt(bytes, at))

        /** The header's NTP-style timestamp (32.32 fixed point seconds) in microseconds. */
        private fun presentationTimeUs(header: ByteArray): Long {
            val low = littleEndianInt(header, 8).toLong() and 0xffffffffL
            val high = littleEndianInt(header, 12).toLong() and 0xffffffffL
            return high * 1_000_000L + ((low * 1_000_000L) ushr 32)
        }
    }
}
