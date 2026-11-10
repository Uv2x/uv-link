package com.uvlink.tv.update

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.nio.file.Files
import java.security.MessageDigest
import java.util.Random
import kotlin.concurrent.thread

class TvReleaseTest {

    private fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes)
        .joinToString("") { "%02x".format(it.toInt() and 0xff) }

    private fun releaseJson(tag: String, digest: String?, url: String = "https://example.invalid/tv.apk") = """
        {"tag_name":"$tag","html_url":"https://github.com/Uv2x/uv-link/releases/tag/$tag","draft":false,"prerelease":false,
         "assets":[
           {"name":"UvLink-PC-Setup.exe","browser_download_url":"https://example.invalid/pc.exe","size":9,"digest":"sha256:${"a".repeat(64)}"},
           {"name":"UvLink-TV.apk","browser_download_url":"$url","size":5${if (digest != null) ",\"digest\":\"$digest\"" else ""}}
         ]}
    """.trimIndent()

    @Test
    fun comparesVersionsNumerically() {
        assertTrue(TvRelease.isNewer("1.10.0", "1.9.9"))
        assertTrue(TvRelease.isNewer("v1.2.0", "1.1.0"))
        assertFalse(TvRelease.isNewer("1.1.0", "1.1.0"))
        assertFalse(TvRelease.isNewer("1.0.9", "1.1.0"))
        assertFalse(TvRelease.isNewer("1.2.0-beta", "1.1.0"))
    }

    @Test
    fun findsTheTvApkAndItsChecksum() {
        val apk = TvRelease.parseLatest(releaseJson("v1.2.0", "sha256:${"B".repeat(64)}"))!!
        assertEquals("1.2.0", apk.version)
        assertEquals("b".repeat(64), apk.sha256)
        assertEquals(5L, apk.size)
        assertEquals("https://example.invalid/tv.apk", apk.url)
    }

    @Test(expected = TvRelease.UpdateException::class)
    fun refusesAnApkWithoutChecksum() {
        TvRelease.parseLatest(releaseJson("v1.2.0", null))
    }

    @Test
    fun ignoresPreReleasesAndOddTags() {
        assertNull(TvRelease.parseLatest("""{"tag_name":"v1.2.0","prerelease":true,"assets":[]}"""))
        assertNull(TvRelease.parseLatest("""{"tag_name":"nightly","assets":[]}"""))
    }

    @Test
    fun downloadsThroughRedirectAndVerifies() {
        val apkBytes = ByteArray(200_000).also { Random(7).nextBytes(it) }
        withServer(apkBytes) { base ->
            val dir = Files.createTempDirectory("uvlink-tv-update").toFile()
            val apk = TvRelease.Apk("1.2.0", "$base/redirect", apkBytes.size.toLong(), sha256(apkBytes), "")
            var lastProgress = 0f
            val file = TvRelease.download(apk, File(dir, "UvLink-TV-1.2.0.apk"), "test") { lastProgress = it }
            assertArrayEquals(apkBytes, file.readBytes())
            assertEquals(1f, lastProgress, 0f)
            assertFalse(File(dir, "UvLink-TV-1.2.0.apk.partial").exists())
        }
    }

    @Test
    fun deletesADownloadThatDoesNotMatch() {
        val apkBytes = "tampered apk".toByteArray()
        withServer(apkBytes) { base ->
            val dir = Files.createTempDirectory("uvlink-tv-update").toFile()
            val apk = TvRelease.Apk("1.2.0", "$base/redirect", apkBytes.size.toLong(), "0".repeat(64), "")
            try {
                TvRelease.download(apk, File(dir, "UvLink-TV-1.2.0.apk"), "test")
                fail("a download with the wrong checksum must not be kept")
            } catch (e: TvRelease.UpdateException) {
                assertTrue(e.message!!.contains("checksum"))
            }
            assertEquals(0, dir.listFiles()!!.size)
        }
    }

    @Test
    fun readsTheLatestReleaseFromTheApi() {
        withServer(ByteArray(0)) { base ->
            val apk = TvRelease.latestApk(base, "Uv2x/uv-link", "test")!!
            assertEquals("1.2.0", apk.version)
            assertNull(TvRelease.latestApk(base, "Uv2x/none", "test"))
        }
    }

    /**
     * A tiny HTTP server (the JDK's HttpServer isn't visible to Android unit tests):
     * /redirect -> /file serves [file]; /repos/Uv2x/uv-link/releases/latest serves a release.
     */
    private fun withServer(file: ByteArray, block: (String) -> Unit) {
        val server = ServerSocket(0, 16, InetAddress.getLoopbackAddress())
        val base = "http://127.0.0.1:${server.localPort}"
        val release = releaseJson("v1.2.0", "sha256:${"c".repeat(64)}").toByteArray()
        val worker = thread(isDaemon = true) {
            while (!server.isClosed) {
                val socket = try { server.accept() } catch (e: IOException) { break }
                socket.use {
                    val reader = it.getInputStream().bufferedReader()
                    val path = reader.readLine()?.split(' ')?.getOrNull(1) ?: return@use
                    while (reader.readLine()?.isNotEmpty() == true) Unit // skip headers
                    val (status, headers, body) = when (path) {
                        "/redirect" -> Triple("302 Found", "Location: $base/file\r\n", ByteArray(0))
                        "/file" -> Triple("200 OK", "", file)
                        "/repos/Uv2x/uv-link/releases/latest" -> Triple("200 OK", "Content-Type: application/json\r\n", release)
                        else -> Triple("404 Not Found", "", ByteArray(0))
                    }
                    val out = it.getOutputStream()
                    out.write("HTTP/1.1 $status\r\n${headers}Content-Length: ${body.size}\r\nConnection: close\r\n\r\n".toByteArray())
                    out.write(body)
                    out.flush()
                    // Close politely: finish sending, then wait for the client to hang up. Closing
                    // straight away can make Windows reset the connection mid-download.
                    it.shutdownOutput()
                    it.soTimeout = 5000
                    try {
                        while (it.getInputStream().read() >= 0) Unit
                    } catch (e: IOException) {
                        // client gone or timed out
                    }
                }
            }
        }
        try {
            block(base)
        } finally {
            server.close()
            worker.join(2000)
        }
    }
}
