package com.uvlink.tv

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.NetworkInterface
import java.net.URL
import java.util.Collections
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/** A PC running Uv Link, reachable at [baseUrl] (e.g. http://192.168.1.20:3000). */
data class FoundPc(val name: String, val baseUrl: String)

/**
 * Finds PCs running Uv Link on the local network in two ways at once:
 *  1. mDNS / DNS-SD: the PC announces `_uvlink._tcp` (fast, works across ports).
 *  2. A scan of this device's /24 subnet on port 3000, for networks that block multicast.
 * Every hit is confirmed with GET /api/info before it is reported.
 */
class PcFinder(context: Context, private val listener: Listener) {

    interface Listener {
        /** Called on the main thread, once per PC. */
        fun onFound(pc: FoundPc)

        /** Called on the main thread when the subnet scan has finished. mDNS may still report later. */
        fun onSearchFinished()
    }

    private val main = Handler(Looper.getMainLooper())
    private val nsd = context.applicationContext.getSystemService(Context.NSD_SERVICE) as NsdManager
    private val reported = Collections.synchronizedSet(HashSet<String>())
    private val resolveQueue = ArrayDeque<NsdServiceInfo>()
    private var resolving = false
    private var discoveryListener: NsdManager.DiscoveryListener? = null
    private var pool: ExecutorService? = null

    @Volatile
    private var stopped = false

    fun start(preferredUrl: String?) {
        stopped = false
        startNsd()

        val executor = Executors.newFixedThreadPool(SCAN_THREADS)
        pool = executor

        val candidates = LinkedHashSet<String>()
        preferredUrl?.let { candidates += it }
        localIpv4()?.let { own ->
            val prefix = own.substringBeforeLast('.')
            for (i in 1..254) {
                val host = "$prefix.$i"
                if (host != own) candidates += "http://$host:$DEFAULT_PORT"
            }
        }

        if (candidates.isEmpty()) {
            main.postDelayed({ if (!stopped) listener.onSearchFinished() }, NSD_ONLY_WAIT_MS)
            return
        }
        val remaining = AtomicInteger(candidates.size)
        for (url in candidates) {
            executor.execute {
                try {
                    if (!stopped) probe(url)?.let(::report)
                } finally {
                    if (remaining.decrementAndGet() == 0) {
                        main.post { if (!stopped) listener.onSearchFinished() }
                    }
                }
            }
        }
    }

    fun stop() {
        stopped = true
        discoveryListener?.let { l ->
            try {
                nsd.stopServiceDiscovery(l)
            } catch (_: Exception) {
                // Discovery already stopped or never started.
            }
        }
        discoveryListener = null
        resolveQueue.clear()
        pool?.shutdownNow()
        pool = null
    }

    private fun report(pc: FoundPc) {
        if (reported.add(pc.baseUrl)) {
            main.post { if (!stopped) listener.onFound(pc) }
        }
    }

    private fun startNsd() {
        val l = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) {}
            override fun onDiscoveryStopped(serviceType: String) {}
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                main.post { discoveryListener = null }
            }
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
            override fun onServiceFound(info: NsdServiceInfo) {
                main.post {
                    if (stopped) return@post
                    resolveQueue.addLast(info)
                    resolveNext()
                }
            }
            override fun onServiceLost(info: NsdServiceInfo) {}
        }
        discoveryListener = l
        try {
            nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, l)
        } catch (_: Exception) {
            discoveryListener = null
        }
    }

    /** NsdManager can only resolve one service at a time on older Android versions. */
    @Suppress("DEPRECATION")
    private fun resolveNext() {
        if (resolving || stopped) return
        val next = resolveQueue.removeFirstOrNull() ?: return
        resolving = true
        nsd.resolveService(next, object : NsdManager.ResolveListener {
            override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) {
                main.post {
                    resolving = false
                    resolveNext()
                }
            }

            override fun onServiceResolved(info: NsdServiceInfo) {
                val host = info.host
                if (host is Inet4Address) {
                    val baseUrl = "http://${host.hostAddress}:${info.port}"
                    val label = info.serviceName.removePrefix("Uv Link on ")
                    pool?.execute {
                        probe(baseUrl)?.let { report(it.copy(name = label.ifBlank { it.name })) }
                    }
                }
                main.post {
                    resolving = false
                    resolveNext()
                }
            }
        })
    }

    private fun localIpv4(): String? = try {
        NetworkInterface.getNetworkInterfaces().toList()
            .filter { it.isUp && !it.isLoopback && !it.isVirtual }
            .flatMap { it.inetAddresses.toList() }
            .filterIsInstance<Inet4Address>()
            .firstOrNull { it.isSiteLocalAddress }
            ?.hostAddress
    } catch (_: Exception) {
        null
    }

    companion object {
        const val DEFAULT_PORT = 3000
        private const val SERVICE_TYPE = "_uvlink._tcp"
        private const val SCAN_THREADS = 48
        private const val NSD_ONLY_WAIT_MS = 4000L

        /** Returns the PC if [baseUrl] answers like a Uv Link server, otherwise null. Blocking. */
        fun probe(baseUrl: String): FoundPc? {
            var connection: HttpURLConnection? = null
            return try {
                connection = (URL("$baseUrl/api/info").openConnection() as HttpURLConnection).apply {
                    connectTimeout = 700
                    readTimeout = 1500
                    useCaches = false
                }
                if (connection.responseCode != 200) return null
                val body = connection.inputStream.bufferedReader().use { it.readText() }
                val json = JSONObject(body)
                if (json.optString("app") != "uvlink") return null
                val name = json.optString("name").ifBlank { baseUrl.removePrefix("http://") }
                FoundPc(name, baseUrl)
            } catch (_: Exception) {
                null
            } finally {
                connection?.disconnect()
            }
        }
    }
}
