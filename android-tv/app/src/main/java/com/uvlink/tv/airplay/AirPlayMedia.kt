package com.uvlink.tv.airplay

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.view.Surface
import java.nio.ByteBuffer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Decodes the mirrored H.264 onto a Surface with the TV's hardware decoder and shows each frame
 * as soon as it is decoded. Everything runs on one handler thread, including MediaCodec callbacks.
 */
internal class VideoDecoder(private val onVideoSize: (width: Int, height: Int) -> Unit) {

    private class Frame(val data: ByteArray, val ptsUs: Long, val keyframe: Boolean)

    private val thread = HandlerThread("UvAirPlay-decoder").apply { start() }
    private val handler = Handler(thread.looper)

    private var codec: MediaCodec? = null
    private var surface: Surface? = null
    private var sps: ByteArray? = null
    private var pps: ByteArray? = null
    private val freeInputs = ArrayDeque<Int>()
    private val pending = ArrayDeque<Frame>()
    private var shownFrames = 0L

    /** Blocks until the decoder has let go of the old surface (required in surfaceDestroyed). */
    fun setSurface(newSurface: Surface?) {
        val done = CountDownLatch(1)
        val posted = handler.post {
            try {
                if (surface !== newSurface) {
                    surface = newSurface
                    configure()
                }
            } finally {
                done.countDown()
            }
        }
        if (posted) done.await(2, TimeUnit.SECONDS)
    }

    fun codecConfig(newSps: ByteArray, newPps: ByteArray) {
        handler.post {
            if (codec != null && newSps.contentEquals(sps) && newPps.contentEquals(pps)) return@post
            sps = newSps
            pps = newPps
            pending.clear()
            configure()
        }
    }

    fun frame(data: ByteArray, ptsUs: Long, keyframe: Boolean) {
        handler.post {
            pending.addLast(Frame(data, ptsUs, keyframe))
            if (pending.size > MAX_PENDING) dropToLastKeyframe()
            feed()
        }
    }

    /** Mirroring stopped: forget the stream (the surface stays). */
    fun reset() {
        handler.post {
            release()
            sps = null
            pps = null
            pending.clear()
        }
    }

    fun shutdown() {
        handler.post {
            release()
            thread.quitSafely()
        }
    }

    private fun configure() {
        release()
        val target = surface ?: return
        val sps = sps ?: return
        val pps = pps ?: return
        if (!target.isValid) return
        var created: MediaCodec? = null
        try {
            val decoder = MediaCodec.createDecoderByType(MIME)
            created = decoder
            val format = MediaFormat.createVideoFormat(MIME, 1920, 1080).apply {
                setByteBuffer("csd-0", ByteBuffer.wrap(START_CODE + sps))
                setByteBuffer("csd-1", ByteBuffer.wrap(START_CODE + pps))
                setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 4 * 1024 * 1024)
                setInteger(MediaFormat.KEY_PRIORITY, 0) // real time
                if (Build.VERSION.SDK_INT >= 30 && decoder.codecInfo.getCapabilitiesForType(MIME)
                        .isFeatureSupported(MediaCodecInfo.CodecCapabilities.FEATURE_LowLatency)
                ) {
                    setInteger(MediaFormat.KEY_LOW_LATENCY, 1)
                }
            }
            decoder.setCallback(callback, handler)
            decoder.configure(format, target, null, 0)
            decoder.start()
            codec = decoder
            shownFrames = 0
            AirPlayLog.i("Video decoder ${decoder.name} started")
        } catch (e: Exception) {
            AirPlayLog.i("Couldn't start the video decoder: $e")
            runCatching { created?.release() }
            codec = null
        }
    }

    private fun release() {
        val current = codec ?: return
        codec = null
        freeInputs.clear()
        runCatching { current.stop() }
        runCatching { current.release() }
    }

    private fun feed() {
        val decoder = codec ?: return
        while (freeInputs.isNotEmpty() && pending.isNotEmpty()) {
            val frame = pending.removeFirst()
            val index = freeInputs.removeFirst()
            try {
                val buffer = decoder.getInputBuffer(index) ?: continue
                if (frame.data.size > buffer.capacity()) {
                    AirPlayLog.i("Skipped a ${frame.data.size}-byte video frame (decoder buffer is ${buffer.capacity()})")
                    freeInputs.addFirst(index)
                    continue
                }
                buffer.clear()
                buffer.put(frame.data)
                decoder.queueInputBuffer(index, 0, frame.data.size, frame.ptsUs, 0)
            } catch (e: IllegalStateException) {
                return
            }
        }
    }

    /** Waiting for a surface too long: keep only what can still be decoded. */
    private fun dropToLastKeyframe() {
        val lastKey = pending.indexOfLast { it.keyframe }
        if (lastKey < 0) {
            pending.clear()
        } else {
            repeat(lastKey) { pending.removeFirst() }
        }
    }

    private val callback = object : MediaCodec.Callback() {
        override fun onInputBufferAvailable(c: MediaCodec, index: Int) {
            if (c !== codec) return
            freeInputs.addLast(index)
            feed()
        }

        override fun onOutputBufferAvailable(c: MediaCodec, index: Int, info: MediaCodec.BufferInfo) {
            if (c !== codec) return
            try {
                c.releaseOutputBuffer(index, info.size > 0)
            } catch (e: IllegalStateException) {
                return
            }
            if (info.size > 0 && ++shownFrames == 1L) AirPlayLog.i("First iPhone frame on screen")
        }

        override fun onOutputFormatChanged(c: MediaCodec, format: MediaFormat) {
            if (c !== codec) return
            var width = format.getInteger(MediaFormat.KEY_WIDTH)
            var height = format.getInteger(MediaFormat.KEY_HEIGHT)
            if (format.containsKey("crop-right") && format.containsKey("crop-left")) {
                width = format.getInteger("crop-right") - format.getInteger("crop-left") + 1
            }
            if (format.containsKey("crop-bottom") && format.containsKey("crop-top")) {
                height = format.getInteger("crop-bottom") - format.getInteger("crop-top") + 1
            }
            AirPlayLog.i("Video size ${width}x$height")
            if (width > 0 && height > 0) onVideoSize(width, height)
        }

        override fun onError(c: MediaCodec, e: MediaCodec.CodecException) {
            if (c !== codec) return
            AirPlayLog.i("Video decoder error: ${e.diagnosticInfo}; restarting it")
            configure()
        }
    }

    private companion object {
        const val MIME = MediaFormat.MIMETYPE_VIDEO_AVC
        const val MAX_PENDING = 240
        val START_CODE = byteArrayOf(0, 0, 0, 1)
    }
}

