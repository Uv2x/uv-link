package com.uvlink.tv.airplay

/**
 * Apple Lossless (ALAC) decoder for AirPlay audio: what an iPhone sends when it plays to the TV
 * as a speaker (Music app, podcasts). Android has no ALAC decoder of its own.
 *
 * A Kotlin port of the decoding parts of Apple's ALAC reference code (ALACDecoder.cpp,
 * ag_dec.c, dp_dec.c, matrix_dec.c), Copyright (c) 2011 Apple Inc., Apache License 2.0
 * (https://github.com/macosforge/alac). 16-bit mono or stereo only, which is what AirPlay uses.
 */
class AlacDecoder(
    /** Samples per channel in a full frame (AirPlay: 352). */
    private val frameLength: Int = 352,
    private val channels: Int = 2,
    private val bitDepth: Int = 16,
    private val pb: Int = 40,
    private val mb: Int = 10,
    private val kb: Int = 14
) {
    class FormatException(message: String) : Exception(message)

    init {
        require(bitDepth == 16) { "only 16-bit ALAC is supported" }
        require(channels == 1 || channels == 2) { "only mono or stereo ALAC is supported" }
    }

    private val mixU = IntArray(frameLength)
    private val mixV = IntArray(frameLength)
    private val predictor = IntArray(frameLength)
    private val shiftBuffer = ShortArray(frameLength * 2)

    /** Bit position after the last dynGet / dynGet32 call. */
    private var lastBitPos = 0

    /**
     * Decodes one ALAC frame into interleaved 16-bit PCM in [out] (at least frameLength * channels).
     * Returns the number of samples per channel.
     */
    fun decode(frame: ByteArray, out: ShortArray): Int {
        // Reading looks up to 5 bytes past the current one; pad instead of bounds-checking.
        val bits = Bits(frame.copyOf(frame.size + 8), frame.size * 8)
        var channelIndex = 0
        var samples = 0
        while (bits.position < bits.limit) {
            when (bits.read(3)) {
                ID_SCE, ID_LFE -> {
                    if (channelIndex + 1 > channels) throw FormatException("more channels than configured")
                    samples = decodeSingle(bits, out, channelIndex)
                    channelIndex += 1
                }
                ID_CPE -> {
                    if (channelIndex + 2 > channels) throw FormatException("more channels than configured")
                    samples = decodePair(bits, out, channelIndex)
                    channelIndex += 2
                }
                ID_DSE -> skipDataStream(bits)
                ID_FIL -> skipFill(bits)
                ID_END -> return samples
                else -> throw FormatException("unsupported ALAC element")
            }
            if (channelIndex >= channels) return samples
        }
        return samples
    }

    private class Header(val bytesShifted: Int, val escape: Boolean, val numSamples: Int)

    private class Predictor(val mode: Int, val denShift: Int, val pbFactor: Int, val coefs: ShortArray)

    private fun readHeader(bits: Bits): Header {
        bits.read(4) // element instance tag
        if (bits.read(12) != 0) throw FormatException("bad ALAC header")
        val headerByte = bits.read(4)
        val partialFrame = headerByte shr 3
        val bytesShifted = (headerByte shr 1) and 0x3
        val escape = headerByte and 0x1
        if (bytesShifted == 3) throw FormatException("bad shift")
        var numSamples = frameLength
        if (partialFrame != 0) {
            numSamples = (bits.read(16) shl 16) or bits.read(16)
            if (numSamples > frameLength) throw FormatException("frame too long")
        }
        return Header(bytesShifted, escape != 0, numSamples)
    }

    private fun readPredictor(bits: Bits): Predictor {
        var headerByte = bits.read(8)
        val mode = headerByte shr 4
        val denShift = headerByte and 0xf
        headerByte = bits.read(8)
        val pbFactor = headerByte shr 5
        val count = headerByte and 0x1f
        val coefs = ShortArray(count) { bits.read(16).toShort() }
        return Predictor(mode, denShift, pbFactor, coefs)
    }

    private fun decompress(bits: Bits, p: Predictor, numSamples: Int, chanBits: Int, target: IntArray) {
        dynDecompress(bits, (pb * p.pbFactor) / 4, predictor, numSamples, chanBits)
        if (p.mode == 0) {
            unpcBlock(predictor, target, numSamples, p.coefs, p.coefs.size, chanBits, p.denShift)
        } else {
            // Second order: run the first-order predictor in place, then the real one.
            unpcBlock(predictor, predictor, numSamples, null, 31, chanBits, 0)
            unpcBlock(predictor, target, numSamples, p.coefs, p.coefs.size, chanBits, p.denShift)
        }
    }

    private fun decodeSingle(bits: Bits, out: ShortArray, channel: Int): Int {
        val h = readHeader(bits)
        var shifted = h.bytesShifted
        if (!h.escape) {
            val chanBits = bitDepth - shifted * 8
            bits.read(8) // mixBits (unused for one channel)
            bits.read(8) // mixRes
            val p = readPredictor(bits)
            var shiftBits: Bits? = null
            if (shifted != 0) {
                shiftBits = bits.copy()
                bits.skip(shifted * 8 * h.numSamples)
            }
            decompress(bits, p, h.numSamples, chanBits, mixU)
            if (shiftBits != null) {
                for (i in 0 until h.numSamples) shiftBuffer[i] = shiftBits.read(shifted * 8).toShort()
            }
        } else {
            val shift = 32 - bitDepth
            for (i in 0 until h.numSamples) mixU[i] = (bits.read(bitDepth) shl shift) shr shift
            shifted = 0
        }
        for (i in 0 until h.numSamples) {
            var value = mixU[i]
            if (shifted != 0) value = (value shl (shifted * 8)) or (shiftBuffer[i].toInt() and ((1 shl (shifted * 8)) - 1))
            out[i * channels + channel] = value.toShort()
        }
        return h.numSamples
    }

    private fun decodePair(bits: Bits, out: ShortArray, channel: Int): Int {
        val h = readHeader(bits)
        var mixBits = 0
        var mixRes = 0
        var shifted = h.bytesShifted
        var shiftBits: Bits? = null
        if (!h.escape) {
            val chanBits = bitDepth - shifted * 8 + 1
            mixBits = bits.read(8)
            mixRes = bits.read(8).toByte().toInt()
            val pU = readPredictor(bits)
            val pV = readPredictor(bits)
            if (shifted != 0) {
                shiftBits = bits.copy()
                bits.skip(shifted * 8 * 2 * h.numSamples)
            }
            decompress(bits, pU, h.numSamples, chanBits, mixU)
            decompress(bits, pV, h.numSamples, chanBits, mixV)
        } else {
            val shift = 32 - bitDepth
            for (i in 0 until h.numSamples) {
                mixU[i] = (bits.read(bitDepth) shl shift) shr shift
                mixV[i] = (bits.read(bitDepth) shl shift) shr shift
            }
            shifted = 0
        }
        if (shiftBits != null) {
            for (i in 0 until h.numSamples) {
                shiftBuffer[i * 2] = shiftBits.read(shifted * 8).toShort()
                shiftBuffer[i * 2 + 1] = shiftBits.read(shifted * 8).toShort()
            }
        }
        val shiftMask = if (shifted != 0) (1 shl (shifted * 8)) - 1 else 0
        for (i in 0 until h.numSamples) {
            val u = mixU[i]
            val v = mixV[i]
            var left: Int
            var right: Int
            if (mixRes != 0) {
                left = u + v - ((mixRes * v) shr mixBits)
                right = left - v
            } else {
                left = u
                right = v
            }
            if (shifted != 0) {
                left = (left shl (shifted * 8)) or (shiftBuffer[i * 2].toInt() and shiftMask)
                right = (right shl (shifted * 8)) or (shiftBuffer[i * 2 + 1].toInt() and shiftMask)
            }
            out[i * channels + channel] = left.toShort()
            out[i * channels + channel + 1] = right.toShort()
        }
        return h.numSamples
    }

    private fun skipDataStream(bits: Bits) {
        bits.read(4) // element instance tag
        val byteAlign = bits.read(1)
        var count = bits.read(8)
        if (count == 255) count += bits.read(8)
        if (byteAlign != 0) bits.alignToByte()
        bits.skip(count * 8)
    }

    private fun skipFill(bits: Bits) {
        var count = bits.read(4)
        if (count == 15) count += bits.read(8) - 1
        bits.skip(count * 8)
    }

    // ------------------------------------------------------------------ Adaptive Golomb (ag_dec.c)

    private fun dynDecompress(bits: Bits, pbLocal: Int, out: IntArray, numSamples: Int, maxSize: Int) {
        val data = bits.data
        val wb = (1 shl kb) - 1
        var bitPos = bits.position
        var meanB = mb
        var zmode = 0
        var c = 0
        while (c < numSamples) {
            if (bitPos >= bits.limit) throw FormatException("ALAC frame ended early")
            var k = lg3a(meanB ushr QB_SHIFT)
            if (k > kb) k = kb
            val m = (1 shl k) - 1
            val n = dynGet32(data, bitPos, m, k, maxSize)
            bitPos = lastBitPos

            // The lowest bit is the sign.
            val ndecode = n + zmode
            val multiplier = (-(ndecode and 1)) or 1
            out[c++] = ((ndecode + 1) ushr 1) * multiplier

            meanB = pbLocal * (n + zmode) + meanB - ((pbLocal * meanB) shr QB_SHIFT)
            if (n > N_MAX_MEAN_CLAMP) meanB = N_MEAN_CLAMP_VAL
            zmode = 0

            if ((meanB shl M_MUL_SHIFT) < QB && c < numSamples) {
                // A run of zeros follows.
                zmode = 1
                val kz = Integer.numberOfLeadingZeros(meanB) - BIT_OFF + ((meanB + M_OFF) shr M_DEN_SHIFT)
                val mz = ((1 shl kz) - 1) and wb
                val zeros = dynGet(data, bitPos, mz, kz)
                bitPos = lastBitPos
                if (c + zeros > numSamples) throw FormatException("ALAC zero run too long")
                for (j in 0 until zeros) out[c++] = 0
                if (zeros >= 65535) zmode = 0
                meanB = 0
            }
        }
        bits.position = bitPos
    }

    private fun dynGet32(data: ByteArray, bitPos: Int, m: Int, k: Int, maxBits: Int): Int {
        var pos = bitPos
        var streamLong = read32(data, pos ushr 3) shl (pos and 7)
        var result = Integer.numberOfLeadingZeros(streamLong.inv())
        if (result >= MAX_PREFIX_32) {
            result = streamBits(data, pos + MAX_PREFIX_32, maxBits)
            pos += MAX_PREFIX_32 + maxBits
        } else {
            pos += result + 1
            if (k != 1) {
                streamLong = streamLong shl (result + 1)
                val v = streamLong ushr (32 - k)
                pos += k - 1
                result *= m
                if (v >= 2) {
                    result += v - 1
                    pos += 1
                }
            }
        }
        lastBitPos = pos
        return result
    }

    private fun dynGet(data: ByteArray, bitPos: Int, m: Int, k: Int): Int {
        var pos = bitPos
        var streamLong = read32(data, pos ushr 3) shl (pos and 7)
        val pre = Integer.numberOfLeadingZeros(streamLong.inv())
        val result: Int
        if (pre >= MAX_PREFIX_16) {
            pos += MAX_PREFIX_16
            streamLong = streamLong shl MAX_PREFIX_16
            result = streamLong ushr (32 - MAX_DATATYPE_BITS_16)
            pos += MAX_DATATYPE_BITS_16
        } else {
            pos += pre + 1
            streamLong = streamLong shl (pre + 1)
            val v = if (k == 0) 0 else streamLong ushr (32 - k)
            pos += k
            var r = pre * m + v - 1
            if (v < 2) {
                r -= v - 1
                pos -= 1
            }
            result = r
        }
        lastBitPos = pos
        return result
    }

    // ------------------------------------------------------------------ Prediction (dp_dec.c)

    private fun unpcBlock(pc1: IntArray, out: IntArray, num: Int, coefs: ShortArray?, numActive: Int, chanBits: Int, denShift: Int) {
        val chanShift = 32 - chanBits
        val denHalf = if (denShift > 0) 1 shl (denShift - 1) else 0
        out[0] = pc1[0]
        if (numActive == 0) {
            if (num > 1 && pc1 !== out) System.arraycopy(pc1, 1, out, 1, num - 1)
            return
        }
        if (numActive == 31) {
            var prev = out[0]
            for (j in 1 until num) {
                val del = pc1[j] + prev
                prev = (del shl chanShift) shr chanShift
                out[j] = prev
            }
            return
        }
        val c = coefs!!
        for (j in 1..numActive) {
            if (j >= num) return
            val del = pc1[j] + out[j - 1]
            out[j] = (del shl chanShift) shr chanShift
        }
        val lim = numActive + 1
        for (j in lim until num) {
            var sum = 0
            val top = out[j - lim]
            for (k in 0 until numActive) sum += c[k] * (out[j - 1 - k] - top)
            var del = pc1[j]
            var del0 = del
            val sg = sign(del)
            del += top + ((sum + denHalf) shr denShift)
            out[j] = (del shl chanShift) shr chanShift
            if (sg > 0) {
                for (k in numActive - 1 downTo 0) {
                    val dd = top - out[j - 1 - k]
                    val sgn = sign(dd)
                    c[k] = (c[k] - sgn).toShort()
                    del0 -= (numActive - k) * ((sgn * dd) shr denShift)
                    if (del0 <= 0) break
                }
            } else if (sg < 0) {
                for (k in numActive - 1 downTo 0) {
                    val dd = top - out[j - 1 - k]
                    val sgn = sign(dd)
                    c[k] = (c[k] + sgn).toShort()
                    del0 -= (numActive - k) * ((-sgn * dd) shr denShift)
                    if (del0 >= 0) break
                }
            }
        }
    }

    private fun sign(i: Int): Int = if (i > 0) 1 else if (i < 0) -1 else 0

    // ------------------------------------------------------------------ Bits

    private class Bits(val data: ByteArray, val limit: Int, var position: Int = 0) {
        fun read(count: Int): Int {
            if (count == 0) return 0
            val value = streamBits(data, position, count)
            position += count
            return value
        }

        fun skip(count: Int) {
            position += count
        }

        fun alignToByte() {
            position = (position + 7) and 7.inv()
        }

        fun copy() = Bits(data, limit, position)
    }

    private companion object {
        const val ID_SCE = 0
        const val ID_CPE = 1
        const val ID_LFE = 3
        const val ID_DSE = 4
        const val ID_FIL = 6
        const val ID_END = 7

        const val QB_SHIFT = 9
        const val QB = 1 shl QB_SHIFT
        const val M_MUL_SHIFT = 2
        const val M_DEN_SHIFT = QB_SHIFT - M_MUL_SHIFT - 1
        const val M_OFF = 1 shl (M_DEN_SHIFT - 2)
        const val BIT_OFF = 24
        const val N_MAX_MEAN_CLAMP = 0xffff
        const val N_MEAN_CLAMP_VAL = 0xffff
        const val MAX_PREFIX_16 = 9
        const val MAX_PREFIX_32 = 9
        const val MAX_DATATYPE_BITS_16 = 16

        fun lg3a(x: Int): Int = 31 - Integer.numberOfLeadingZeros(x + 3)

        fun read32(data: ByteArray, byteOffset: Int): Int =
            ((data[byteOffset].toInt() and 0xff) shl 24) or ((data[byteOffset + 1].toInt() and 0xff) shl 16) or
                ((data[byteOffset + 2].toInt() and 0xff) shl 8) or (data[byteOffset + 3].toInt() and 0xff)

        /** [count] (1..32) bits starting at bit [bitOffset], most significant first. */
        fun streamBits(data: ByteArray, bitOffset: Int, count: Int): Int {
            val byteOffset = bitOffset ushr 3
            val inByte = bitOffset and 7
            val load1 = read32(data, byteOffset)
            val result: Int = if (count + inByte > 32) {
                val high = (load1 shl inByte) ushr (32 - count)
                val low = (data[byteOffset + 4].toInt() and 0xff) ushr (8 - (count + inByte - 32))
                high or low
            } else {
                load1 ushr (32 - count - inByte)
            }
            return if (count == 32) result else result and ((1 shl count) - 1)
        }
    }
}
