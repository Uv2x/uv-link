package com.uvlink.tv.airplay

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer

/**
 * Apple binary property lists ("bplist00"), the body format of most AirPlay requests and replies.
 *
 * Values map to Kotlin as: dict -> Map<String, Any?>, array -> List<Any?>, string -> String,
 * integer -> Long (128-bit integers keep their low 64 bits, so unsigned 64-bit IDs survive as the
 * same bit pattern), real -> Double, bool -> Boolean, data -> ByteArray, date -> Double (seconds
 * since 2001), UID -> Long, null -> null.
 */
internal object BinaryPlist {
    private val MAGIC = "bplist00".toByteArray(Charsets.US_ASCII)

    class FormatException(message: String) : Exception(message)

    // ------------------------------------------------------------------ Reading

    fun parse(bytes: ByteArray): Any? {
        if (bytes.size < MAGIC.size + 32 || !bytes.copyOfRange(0, 8).contentEquals(MAGIC)) {
            throw FormatException("not a binary plist")
        }
        val trailer = ByteBuffer.wrap(bytes, bytes.size - 32, 32)
        trailer.position(bytes.size - 32 + 6)
        val offsetSize = trailer.get().toInt() and 0xff
        val refSize = trailer.get().toInt() and 0xff
        val objectCount = trailer.long
        val topObject = trailer.long
        val offsetTableStart = trailer.long
        if (offsetSize !in 1..8 || refSize !in 1..8 || objectCount !in 1L..1_000_000L ||
            topObject !in 0L until objectCount || offsetTableStart < 8 ||
            offsetTableStart + objectCount * offsetSize > bytes.size - 32
        ) {
            throw FormatException("bad plist trailer")
        }
        val offsets = IntArray(objectCount.toInt()) { i ->
            readUnsigned(bytes, (offsetTableStart + i * offsetSize).toInt(), offsetSize).toInt()
        }
        return Reader(bytes, offsets, refSize).read(topObject.toInt(), 0)
    }

    private class Reader(val bytes: ByteArray, val offsets: IntArray, val refSize: Int) {
        fun read(index: Int, depth: Int): Any? {
            if (index !in offsets.indices || depth > 64) throw FormatException("bad object reference")
            var pos = offsets[index]
            check(pos)
            val marker = bytes[pos].toInt() and 0xff
            val type = marker shr 4
            val info = marker and 0x0f
            pos++
            return when (type) {
                0x0 -> when (info) {
                    0x8 -> false
                    0x9 -> true
                    else -> null
                }
                0x1 -> readInt(pos, 1 shl info)
                0x2 -> when (info) {
                    2 -> java.lang.Float.intBitsToFloat(readUnsigned(bytes, pos, 4).toInt()).toDouble()
                    3 -> java.lang.Double.longBitsToDouble(readUnsigned(bytes, pos, 8))
                    else -> throw FormatException("bad real size")
                }
                0x3 -> java.lang.Double.longBitsToDouble(readUnsigned(bytes, pos, 8))
                0x4 -> {
                    val (length, start) = length(info, pos)
                    slice(start, length)
                }
                0x5 -> {
                    val (length, start) = length(info, pos)
                    String(slice(start, length), Charsets.US_ASCII)
                }
                0x6 -> {
                    val (length, start) = length(info, pos)
                    String(slice(start, length * 2), Charsets.UTF_16BE)
                }
                0x8 -> readUnsigned(bytes, pos, info + 1)
                0xA -> {
                    val (count, start) = length(info, pos)
                    List(count) { i -> read(ref(start + i * refSize), depth + 1) }
                }
                0xD -> {
                    val (count, start) = length(info, pos)
                    val map = LinkedHashMap<String, Any?>()
                    for (i in 0 until count) {
                        val key = read(ref(start + i * refSize), depth + 1) as? String
                            ?: throw FormatException("dictionary key is not a string")
                        map[key] = read(ref(start + (count + i) * refSize), depth + 1)
                    }
                    map
                }
                else -> throw FormatException("unsupported plist object 0x${marker.toString(16)}")
            }
        }

        private fun readInt(pos: Int, size: Int): Long = when (size) {
            1, 2, 4 -> readUnsigned(bytes, pos, size)
            8 -> readUnsigned(bytes, pos, 8) // signed 64-bit; same bits either way
            16 -> readUnsigned(bytes, pos + 8, 8) // low 64 bits of a 128-bit integer
            else -> throw FormatException("bad integer size $size")
        }

        private fun length(info: Int, pos: Int): Pair<Int, Int> {
            if (info != 0x0f) return info to pos
            check(pos)
            val marker = bytes[pos].toInt() and 0xff
            if (marker shr 4 != 0x1) throw FormatException("bad length marker")
            val size = 1 shl (marker and 0x0f)
            val value = readInt(pos + 1, size)
            if (value < 0 || value > bytes.size) throw FormatException("bad length")
            return value.toInt() to pos + 1 + size
        }

        private fun ref(pos: Int): Int = readUnsigned(bytes, pos, refSize).toInt()

