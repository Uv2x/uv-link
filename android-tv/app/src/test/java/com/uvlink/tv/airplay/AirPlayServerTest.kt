package com.uvlink.tv.airplay

import com.uvlink.tv.airplay.fairplay.FairPlayHandshake
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.EOFException
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.Socket
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Locale
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/** A fake iPhone runs a whole screen-mirroring session against the receiver over real sockets. */
class AirPlayServerTest {

    private class Recorder : AirPlayListener {
        val events = LinkedBlockingQueue<String>()
        val frames = LinkedBlockingQueue<ByteArray>()
        val audio = LinkedBlockingQueue<ByteArray>()
        @Volatile
        var sps: ByteArray? = null
        @Volatile
        var pps: ByteArray? = null

        override fun onMirrorStarted(client: String) { events.add("mirror:$client") }
        override fun onCodecConfig(sps: ByteArray, pps: ByteArray) {
            this.sps = sps
            this.pps = pps
            events.add("codec")
        }
        override fun onVideoFrame(annexB: ByteArray, ptsUs: Long, keyframe: Boolean) { frames.add(annexB) }
        override fun onMirrorStopped() { events.add("mirror-stopped") }
        override fun onAudioStarted(compressionType: Int, samplesPerFrame: Int) { events.add("audio:$compressionType:$samplesPerFrame") }
        override fun onAudioFrame(frame: ByteArray) { audio.add(frame) }
        override fun onAudioStopped() { events.add("audio-stopped") }
        override fun onVolume(gain: Float) { events.add("volume:%.3f".format(Locale.US, gain)) }

        fun next(): String? = events.poll(5, TimeUnit.SECONDS)
    }

    private class RtspClient(port: Int) : Closeable {
        private val socket = Socket(InetAddress.getLoopbackAddress(), port).apply { soTimeout = 10_000 }
        private val input = BufferedInputStream(socket.getInputStream())
        private val output = socket.getOutputStream()
        private var cseq = 0

        fun request(method: String, uri: String, body: ByteArray = ByteArray(0), contentType: String? = null): Pair<Int, ByteArray> {
            val head = StringBuilder("$method $uri RTSP/1.0\r\nCSeq: ${++cseq}\r\nUser-Agent: AirPlay/800.25.1\r\n")
            if (contentType != null) head.append("Content-Type: $contentType\r\n")
            head.append("Content-Length: ${body.size}\r\n\r\n")
            output.write(head.toString().toByteArray())
            output.write(body)
            output.flush()

            val status = readLine().split(' ')[1].toInt()
            var length = 0
            while (true) {
                val line = readLine()
                if (line.isEmpty()) break
                val name = line.substringBefore(':').trim()
                val value = line.substringAfter(':').trim()
                if (name.equals("Content-Length", true)) length = value.toInt()
                if (name.equals("CSeq", true)) assertEquals(cseq.toString(), value)
            }
            val reply = ByteArray(length)
            var read = 0
            while (read < length) {
                val n = input.read(reply, read, length - read)
                if (n < 0) throw EOFException()
                read += n
            }
            return status to reply
        }

        private fun readLine(): String {
            val bytes = ByteArrayOutputStream()
            while (true) {
                val b = input.read()
                if (b < 0) throw EOFException()
                if (b == '\n'.code) break
                if (b != '\r'.code) bytes.write(b)
            }
            return bytes.toString("UTF-8")
        }

        override fun close() = socket.close()
    }

