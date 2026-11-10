package com.uvlink.tv.airplay

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.view.Surface
import android.view.WindowManager
import java.security.SecureRandom
import java.util.UUID
import kotlin.concurrent.thread

/**
 * Makes the TV an AirPlay screen-mirroring target for iPhones and iPads: runs [AirPlayServer],
 * advertises it with mDNS and plays what arrives. Runs while the app is open.
 */
class AirPlayReceiver(context: Context, private val ui: Ui) : AirPlayListener {

    /** Called on the main thread. */
    interface Ui {
        fun onMirrorStarted(client: String)
        fun onMirrorStopped()
        fun onVideoSize(width: Int, height: Int)
        fun onStatus(line: String)
        fun onReady(name: String)
    }

    private val appContext = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val video = VideoDecoder { width, height -> main.post { ui.onVideoSize(width, height) } }
    private val audio = AudioPlayer()

    private var server: AirPlayServer? = null
    private var advertiser: AirPlayAdvertiser? = null
    /** Bumped by every start/stop so a slow start can tell it was cancelled. */
    private var generation = 0

    fun start() {
        if (server != null) return
        val myGeneration = ++generation
        AirPlayLog.sink = { line ->
            Log.i(TAG, line)
            main.post { ui.onStatus(line) }
        }
        val name = receiverName()
        thread(name = "UvAirPlay-start", isDaemon = true) {
            try {
                val config = loadConfig(name) // derives the Ed25519 public key: a few ms of math
                val started = AirPlayServer(config, this)
                val port = started.start()
                main.post {
                    if (myGeneration != generation) {
                        started.stop()
                        return@post
                    }
                    server = started
                    advertiser = AirPlayAdvertiser(appContext).also { it.start(config, port) }
                    ui.onReady(config.name)
                }
            } catch (e: Exception) {
                AirPlayLog.i("AirPlay couldn't start: $e")
            }
        }
    }

    fun stop() {
        generation++
        advertiser?.stop()
        advertiser = null
        server?.stop()
        server = null
        video.reset()
        audio.stop()
    }

    fun shutdown() {
        stop()
        video.shutdown()
        AirPlayLog.sink = null
    }

    /** Ends the iPhone's mirroring (Back button). */
    fun disconnectSenders() {
        server?.disconnectAll()
    }

    /** Surface for the mirrored video; null when it goes away. Call from SurfaceHolder callbacks. */
    fun setSurface(surface: Surface?) = video.setSurface(surface)

    // ------------------------------------------------------------------ AirPlayListener

    override fun onMirrorStarted(client: String) {
        main.post { ui.onMirrorStarted(client) }
    }

    override fun onCodecConfig(sps: ByteArray, pps: ByteArray) = video.codecConfig(sps, pps)

    override fun onVideoFrame(annexB: ByteArray, ptsUs: Long, keyframe: Boolean) = video.frame(annexB, ptsUs, keyframe)

    override fun onMirrorStopped() {
        video.reset()
        main.post { ui.onMirrorStopped() }
    }

    override fun onAudioStarted(compressionType: Int, samplesPerFrame: Int) = audio.start(compressionType, samplesPerFrame)

    override fun onAudioFrame(frame: ByteArray) = audio.frame(frame)

    override fun onAudioStopped() = audio.stop()

    override fun onVolume(gain: Float) = audio.setVolume(gain)

    // ------------------------------------------------------------------ Identity