/**
 * Plays the sender's audio: decodes AAC-ELD (screen mirroring) or AAC with MediaCodec and writes
 * PCM to an AudioTrack without blocking, so a backlog is dropped instead of adding delay.
 */
internal class AudioPlayer {
    private val lock = Any()
    private var codec: MediaCodec? = null
    private var track: AudioTrack? = null
    /** Speaker mode: Apple Lossless decoder and its output buffer, or plain PCM. */
    private var alac: AlacDecoder? = null
    private var pcm: ShortArray? = null
    private var rawPcm = false
    private var badFrames = 0
    private val info = MediaCodec.BufferInfo()
    @Volatile
    private var gain = 1f

    fun start(compressionType: Int, samplesPerFrame: Int) = synchronized(lock) {
        stopLocked()
        when (compressionType) {
            // Speaker mode (Music app etc.): Apple Lossless, or plain PCM. Decoded here, not by MediaCodec.
            2 -> {
                val frameLength = if (samplesPerFrame in 1..8192) samplesPerFrame else 352
                alac = AlacDecoder(frameLength = frameLength)
                pcm = ShortArray(frameLength * 2)
                AirPlayLog.i("Playing Apple Lossless audio ($frameLength samples per frame)")
                return@synchronized
            }
            1 -> {
                rawPcm = true
                AirPlayLog.i("Playing PCM audio")
                return@synchronized
            }
        }
        val format = when (compressionType) {
            8 -> MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, 44100, 2).apply {
                setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectELD)
                // AudioSpecificConfig: AAC-ELD, 44.1 kHz, stereo, 480-sample frames.
                setByteBuffer("csd-0", ByteBuffer.wrap(byteArrayOf(0xF8.toByte(), 0xE8.toByte(), 0x50, 0x00)))
            }
            4 -> MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, 44100, 2).apply {
                setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
                setByteBuffer("csd-0", ByteBuffer.wrap(byteArrayOf(0x12, 0x10)))
            }
            else -> {
                AirPlayLog.i("${AirPlayServer.codecName(compressionType)} audio isn't supported; playing video only")
                return@synchronized
            }
        }
        try {
            val decoder = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
            decoder.configure(format, null, null, 0)
            decoder.start()
            codec = decoder
            AirPlayLog.i("Audio decoder ${decoder.name} started ($samplesPerFrame samples per frame)")
        } catch (e: Exception) {
            AirPlayLog.i("Couldn't start the audio decoder: $e")
            stopLocked()
        }
    }

    fun frame(data: ByteArray) = synchronized(lock) {
        val alacDecoder = alac
        if (alacDecoder != null || rawPcm) {
            playPcm(data, alacDecoder)
            return@synchronized
        }
        val decoder = codec ?: return@synchronized
        try {
            val index = decoder.dequeueInputBuffer(10_000)
            if (index >= 0) {
                val buffer = decoder.getInputBuffer(index)
                if (buffer != null && data.size <= buffer.capacity()) {
                    buffer.clear()
                    buffer.put(data)
                    decoder.queueInputBuffer(index, 0, data.size, 0, 0)
                } else {
                    decoder.queueInputBuffer(index, 0, 0, 0, 0)
                }
            }
            drain(decoder)
        } catch (e: Exception) {
            AirPlayLog.i("Audio decoding stopped: $e")
            stopLocked()
        }
    }

    fun setVolume(value: Float) {
        synchronized(lock) {
            gain = value.coerceIn(0f, 1f)
            track?.setVolume(gain)
        }
    }

    fun stop() = synchronized(lock) { stopLocked() }

    private fun drain(decoder: MediaCodec) {
        while (true) {
            val index = decoder.dequeueOutputBuffer(info, 0)
            when {
                index >= 0 -> {
                    val output = decoder.getOutputBuffer(index)
                    if (output != null && info.size > 0) {
                        val player = track ?: createTrack(decoder.outputFormat)
                        output.position(info.offset)
                        output.limit(info.offset + info.size)
                        player?.write(output, info.size, AudioTrack.WRITE_NON_BLOCKING)
                    }
                    decoder.releaseOutputBuffer(index, false)
                }
                index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                    track?.let { runCatching { it.release() } }
                    track = null
                    createTrack(decoder.outputFormat)
                }
                index == MediaCodec.INFO_TRY_AGAIN_LATER -> return
                else -> Unit // output buffers changed: nothing to do with getOutputBuffer()
            }
        }
    }

    private fun createTrack(format: MediaFormat): AudioTrack? {
        val rate = if (format.containsKey(MediaFormat.KEY_SAMPLE_RATE)) format.getInteger(MediaFormat.KEY_SAMPLE_RATE) else 44100
        val channels = if (format.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) format.getInteger(MediaFormat.KEY_CHANNEL_COUNT) else 2
        val mask = if (channels == 1) AudioFormat.CHANNEL_OUT_MONO else AudioFormat.CHANNEL_OUT_STEREO
        return try {
            val minimum = AudioTrack.getMinBufferSize(rate, mask, AudioFormat.ENCODING_PCM_16BIT)
            val tenthOfASecond = rate * channels * 2 / 10
            val created = AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_MOVIE)
                        .build()
                )
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setSampleRate(rate)
                        .setChannelMask(mask)
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .build()
                )
                .setBufferSizeInBytes(maxOf(minimum * 2, tenthOfASecond))
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build()
            created.setVolume(gain)
            created.play()
            track = created
            created
        } catch (e: Exception) {
            AirPlayLog.i("Couldn't open audio output ($rate Hz, $channels ch): $e")
            null
        }
    }

    /** ALAC (decoded here) or big-endian 16-bit PCM, both 44.1 kHz stereo, straight to the AudioTrack. */
    private fun playPcm(data: ByteArray, decoder: AlacDecoder?) {
        val samples: ShortArray
        val count: Int
        try {
            if (decoder != null) {
                val out = pcm ?: return
                count = decoder.decode(data, out) * 2
                samples = out
            } else {
                count = data.size / 2
                samples = ShortArray(count) { i ->
                    (((data[i * 2].toInt() and 0xff) shl 8) or (data[i * 2 + 1].toInt() and 0xff)).toShort()
                }
            }
        } catch (e: Exception) {
            if (++badFrames == 1 || badFrames % 500 == 0) AirPlayLog.i("Skipped an audio frame that didn't decode ($e)")
            return
        }
        val player = track ?: createTrack(MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_RAW, 44100, 2)) ?: return
        player.write(samples, 0, count, AudioTrack.WRITE_NON_BLOCKING)
    }

    private fun stopLocked() {
        alac = null
        pcm = null
        rawPcm = false
        badFrames = 0
        codec?.let {
            runCatching { it.stop() }
            runCatching { it.release() }
        }
        codec = null
        track?.let {
            runCatching { it.pause() }
            runCatching { it.flush() }
            runCatching { it.release() }
        }
        track = null
    }
}