    @Test
    fun mirrorsAndPlaysSoundLikeAnIphone() {
        val identity = AirPlayIdentity.generate()
        val config = AirPlayConfig("Uv Link (Test TV)", "AE:12:34:56:78:9A", identity, "5d2b2c0e-7c1a-4b51-9c8e-0f4b6b9e2a11", 1920, 1080)
        val recorder = Recorder()
        val server = AirPlayServer(config, recorder)
        val port = server.start(0)
        val plist = "application/x-apple-binary-plist"
        val octets = "application/octet-stream"
        try {
            RtspClient(port).use { rtsp ->
                // Discovery details: first only the TXT record, then everything.
                val (txtStatus, txtReply) = rtsp.request("GET", "/info", BinaryPlist.write(mapOf("qualifier" to listOf("txtAirPlay"))), plist)
                assertEquals(200, txtStatus)
                val txt = String((BinaryPlist.parse(txtReply) as Map<*, *>)["txtAirPlay"] as ByteArray, Charsets.UTF_8)
                assertTrue(txt.contains("features=0x5A7FFEE6,0x0"))
                assertTrue(txt.contains("pk=" + AirPlayTxt.hex(identity.publicKey)))
                val info = BinaryPlist.parse(rtsp.request("GET", "/info").second) as Map<*, *>
                assertArrayEquals(identity.publicKey, info["pk"] as ByteArray)
                assertEquals("Uv Link (Test TV)", info["name"])
                assertEquals(1920L, ((info["displays"] as List<*>)[0] as Map<*, *>)["width"])

                // Pairing.
                val client = JdkPairingClient()
                val (_, serverKey) = rtsp.request("POST", "/pair-setup", client.ed25519Public, octets)
                assertArrayEquals(identity.publicKey, serverKey)
                val (_, verify1) = rtsp.request("POST", "/pair-verify", client.step1(), octets)
                assertTrue("receiver's pair-verify signature", client.checkServer(verify1, serverKey))
                assertEquals(200, rtsp.request("POST", "/pair-verify", client.step2(), octets).first)

                // FairPlay, with the messages a real iPhone sent.
                assertArrayEquals(IphoneCapture.fpSetup1Reply, rtsp.request("POST", "/fp-setup", IphoneCapture.fpSetup1Request, octets).second)
                assertArrayEquals(IphoneCapture.fpSetup2Reply, rtsp.request("POST", "/fp-setup", IphoneCapture.fpSetup2Request, octets).second)

                // SETUP 1: keys.
                val eiv = ByteArray(16) { (it + 100).toByte() }
                val keys = mapOf(
                    "ekey" to IphoneCapture.ekey, "eiv" to eiv, "name" to "Test iPhone", "model" to "iPhone15,2",
                    "timingProtocol" to "NTP", "timingPort" to 50000L, "isScreenMirroringSession" to true
                )
                assertEquals(200, rtsp.request("SETUP", "rtsp://127.0.0.1/1", BinaryPlist.write(keys), plist).first)
                // What the sender encrypts with: FairPlay key hashed with the pairing secret.
                val fairPlay = FairPlayHandshake().apply {
                    setup(IphoneCapture.fpSetup1Request)
                    setup(IphoneCapture.fpSetup2Request)
                }
                val sessionKey = AirPlayKeys.sessionKey(fairPlay.decryptAesKey(IphoneCapture.ekey), client.sharedSecret)

                // SETUP 2: the video stream.
                val streamId = -3907568444900622110L
                val videoSetup = mapOf("streams" to listOf(mapOf("type" to 110L, "streamConnectionID" to streamId)))
                val videoReply = BinaryPlist.parse(rtsp.request("SETUP", "rtsp://127.0.0.1/1", BinaryPlist.write(videoSetup), plist).second) as Map<*, *>
                val dataPort = (((videoReply["streams"] as List<*>)[0] as Map<*, *>)["dataPort"] as Long).toInt()
                assertEquals("mirror:Test iPhone", recorder.next())

                val video = Socket(InetAddress.getLoopbackAddress(), dataPort)
                try {
                    val out = video.getOutputStream()
                    val sps = byteArrayOf(0x67, 0x64, 0x00, 0x28, 0xAC.toByte(), 0xD1.toByte(), 0x00, 0x78)
                    val pps = byteArrayOf(0x68, 0xEB.toByte(), 0xEF.toByte(), 0x2C)
                    val avcC = byteArrayOf(1, sps[1], sps[2], sps[3], 0xFF.toByte(), 0xE1.toByte()) + be16(sps.size) + sps +
                        byteArrayOf(1) + be16(pps.size) + pps
                    out.write(mirrorHeader(1, avcC.size, width = 1920f, height = 1080f))
                    out.write(avcC)

                    val sender = MirrorCipher(sessionKey, streamId.toULong().toString())
                    val expected = ArrayList<ByteArray>()
                    val units = listOf(
                        listOf(nal(0x06, 9), nal(0x65, 1000)), // SEI + IDR in one packet
                        listOf(nal(0x41, 17)),
                        listOf(nal(0x41, 5)),
                        listOf(nal(0x41, 33)),
                        listOf(nal(0x41, 4096))
                    )
                    for ((i, nals) in units.withIndex()) {
                        val payload = nals.fold(ByteArray(0)) { acc, n -> acc + be32(n.size) + n }
                        expected.add(nals.fold(ByteArray(0)) { acc, n -> acc + byteArrayOf(0, 0, 0, 1) + n })
                        sender.crypt(payload)
                        out.write(mirrorHeader(0, payload.size, keyframe = i == 0))
                        out.write(payload)
                        if (i == 2) out.write(mirrorHeader(2, 0)) // heartbeat in between
                    }
                    out.flush()

                    assertEquals("codec", recorder.next())
                    assertArrayEquals(sps, recorder.sps)
                    assertArrayEquals(pps, recorder.pps)
                    for (frame in expected) assertArrayEquals(frame, recorder.frames.poll(5, TimeUnit.SECONDS))

                    // SETUP 3: audio (AAC-ELD, as during screen mirroring).
                    val audioSetup = mapOf(
                        "streams" to listOf(
                            mapOf("type" to 96L, "ct" to 8L, "spf" to 480L, "audioFormat" to 0x1000000L, "controlPort" to 50001L)
                        )
                    )
                    val audioReply = BinaryPlist.parse(rtsp.request("SETUP", "rtsp://127.0.0.1/1", BinaryPlist.write(audioSetup), plist).second) as Map<*, *>
                    val audioStream = (audioReply["streams"] as List<*>)[0] as Map<*, *>
                    assertTrue((audioStream["controlPort"] as Long) > 0)
                    assertEquals("audio:8:480", recorder.next())

                    DatagramSocket().use { udp ->
                        val target = InetAddress.getLoopbackAddress()
                        val audioPort = (audioStream["dataPort"] as Long).toInt()
                        fun send(sequence: Int, payload: ByteArray) {
                            val packet = byteArrayOf(0x80.toByte(), 0x60, (sequence shr 8).toByte(), sequence.toByte(), 0, 0, 0, 0, 0, 0, 0, 0) + payload
                            udp.send(DatagramPacket(packet, packet.size, target, audioPort))
                            Thread.sleep(5)
                        }
                        send(0, byteArrayOf(0x00, 0x68, 0x34, 0x00)) // "no data yet"
                        val frames = listOf(ByteArray(37) { (it * 3).toByte() }, ByteArray(64) { (it + 9).toByte() }, ByteArray(5) { 7 })
                        val encrypted = frames.map { encryptAudio(it, sessionKey, eiv) }
                        // Every frame is sent three times: 1, 1 2, 1 2 3, 2 3, 3
                        for (sequence in listOf(1, 1, 2, 1, 2, 3, 2, 3, 3)) send(sequence, encrypted[sequence - 1])
                        for (frame in frames) assertArrayEquals(frame, recorder.audio.poll(5, TimeUnit.SECONDS))
                        assertNull("duplicates are dropped", recorder.audio.poll(300, TimeUnit.MILLISECONDS))
                    }

                    assertEquals(200, rtsp.request("SET_PARAMETER", "rtsp://127.0.0.1/1", "volume: -20.000000\r\n".toByteArray(), "text/parameters").first)
                    assertEquals("volume:0.100", recorder.next())

                    val log = String(rtsp.request("GET", "/uvlink/log").second)
                    assertTrue(log, log.contains("Paired with"))

                    val stopVideo = mapOf("streams" to listOf(mapOf("type" to 110L)))
                    assertEquals(200, rtsp.request("TEARDOWN", "rtsp://127.0.0.1/1", BinaryPlist.write(stopVideo), plist).first)
                    assertEquals("mirror-stopped", recorder.next())
                    assertEquals(200, rtsp.request("TEARDOWN", "rtsp://127.0.0.1/1").first)
                    assertEquals("audio-stopped", recorder.next())
                } finally {
                    video.close()
                }
            }
        } finally {
            server.stop()
        }
        assertNull("no further events", recorder.events.poll(300, TimeUnit.MILLISECONDS))
    }