    private fun loadConfig(name: String): AirPlayConfig {
        val prefs = appContext.getSharedPreferences("uvlink_airplay", Context.MODE_PRIVATE)
        val random = SecureRandom()
        var seedHex = prefs.getString(KEY_SEED, null)
        if (seedHex == null || seedHex.length != 64) {
            seedHex = AirPlayTxt.hex(ByteArray(32).also { random.nextBytes(it) })
            prefs.edit().putString(KEY_SEED, seedHex).apply()
        }
        var deviceId = prefs.getString(KEY_DEVICE_ID, null)
        if (deviceId == null) {
            // A random, "locally administered" MAC-style id: Android apps can't read the real MAC.
            val bytes = ByteArray(6).also { random.nextBytes(it) }
            bytes[0] = ((bytes[0].toInt() and 0xfe) or 0x02).toByte()
            deviceId = bytes.joinToString(":") { AirPlayTxt.hex(byteArrayOf(it)).uppercase() }
            prefs.edit().putString(KEY_DEVICE_ID, deviceId).apply()
        }
        var pairingId = prefs.getString(KEY_PAIRING_ID, null)
        if (pairingId == null) {
            pairingId = UUID.randomUUID().toString()
            prefs.edit().putString(KEY_PAIRING_ID, pairingId).apply()
        }
        val (width, height) = displaySize()
        return AirPlayConfig(
            name = name,
            deviceId = deviceId,
            identity = AirPlayIdentity(hexToBytes(seedHex)),
            pairingId = pairingId,
            displayWidth = width,
            displayHeight = height
        )
    }

    private fun receiverName(): String {
        val device = runCatching { Settings.Global.getString(appContext.contentResolver, "device_name") }.getOrNull()
            ?: runCatching { Settings.Secure.getString(appContext.contentResolver, "bluetooth_name") }.getOrNull()
            ?: Build.MODEL
            ?: "TV"
        return "Uv Link (${device.trim().take(40)})"
    }

    /** Landscape size to offer iPhones, at most 1920x1080 (what the stream is decoded at). */
    private fun displaySize(): Pair<Int, Int> {
        @Suppress("DEPRECATION")
        val display = (appContext.getSystemService(Context.WINDOW_SERVICE) as WindowManager).defaultDisplay
        val mode = display.mode
        var width = maxOf(mode.physicalWidth, mode.physicalHeight)
        var height = minOf(mode.physicalWidth, mode.physicalHeight)
        if (width <= 0 || height <= 0) return 1920 to 1080
        if (width > 1920) {
            height = height * 1920 / width
            width = 1920
        }
        return width to height
    }

    private fun hexToBytes(hex: String): ByteArray = ByteArray(hex.length / 2) { i -> hex.substring(i * 2, i * 2 + 2).toInt(16).toByte() }

    private companion object {
        const val TAG = "UvAirPlay"
        const val KEY_SEED = "seed"
        const val KEY_DEVICE_ID = "deviceId"
        const val KEY_PAIRING_ID = "pairingId"
    }
}

/** Announces the receiver over mDNS, the way an Apple TV does: _airplay._tcp and _raop._tcp. */
internal class AirPlayAdvertiser(context: Context) {
    private val nsd = context.getSystemService(Context.NSD_SERVICE) as NsdManager
    private val registrations = ArrayList<NsdManager.RegistrationListener>()

    fun start(config: AirPlayConfig, port: Int) {
        register(config.name, "_airplay._tcp", port, AirPlayTxt.airplay(config))
        register(AirPlayTxt.raopServiceName(config), "_raop._tcp", port, AirPlayTxt.raop(config))
    }

    fun stop() {
        registrations.forEach { runCatching { nsd.unregisterService(it) } }
        registrations.clear()
    }

    private fun register(name: String, type: String, port: Int, txt: List<Pair<String, String>>) {
        val info = NsdServiceInfo().apply {
            serviceName = name
            serviceType = type
            setPort(port)
            txt.forEach { (key, value) -> setAttribute(key, value) }
        }
        val listener = object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(registered: NsdServiceInfo) {
                AirPlayLog.i("Visible to iPhones as \"${registered.serviceName}\" ($type, port $port)")
            }

            override fun onRegistrationFailed(failed: NsdServiceInfo, errorCode: Int) {
                AirPlayLog.i("Couldn't announce $type (error $errorCode)")
            }

            override fun onServiceUnregistered(unregistered: NsdServiceInfo) = Unit

            override fun onUnregistrationFailed(failed: NsdServiceInfo, errorCode: Int) = Unit
        }
        try {
            nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, listener)
            registrations.add(listener)
        } catch (e: Exception) {
            AirPlayLog.i("Couldn't announce $type: $e")
        }
    }
}
