package com.uvlink.tv.airplay

import com.dd.plist.BinaryPropertyListParser
import com.dd.plist.BinaryPropertyListWriter
import com.dd.plist.NSArray
import com.dd.plist.NSData
import com.dd.plist.NSDictionary
import com.dd.plist.NSNumber
import com.dd.plist.NSString
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.nio.ByteBuffer

/** Our bplist reader and writer, checked against dd-plist (a widely used Java plist library). */
class BinaryPlistTest {

    private val data = ByteArray(300) { (it * 7).toByte() }

    private fun sample(): Map<String, Any?> = linkedMapOf(
        "small" to 5L,
        "medium" to 300L,
        "large" to 70_000L,
        "huge" to 0x1_0000_0000L,
        "streamConnectionID" to -3907568444900622110L,
        "refreshRate" to 1.0 / 60.0,
        "yes" to true,
        "no" to false,
        "pk" to data,
        "ascii" to "a fairly long ascii string over fourteen chars",
        "unicode" to "Yousef’s iPhone ✓",
        "array" to (1L..20L).toList(),
        "streams" to listOf(mapOf("type" to 110L, "dataPort" to 51234L), mapOf("type" to 96L, "ct" to 8L))
    )

    @Test
    fun ourOutputReadsBackInDdPlist() {
        val parsed = BinaryPropertyListParser.parse(BinaryPlist.write(sample())) as NSDictionary
        assertEquals(5L, (parsed["small"] as NSNumber).longValue())
        assertEquals(300L, (parsed["medium"] as NSNumber).longValue())
        assertEquals(70_000L, (parsed["large"] as NSNumber).longValue())
        assertEquals(0x1_0000_0000L, (parsed["huge"] as NSNumber).longValue())
        assertEquals(-3907568444900622110L, (parsed["streamConnectionID"] as NSNumber).longValue())
        assertEquals(1.0 / 60.0, (parsed["refreshRate"] as NSNumber).doubleValue(), 0.0)
        assertEquals(true, (parsed["yes"] as NSNumber).boolValue())
        assertEquals(false, (parsed["no"] as NSNumber).boolValue())
        assertArrayEquals(data, (parsed["pk"] as NSData).bytes())
        assertEquals("a fairly long ascii string over fourteen chars", (parsed["ascii"] as NSString).content)
        assertEquals("Yousef’s iPhone ✓", (parsed["unicode"] as NSString).content)
        assertEquals(20, (parsed["array"] as NSArray).count())
        val streams = (parsed["streams"] as NSArray).array
        assertEquals(51234L, ((streams[0] as NSDictionary)["dataPort"] as NSNumber).longValue())
    }

    @Test
    fun weReadDdPlistOutput() {
        val dictionary = NSDictionary()
        dictionary["ekey"] = NSData(data)
        dictionary["name"] = NSString("Yousef’s iPhone ✓")
        dictionary["timingPort"] = NSNumber(51000)
        dictionary["isScreenMirroringSession"] = NSNumber(true)
        dictionary["streamConnectionID"] = NSNumber(-3907568444900622110L)
        dictionary["volume"] = NSNumber(-15.5)
        val streams = NSArray(1)
        val stream = NSDictionary()
        stream["type"] = NSNumber(110)
        stream["streamConnectionID"] = NSNumber(-3907568444900622110L)
        streams.setValue(0, stream)
        dictionary["streams"] = streams

        val parsed = BinaryPlist.parse(BinaryPropertyListWriter.writeToArray(dictionary)) as Map<*, *>
        assertArrayEquals(data, parsed["ekey"] as ByteArray)
        assertEquals("Yousef’s iPhone ✓", parsed["name"])
        assertEquals(51000L, parsed["timingPort"])
        assertEquals(true, parsed["isScreenMirroringSession"])
        assertEquals(-3907568444900622110L, parsed["streamConnectionID"])
        assertEquals(-15.5, parsed["volume"] as Double, 0.0)
        val first = (parsed["streams"] as List<*>)[0] as Map<*, *>
        assertEquals(110L, first["type"])
        assertEquals("14539175628808929506", (first["streamConnectionID"] as Long).toULong().toString())
    }

    @Test
    fun roundTrip() {
        val parsed = BinaryPlist.parse(BinaryPlist.write(sample())) as Map<*, *>
        val expected = sample()
        for ((key, value) in expected) {
            when (value) {
                is ByteArray -> assertArrayEquals(value, parsed[key] as ByteArray)
                else -> assertEquals(key, value, parsed[key])
            }
        }
        assertNull(BinaryPlist.parse(BinaryPlist.write(mapOf("nothing" to null))).let { (it as Map<*, *>)["nothing"] })
    }

    /** Senders may encode unsigned 64-bit IDs as 128-bit integers; we keep the low 64 bits. */
    @Test
    fun reads128BitIntegers() {
        val low = ByteBuffer.allocate(8).putLong(-3907568444900622110L).array()
        val bytes = "bplist00".toByteArray() +
            byteArrayOf(0xD1.toByte(), 1, 2) + // dict { ref1: ref2 }
            byteArrayOf(0x51, 'k'.code.toByte()) + // "k"
            byteArrayOf(0x14) + ByteArray(8) + low + // 128-bit integer
            byteArrayOf(8, 11, 13) + // offset table
            ByteArray(6) + byteArrayOf(1, 1) + ByteBuffer.allocate(24).putLong(3).putLong(0).putLong(30).array()
        val parsed = BinaryPlist.parse(bytes) as Map<*, *>
        assertEquals(-3907568444900622110L, parsed["k"])
    }
}
