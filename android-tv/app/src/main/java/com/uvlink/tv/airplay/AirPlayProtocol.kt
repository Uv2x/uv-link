package com.uvlink.tv.airplay

import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** What the receiver calls itself and shows to iPhones. */
class AirPlayConfig(
    /** Shown in the iPhone's Screen Mirroring list. */
    val name: String,
    /** A MAC-style id, e.g. "AE:12:34:56:78:9A". Keep it stable per TV. */
    val deviceId: String,
    val identity: AirPlayIdentity,
    /** A UUID string. Keep it stable per TV. */
    val pairingId: String,
    val displayWidth: Int,
    val displayHeight: Int,
    val maxFps: Int = 60
)

/** Recent AirPlay events, kept in memory for the on-screen status and for /uvlink/log. */
object AirPlayLog {
    @Volatile
    var sink: ((String) -> Unit)? = null
    private const val MAX_LINES = 400
    private val lines = ArrayDeque<String>()
    private val time = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)

    fun i(message: String) {
        val line = synchronized(lines) {
            val stamped = "${time.format(Date())} $message"
            lines.addLast(stamped)
            while (lines.size > MAX_LINES) lines.removeFirst()
            stamped
        }
        sink?.invoke(line)
    }

    fun dump(): String = synchronized(lines) { lines.joinToString("\n", postfix = "\n") }
}

/** mDNS TXT records, using the values UxPlay advertises (AirPlay 1 mirroring, legacy pairing). */
internal object AirPlayTxt {
    /** Features bit field: mirroring, audio, FairPlay, legacy pairing; no URL video or HLS. */
    const val FEATURES = 0x5A7FFEE6L
    const val FEATURES_TEXT = "0x5A7FFEE6,0x0"
    const val MODEL = "AppleTV3,2"
    const val SOURCE_VERSION = "220.68"
    const val STATUS_FLAGS = 0x44L

    fun airplay(config: AirPlayConfig): List<Pair<String, String>> = listOf(
        "deviceid" to config.deviceId,
        "features" to FEATURES_TEXT,
        "pw" to "false",
        "flags" to "0x4",
        "model" to MODEL,
        "pk" to hex(config.identity.publicKey),
        "pi" to config.pairingId,
        "srcvers" to SOURCE_VERSION,
        "vv" to "2"
    )

    fun raop(config: AirPlayConfig): List<Pair<String, String>> = listOf(
        "ch" to "2",
        "cn" to "0,1,2,3",
        "da" to "true",
        "et" to "0,3,5",
        "vv" to "2",
        "ft" to FEATURES_TEXT,
        "am" to MODEL,
        "md" to "0,1,2",
        "rhd" to "5.6.0.0",
        "pw" to "false",
        "sf" to "0x4",
        "sr" to "44100",
        "ss" to "16",
        "sv" to "false",
        "tp" to "UDP",
        "txtvers" to "1",
        "vs" to SOURCE_VERSION,
        "vn" to "65537",
        "pk" to hex(config.identity.publicKey)
    )

    /** The AirTunes service is named "<device id without colons>@<name>". */
    fun raopServiceName(config: AirPlayConfig): String = config.deviceId.replace(":", "") + "@" + config.name

    /** DNS TXT wire format: each "key=value" prefixed by its length. */
    fun wire(records: List<Pair<String, String>>): ByteArray {
        val out = ByteArrayOutputStream()
        for ((key, value) in records) {
            val entry = "$key=$value".toByteArray(Charsets.UTF_8)
            require(entry.size <= 255) { "TXT entry too long: $key" }
            out.write(entry.size)
            out.write(entry)
        }
        return out.toByteArray()
    }

    /** Lowercase hex, independent of the device locale. */
    fun hex(bytes: ByteArray): String {
        val digits = "0123456789abcdef"
        val out = StringBuilder(bytes.size * 2)
        for (b in bytes) {
            out.append(digits[(b.toInt() shr 4) and 0x0f]).append(digits[b.toInt() and 0x0f])
        }
        return out.toString()
    }
}

