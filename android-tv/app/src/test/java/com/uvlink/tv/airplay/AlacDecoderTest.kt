package com.uvlink.tv.airplay

import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.security.MessageDigest

/**
 * ALAC is lossless, so decoding must give back the exact PCM that was encoded. The fixtures are
 * half a second of stereo 44.1 kHz (silence, tones and noise, different on each channel) encoded
 * by FFmpeg's ALAC encoder, compressed (level 2) and stored (level 0), in 4096-sample frames.
 */
class AlacDecoderTest {

    private fun resource(name: String): ByteArray =
        AlacDecoderTest::class.java.getResourceAsStream(name)!!.use { it.readBytes() }

    private fun decodeFixture(name: String): ByteArray {
        val packets = resource("$name.bin")
        val sizes = String(resource("$name.sizes")).lines().filter { it.isNotBlank() }.map { it.trim().trimEnd(',').toInt() }
        val decoder = AlacDecoder(frameLength = 4096)
        val pcm = ShortArray(4096 * 2)
        val out = ByteArrayOutputStream()
        var offset = 0
        for (size in sizes) {
            val samples = decoder.decode(packets.copyOfRange(offset, offset + size), pcm)
            offset += size
            for (i in 0 until samples * 2) {
                out.write(pcm[i].toInt() and 0xff)
                out.write((pcm[i].toInt() shr 8) and 0xff)
            }
        }
        assertEquals("all packet bytes used", packets.size, offset)
        return out.toByteArray()
    }

    private fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes)
        .joinToString("") { "%02x".format(it.toInt() and 0xff) }

    private val expected = String(resource("alac_352_source.sha256")).trim()

    @Test
    fun decodesCompressedFramesExactly() {
        val pcm = decodeFixture("alac_352_level2")
        assertEquals(88200, pcm.size)
        assertEquals(expected, sha256(pcm))
    }

    @Test
    fun decodesStoredFramesExactly() {
        val pcm = decodeFixture("alac_352_level0")
        assertEquals(88200, pcm.size)
        assertEquals(expected, sha256(pcm))
    }
}
