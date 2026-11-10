package com.uvlink.tv.update

import android.annotation.TargetApi
import android.app.Activity
import android.app.PendingIntent
import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import com.uvlink.tv.BuildConfig
import java.io.File
import kotlin.concurrent.thread

/**
 * Keeps the TV app up to date from GitHub Releases: checks when the app opens (at most hourly),
 * offers the update on the start screen, downloads and verifies it, then asks Android to install
 * it. Android always shows its own "Update this app?" confirmation for sideloaded apps.
 */
class TvUpdater(private val activity: Activity, private val ui: Ui) {

    /** Called on the main thread. [text] null hides the update button. */
    interface Ui {
        fun onUpdateState(text: String?, enabled: Boolean)
    }

    private val main = Handler(Looper.getMainLooper())
    private val prefs = activity.getSharedPreferences("uvlink_update", Context.MODE_PRIVATE)
    private val userAgent = "UvLink-TV/${BuildConfig.VERSION_NAME}"
    private var available: TvRelease.Apk? = null
    private var working = false

    fun checkIfDue() {
        InstallResultReceiver.listener = { message -> main.post { onInstallResult(message) } }
        available?.let { show(it); return }
        if (working || BuildConfig.UPDATE_REPO.isEmpty()) return
        val now = System.currentTimeMillis()
        if (now - prefs.getLong(KEY_LAST_CHECK, 0) < CHECK_INTERVAL_MS) return
        working = true
        thread(name = "UvLink-update-check", isDaemon = true) {
            val result = runCatching { TvRelease.latestApk(API_BASE, BuildConfig.UPDATE_REPO, userAgent) }
            main.post {
                working = false
                prefs.edit().putLong(KEY_LAST_CHECK, now).apply()
                val apk = result.getOrNull()
                if (apk != null && TvRelease.isNewer(apk.version, BuildConfig.VERSION_NAME)) {
                    available = apk
                    show(apk)
                }
                // Failed checks stay quiet; the next start tries again after the interval.
            }
        }
    }

    fun startUpdate() {
        val apk = available ?: return
        if (working) return
        if (Build.VERSION.SDK_INT >= 26 && !activity.packageManager.canRequestPackageInstalls()) {
            askForInstallPermission()
            return
        }
        working = true
        ui.onUpdateState("Downloading Uv Link ${apk.version}…", false)
        val target = File(activity.cacheDir, "updates/UvLink-TV-${apk.version}.apk")
        thread(name = "UvLink-update-download", isDaemon = true) {
            try {
                var shown = -1
                val file = TvRelease.download(apk, target, userAgent) { progress ->
                    val percent = (progress * 100).toInt()
                    if (percent / 5 != shown / 5) {
                        shown = percent
                        main.post { ui.onUpdateState("Downloading Uv Link ${apk.version}… $percent%", false) }
                    }
                }
                // Older downloads are no longer needed.
                target.parentFile?.listFiles()?.forEach { if (it != file) it.delete() }
                main.post { install(file, apk) }
            } catch (e: Exception) {
                main.post {
                    working = false
                    ui.onUpdateState("Update failed: ${e.message}. Press to try again.", true)
                }
            }
        }
    }

    private fun install(file: File, apk: TvRelease.Apk) {
        try {
            val installer = activity.packageManager.packageInstaller
            val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
            params.setAppPackageName(activity.packageName)
            val sessionId = installer.createSession(params)
            installer.openSession(sessionId).use { session ->
                session.openWrite("UvLink-TV.apk", 0, file.length()).use { out ->
                    file.inputStream().use { it.copyTo(out) }
                    session.fsync(out)
                }
                val intent = Intent(activity, InstallResultReceiver::class.java)
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
                session.commit(PendingIntent.getBroadcast(activity, sessionId, intent, flags).intentSender)
            }
            ui.onUpdateState("Installing Uv Link ${apk.version}…", false)
        } catch (e: Exception) {
            working = false
            ui.onUpdateState("Update failed: ${e.message}. Press to try again.", true)
        }
    }

    private fun onInstallResult(failure: String?) {
        working = false
        if (failure != null) {
            ui.onUpdateState("Update failed: $failure. Press to try again.", true)
        }
        // On success Android replaces the app and restarts it; nothing to do.
    }

    /** Android 8+: the user must allow Uv Link to install apps once. Only called on API 26+. */
    @TargetApi(26)
    private fun askForInstallPermission() {
        try {
            activity.startActivity(
                Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}"))
            )
            ui.onUpdateState("Allow Uv Link to install apps, then press here again to update", true)
        } catch (e: ActivityNotFoundException) {
            ui.onUpdateState(
                "To update: Settings → Apps → Security & restrictions → Unknown sources → allow Uv Link, then press here",
                true
            )
        }
    }

    private fun show(apk: TvRelease.Apk) {
        if (!working) ui.onUpdateState("Update to Uv Link ${apk.version}", true)
    }

    private companion object {
        const val API_BASE = "https://api.github.com"
        const val KEY_LAST_CHECK = "lastCheck"
        const val CHECK_INTERVAL_MS = 60 * 60 * 1000L
    }
}

/** Receives Android's answer to an install session (declared in the manifest, not exported). */
class InstallResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val confirm = if (Build.VERSION.SDK_INT >= 33) {
                    intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    intent.getParcelableExtra(Intent.EXTRA_INTENT)
                }
                if (confirm != null) {
                    confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    try {
                        context.startActivity(confirm)
                    } catch (e: Exception) {
                        listener?.invoke("Android didn't show its install screen ($e)")
                    }
                }
            }
            PackageInstaller.STATUS_SUCCESS -> listener?.invoke(null)
            PackageInstaller.STATUS_FAILURE_ABORTED -> listener?.invoke("cancelled")
            else -> {
                val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "error $status"
                listener?.invoke(
                    if (status == PackageInstaller.STATUS_FAILURE_CONFLICT || status == PackageInstaller.STATUS_FAILURE_INCOMPATIBLE) {
                        "$message (this copy was signed differently; uninstall Uv Link once, then install the new version)"
                    } else {
                        message
                    }
                )
            }
        }
    }

    companion object {
        /** The open TvUpdater's result handler; null failure means success. */
        @Volatile
        var listener: ((String?) -> Unit)? = null
    }
}