    @Test
    fun badPairingSignatureClosesTheConnection() {
        val identity = AirPlayIdentity.generate()
        val server = AirPlayServer(AirPlayConfig("Test", "AE:00:00:00:00:01", identity, "x", 1920, 1080), Recorder())
        val port = server.start(0)
        try {
            RtspClient(port).use { rtsp ->
                val client = JdkPairingClient()
                val (_, reply) = rtsp.request("POST", "/pair-verify", client.step1(), "application/octet-stream")
                assertTrue(client.checkServer(reply, identity.publicKey))
                val forged = client.step2().also { it[20] = (it[20].toInt() xor 1).toByte() }
                assertEquals(403, rtsp.request("POST", "/pair-verify", forged, "application/octet-stream").first)
            }
        } finally {
            server.stop()
        }
    }

    private fun nal(header: Int, size: Int): ByteArray =
        ByteArray(size) { (it * 31 + size).toByte() }.also { it[0] = header.toByte() }

    private fun be16(value: Int) = byteArrayOf((value shr 8).toByte(), value.toByte())

    private fun be32(value: Int) = byteArrayOf((value shr 24).toByte(), (value shr 16).toByte(), (value shr 8).toByte(), value.toByte())

    private fun mirrorHeader(type: Int, size: Int, keyframe: Boolean = false, width: Float = 0f, height: Float = 0f): ByteArray {
        val header = ByteBuffer.allocate(128).order(ByteOrder.LITTLE_ENDIAN)
        header.putInt(0, size)
        header.put(4, type.toByte())
        if (keyframe) header.put(5, 0x10)
        if (type == 1) {
            header.put(6, 0x16)
            header.put(7, 0x01)
        }
        header.putLong(8, (12L shl 32) or 0x8000_0000L)
        header.putFloat(16, width)
        header.putFloat(20, height)
        return header.array()
    }

    private fun encryptAudio(frame: ByteArray, key: ByteArray, iv: ByteArray): ByteArray {
        val whole = frame.size / 16 * 16
        if (whole == 0) return frame.copyOf()
        val cipher = Cipher.getInstance("AES/CBC/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), IvParameterSpec(iv))
        return cipher.doFinal(frame, 0, whole) + frame.copyOfRange(whole, frame.size)
    }
}