internal class RtspRequest(
    val method: String,
    val uri: String,
    val protocol: String,
    private val headers: Map<String, String>,
    val body: ByteArray
) {
    val path: String get() = uri.substringBefore('?')
    fun header(name: String): String? = headers[name.lowercase(Locale.US)]
}

internal class RtspResponse(var status: Int = 200, var reason: String = "OK") {
    val headers = LinkedHashMap<String, String>()
    var body: ByteArray = ByteArray(0)
    /** Close the connection after sending. */
    var close = false

    fun plist(value: Any?): RtspResponse {
        body = BinaryPlist.write(value)
        headers["Content-Type"] = "application/x-apple-binary-plist"
        return this
    }

    fun octets(value: ByteArray): RtspResponse {
        body = value
        headers["Content-Type"] = "application/octet-stream"
        return this
    }

    fun text(value: String, contentType: String = "text/parameters"): RtspResponse {
        body = value.toByteArray(Charsets.UTF_8)
        headers["Content-Type"] = contentType
        return this
    }
}

/** RTSP/1.0 (and the few HTTP/1.1 requests) that AirPlay senders use on the control connection. */
internal object Rtsp {
    private const val MAX_LINE = 8 * 1024
    private const val MAX_BODY = 4 * 1024 * 1024

    /** Next request, or null when the sender closed the connection between requests. */
    fun read(input: InputStream): RtspRequest? {
        var requestLine: String
        do {
            requestLine = readLine(input) ?: return null
        } while (requestLine.isEmpty())
        val parts = requestLine.split(' ')
        if (parts.size < 3) throw IOException("bad request line: $requestLine")

        val headers = HashMap<String, String>()
        while (true) {
            val line = readLine(input) ?: throw EOFException("connection closed inside headers")
            if (line.isEmpty()) break
            val colon = line.indexOf(':')
            if (colon > 0) headers[line.substring(0, colon).trim().lowercase(Locale.US)] = line.substring(colon + 1).trim()
        }
        val length = headers["content-length"]?.toIntOrNull() ?: 0
        if (length < 0 || length > MAX_BODY) throw IOException("bad Content-Length $length")
        val body = ByteArray(length)
        var read = 0
        while (read < length) {
            val n = input.read(body, read, length - read)
            if (n < 0) throw EOFException("connection closed inside body")
            read += n
        }
        return RtspRequest(parts[0], parts[1], parts[2], headers, body)
    }

    fun write(output: OutputStream, request: RtspRequest, response: RtspResponse) {
        val head = StringBuilder()
        val protocol = if (request.protocol.startsWith("HTTP")) request.protocol else "RTSP/1.0"
        head.append(protocol).append(' ').append(response.status).append(' ').append(response.reason).append("\r\n")
        request.header("CSeq")?.let { head.append("CSeq: ").append(it).append("\r\n") }
        head.append("Server: AirTunes/").append(AirPlayTxt.SOURCE_VERSION).append("\r\n")
        for ((name, value) in response.headers) head.append(name).append(": ").append(value).append("\r\n")
        head.append("Content-Length: ").append(response.body.size).append("\r\n\r\n")
        output.write(head.toString().toByteArray(Charsets.UTF_8))
        output.write(response.body)
        output.flush()
    }

    private fun readLine(input: InputStream): String? {
        val bytes = ByteArrayOutputStream()
        while (true) {
            val b = input.read()
            if (b < 0) {
                if (bytes.size() == 0) return null
                throw EOFException("connection closed inside a line")
            }
            if (b == '\n'.code) break
            if (bytes.size() >= MAX_LINE) throw IOException("line too long")
            bytes.write(b)
        }
        val line = bytes.toString("UTF-8")
        return if (line.endsWith("\r")) line.dropLast(1) else line
    }
}