        private fun slice(start: Int, length: Int): ByteArray {
            if (start < 0 || length < 0 || start + length > bytes.size) throw FormatException("object runs past the end")
            return bytes.copyOfRange(start, start + length)
        }

        private fun check(pos: Int) {
            if (pos < 0 || pos >= bytes.size) throw FormatException("offset out of range")
        }
    }

    private fun readUnsigned(bytes: ByteArray, pos: Int, size: Int): Long {
        if (pos < 0 || pos + size > bytes.size) throw FormatException("number runs past the end")
        var value = 0L
        for (i in 0 until size) value = (value shl 8) or (bytes[pos + i].toLong() and 0xff)
        return value
    }

    // ------------------------------------------------------------------ Writing

    fun write(root: Any?): ByteArray {
        val objects = ArrayList<Any?>()
        val refs = ArrayList<IntArray?>()
        flatten(root, objects, refs)
        val refSize = if (objects.size <= 0xff) 1 else if (objects.size <= 0xffff) 2 else 4

        val out = ByteArrayOutputStream()
        out.write(MAGIC)
        val offsets = LongArray(objects.size)
        for (i in objects.indices) {
            offsets[i] = out.size().toLong()
            writeObject(out, objects[i], refs[i], refSize)
        }
        val offsetTableStart = out.size().toLong()
        val offsetSize = bytesNeeded(offsetTableStart)
        offsets.forEach { writeUnsigned(out, it, offsetSize) }

        val trailer = ByteBuffer.allocate(32)
        trailer.position(6)
        trailer.put(offsetSize.toByte())
        trailer.put(refSize.toByte())
        trailer.putLong(objects.size.toLong())
        trailer.putLong(0)
        trailer.putLong(offsetTableStart)
        out.write(trailer.array())
        return out.toByteArray()
    }

    /** Lists objects depth-first; containers get the indexes of their children. */
    private fun flatten(value: Any?, objects: MutableList<Any?>, refs: MutableList<IntArray?>): Int {
        val index = objects.size
        objects.add(value)
        refs.add(null)
        when (value) {
            is Map<*, *> -> {
                val keys = value.keys.map { it as? String ?: throw IllegalArgumentException("plist keys must be strings") }
                val childRefs = IntArray(keys.size * 2)
                keys.forEachIndexed { i, key -> childRefs[i] = flatten(key, objects, refs) }
                keys.forEachIndexed { i, key -> childRefs[keys.size + i] = flatten(value[key], objects, refs) }
                refs[index] = childRefs
            }
            is List<*> -> refs[index] = IntArray(value.size) { i -> flatten(value[i], objects, refs) }
        }
        return index
    }

    private fun writeObject(out: ByteArrayOutputStream, value: Any?, childRefs: IntArray?, refSize: Int) {
        when (value) {
            null -> out.write(0x00)
            is Boolean -> out.write(if (value) 0x09 else 0x08)
            is Int, is Long, is Short, is Byte -> writeInt(out, (value as Number).toLong())
            is Float, is Double -> {
                out.write(0x23)
                writeUnsigned(out, java.lang.Double.doubleToLongBits((value as Number).toDouble()), 8)
            }
            is ByteArray -> {
                writeHeader(out, 0x4, value.size)
                out.write(value)
            }
            is String -> {
                if (value.all { it.code < 0x80 }) {
                    writeHeader(out, 0x5, value.length)
                    out.write(value.toByteArray(Charsets.US_ASCII))
                } else {
                    writeHeader(out, 0x6, value.length)
                    out.write(value.toByteArray(Charsets.UTF_16BE))
                }
            }
            is List<*> -> {
                writeHeader(out, 0xA, value.size)
                childRefs!!.forEach { writeUnsigned(out, it.toLong(), refSize) }
            }
            is Map<*, *> -> {
                writeHeader(out, 0xD, value.size)
                childRefs!!.forEach { writeUnsigned(out, it.toLong(), refSize) }
            }
            else -> throw IllegalArgumentException("can't write ${value::class.java.simpleName} to a plist")
        }
    }

    private fun writeHeader(out: ByteArrayOutputStream, type: Int, length: Int) {
        if (length < 15) {
            out.write((type shl 4) or length)
        } else {
            out.write((type shl 4) or 0x0f)
            writeInt(out, length.toLong())
        }
    }

    private fun writeInt(out: ByteArrayOutputStream, value: Long) {
        when {
            value in 0..0xff -> { out.write(0x10); writeUnsigned(out, value, 1) }
            value in 0..0xffff -> { out.write(0x11); writeUnsigned(out, value, 2) }
            value in 0..0xffffffffL -> { out.write(0x12); writeUnsigned(out, value, 4) }
            else -> { out.write(0x13); writeUnsigned(out, value, 8) }
        }
    }

    private fun bytesNeeded(max: Long): Int = when {
        max <= 0xff -> 1
        max <= 0xffff -> 2
        max <= 0xffffffffL -> 4
        else -> 8
    }

    private fun writeUnsigned(out: ByteArrayOutputStream, value: Long, size: Int) {
        for (i in size - 1 downTo 0) out.write(((value ushr (8 * i)) and 0xff).toInt())
    }
}
