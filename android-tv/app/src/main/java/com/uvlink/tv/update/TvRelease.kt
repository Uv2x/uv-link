package com.uvlink.tv.update

import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * The TV app's side of GitHub Releases: find the newest UvLink-TV.apk and download it, checked
 * against the SHA-256 GitHub published for it. No Android APIs, so it is tested on the JVM.
 */
internal object TvRelease {
    const val ASSET_NAME = "UvLink-TV.apk"

    class Apk(val version: String, val url: String, val size: Long, val sha256: String, val pageUrl: String)

    class UpdateException(message: String) : IOException(message)

    /** "v1.2.3" / "1.2.3" -> [1, 2, 3]; null for anything else, including pre-releases. */
    fun parseVersion(version: String): IntArray? {
        val match = Regex("^v?(\\d{1,6})\\.(\\d{1,6})\\.(\\d{1,6})$").find(version.trim()) ?: return null
        return IntArray(3) { match.groupValues[it + 1].toInt() }
    }

    fun isNewer(candidate: String, current: String): Boolean {
        val a = parseVersion(candidate) ?: return false
        val b = parseVersion(current) ?: return false
        for (i in 0 until 3) if (a[i] != b[i]) return a[i] > b[i]
        return false
    }

    /** The TV APK of a "latest release" response, or null when there isn't a usable one. */
    fun parseLatest(json: String): Apk? {
        val release = JSONObject(json)
        if (release.optBoolean("draft") || release.optBoolean("prerelease")) return null
        val tag = release.optString("tag_name")
        val version = parseVersion(tag)?.joinToString(".") ?: return null
        val assets = release.optJSONArray("assets") ?: return null
        for (i in 0 until assets.length()) {
            val asset = assets.optJSONObject(i) ?: continue
            if (asset.optString("name") != ASSET_NAME) continue
            val digest = Regex("^sha256:([0-9a-fA-F]{64})$").find(asset.optString("digest"))?.groupValues?.get(1)
                ?: throw UpdateException("release $tag has no checksum for $ASSET_NAME")
            return Apk(
                version = version,
                url = asset.getString("browser_download_url"),
                size = asset.optLong("size"),
                sha256 = digest.lowercase(),
                pageUrl = release.optString("html_url")
            )
        }
        return null
    }

    /** The latest release's APK, or null when the repository has no release (yet). */
    fun latestApk(apiBase: String, repo: String, userAgent: String): Apk? {
        val connection = URL("$apiBase/repos/$repo/releases/latest").openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = 15_000
            connection.readTimeout = 20_000
            connection.setRequestProperty("Accept", "application/vnd.github+json")
            connection.setRequestProperty("X-GitHub-Api-Version", "2022-11-28")
            connection.setRequestProperty("User-Agent", userAgent)
            return when (val code = connection.responseCode) {
                200 -> parseLatest(connection.inputStream.bufferedReader().use { it.readText() })
                404 -> null
                403, 429 -> throw UpdateException("GitHub is limiting requests; try again later")
                else -> throw UpdateException("GitHub answered HTTP $code")
            }
        } finally {
            connection.disconnect()
        }
    }

    /**
     * Downloads [apk] to [target], following GitHub's redirect to its download host. The file is
     * kept only if its size and SHA-256 match; otherwise it is deleted and this throws.
     */
    fun download(apk: Apk, target: File, userAgent: String, onProgress: (Float) -> Unit = {}): File {
        target.parentFile?.mkdirs()
        if (target.exists() && sha256(target) == apk.sha256) return target
        val partial = File(target.path + ".partial")
        var url = URL(apk.url)
        var connection: HttpURLConnection
        var redirects = 0
        while (true) {
            connection = url.openConnection() as HttpURLConnection
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 15_000
            connection.readTimeout = 30_000
            connection.setRequestProperty("User-Agent", userAgent)
            val code = connection.responseCode
            if (code in 300..399 && redirects < 5) {
                val location = connection.getHeaderField("Location") ?: throw UpdateException("download redirect without a location")
                connection.disconnect()
                url = URL(url, location)
                redirects++
                continue
            }
            if (code != 200) {
                connection.disconnect()
                throw UpdateException("download failed (HTTP $code)")
            }
            break
        }
        val digest = MessageDigest.getInstance("SHA-256")
        var received = 0L
        try {
            connection.inputStream.use { input ->
                partial.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buffer)
                        if (n < 0) break
                        output.write(buffer, 0, n)
                        digest.update(buffer, 0, n)
                        received += n
                        if (apk.size > 0) onProgress((received.toFloat() / apk.size).coerceAtMost(1f))
                    }
                }
            }
        } catch (e: IOException) {
            partial.delete()
            throw e
        } finally {
            connection.disconnect()
        }
        if ((apk.size > 0 && received != apk.size) || hex(digest.digest()) != apk.sha256) {
            partial.delete()
            throw UpdateException("the download didn't match GitHub's checksum, so it was deleted")
        }
        if (target.exists()) target.delete()
        if (!partial.renameTo(target)) throw UpdateException("couldn't save the download")
        return target
    }

    fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buffer)
                if (n < 0) break
                digest.update(buffer, 0, n)
            }
        }
        return hex(digest.digest())
    }

    private fun hex(bytes: ByteArray): String {
        val digits = "0123456789abcdef"
        val out = StringBuilder(bytes.size * 2)
        for (b in bytes) out.append(digits[(b.toInt() shr 4) and 0x0f]).append(digits[b.toInt() and 0x0f])
        return out.toString()
    }
}
