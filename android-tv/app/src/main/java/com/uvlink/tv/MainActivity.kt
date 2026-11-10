package com.uvlink.tv

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.uvlink.tv.airplay.AirPlayReceiver
import com.uvlink.tv.update.TvUpdater

/**
 * Uv Link TV receiver.
 *
 * Finds the PC running Uv Link (see [PcFinder]), then shows its TV page (`/?mode=tv`) in a
 * fullscreen WebView. The page does the WebRTC receiving; this app adds discovery, autoplay
 * with sound, keep-screen-on and an Android TV launcher entry.
 *
 * While the app is open it is also an AirPlay target ([AirPlayReceiver]): an iPhone or iPad can
 * pick it under Screen Mirroring, and its screen covers everything else until it stops.
 */
class MainActivity : Activity(), PcFinder.Listener, AirPlayReceiver.Ui, TvUpdater.Ui {

    private val main = Handler(Looper.getMainLooper())
    private lateinit var root: FrameLayout
    private lateinit var finderView: View
    private lateinit var statusText: TextView
    private lateinit var pcList: LinearLayout
    private lateinit var addressInput: EditText
    private lateinit var airPlayHint: TextView
    private lateinit var airPlayStatus: TextView
    private lateinit var mirrorView: FrameLayout
    private lateinit var mirrorFrame: AspectFitLayout
    private lateinit var mirrorStatus: TextView
    private lateinit var airPlay: AirPlayReceiver
    private lateinit var updateButton: Button
    private lateinit var updater: TvUpdater
    private lateinit var layoutHint: TextView

    /** The PC's TV page reports that it is showing a cast (not its waiting screen). */
    private var pcCasting = false
    /** How an iPhone shares the screen with the PC cast; ◀ ▶ on the remote change it. */
    private var dualLayout = DualLayout.SIDE_BY_SIDE
    private val hideLayoutHint = Runnable { layoutHint.visibility = View.GONE }

    private var finder: PcFinder? = null
    private var webView: WebView? = null
    private var connectedUrl: String? = null
    private val foundPcs = LinkedHashMap<String, FoundPc>()

    /** Once the viewer picks something themselves, stop connecting automatically. */
    private var viewerChoosing = false

    private val retrySearch = Runnable { if (webView == null) startSearch() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        root = FrameLayout(this)
        root.setBackgroundColor(Color.BLACK)
        finderView = buildFinder()
        root.addView(finderView, FrameLayout.LayoutParams(MATCH, MATCH))
        mirrorView = buildMirrorView()
        root.addView(mirrorView, FrameLayout.LayoutParams(MATCH, MATCH))
        layoutHint = label("", 16f, Color.WHITE).apply {
            setBackgroundColor(0xCC020617.toInt())
            setPadding(dp(18), dp(10), dp(18), dp(10))
            visibility = View.GONE
        }
        root.addView(layoutHint, FrameLayout.LayoutParams(WRAP, WRAP, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL).apply {
            bottomMargin = dp(28)
        })
        root.addOnLayoutChangeListener { _, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom ->
            if (right - left != oldRight - oldLeft || bottom - top != oldBottom - oldTop) applyDualLayout()
        }
        dualLayout = runCatching { DualLayout.valueOf(prefs().getString(KEY_DUAL_LAYOUT, null) ?: "") }
            .getOrDefault(DualLayout.SIDE_BY_SIDE)
        setContentView(root)
        airPlay = AirPlayReceiver(this, this)
        updater = TvUpdater(this, this)
    }

    override fun onStart() {
        super.onStart()
        hideSystemBars()
        airPlay.start()
        updater.checkIfDue()
        if (webView == null) startSearch()
    }

    override fun onStop() {
        super.onStop()
        // Leaving the app ends the cast and any iPhone mirroring; coming back starts again.
        main.removeCallbacks(retrySearch)
        finder?.stop()
        finder = null
        disconnect()
        airPlay.stop()
        mirrorView.visibility = View.GONE
        applyDualLayout()
    }

    override fun onDestroy() {
        main.removeCallbacks(retrySearch)
        finder?.stop()
        disconnect()
        airPlay.shutdown()
        super.onDestroy()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (mirrorView.visibility == View.VISIBLE) {
            // Back during iPhone mirroring ends it and returns to what was on screen before.
            airPlay.disconnectSenders()
            mirrorView.visibility = View.GONE
            applyDualLayout()
        } else if (webView != null) {
            // Back from the cast goes to the PC list instead of closing the app.
            viewerChoosing = true
            disconnect()
            startSearch()
        } else {
            @Suppress("DEPRECATION")
            super.onBackPressed()
        }
    }

    /** ◀ ▶ switch between side by side, picture in picture and iPhone full screen. */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val bothOnScreen = mirrorView.visibility == View.VISIBLE && pcCasting && webView != null
        if (bothOnScreen && (event.keyCode == KeyEvent.KEYCODE_DPAD_LEFT || event.keyCode == KeyEvent.KEYCODE_DPAD_RIGHT)) {
            if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
                dualLayout = if (event.keyCode == KeyEvent.KEYCODE_DPAD_RIGHT) dualLayout.next() else dualLayout.previous()
                prefs().edit().putString(KEY_DUAL_LAYOUT, dualLayout.name).apply()
                applyDualLayout()
                showLayoutHint()
            }
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    // ------------------------------------------------------------ PC cast + iPhone together

    /** Places the PC cast and the iPhone for the current layout (see [DualViewLayout]). */
    private fun applyDualLayout() {
        val width = root.width
        val height = root.height
        if (width == 0 || height == 0) return
        val phoneOn = mirrorView.visibility == View.VISIBLE
        val pcOn = pcCasting && webView != null
        val placement = DualViewLayout.place(dualLayout, width, height, mirrorFrame.aspect, pcOn, phoneOn, dp(24))
        webView?.let { place(it, placement.pc) }
        val phone = placement.phone ?: return
        place(mirrorView, phone)
        // A thin frame around the picture-in-picture window.
        val pip = pcOn && dualLayout == DualLayout.PICTURE_IN_PICTURE
        val frame = if (pip) dp(3) else 0
        mirrorView.setPadding(frame, frame, frame, frame)
        mirrorView.setBackgroundColor(if (pip) SLATE_500 else Color.BLACK)
        // Remote keys go to the big picture: the iPhone when it fills the screen, else the PC page.
        if (pcOn && dualLayout != DualLayout.PHONE_FULL) webView?.requestFocus() else mirrorView.requestFocus()
    }

    private fun place(view: View, box: Box) {
        val params = view.layoutParams as? FrameLayout.LayoutParams ?: FrameLayout.LayoutParams(box.width, box.height)
        val gravity = Gravity.TOP or Gravity.START
        if (params.width == box.width && params.height == box.height && params.leftMargin == box.left &&
            params.topMargin == box.top && params.gravity == gravity
        ) {
            return
        }
        params.width = box.width
        params.height = box.height
        params.leftMargin = box.left
        params.topMargin = box.top
        params.gravity = gravity
        view.layoutParams = params
    }

    private fun showLayoutHint() {
        layoutHint.text = getString(R.string.layout_hint, dualLayout.label)
        layoutHint.visibility = View.VISIBLE
        main.removeCallbacks(hideLayoutHint)
        main.postDelayed(hideLayoutHint, LAYOUT_HINT_MS)
    }

    /**
     * The PC's TV page (served by the PC app) calls `UvLinkTV.castState("playing" | "waiting" | …)`
     * so the app knows when there's a cast for an iPhone to share the screen with.
     */
    private inner class TvPageBridge(private val owner: WebView) {
        @JavascriptInterface
        fun castState(state: String) {
            main.post {
                if (owner !== webView) return@post
                val casting = state == "playing"
                if (casting == pcCasting) return@post
                pcCasting = casting
                applyDualLayout()
                if (casting && mirrorView.visibility == View.VISIBLE) showLayoutHint()
            }
        }
    }

    // ------------------------------------------------------------ Finding the PC

    private fun startSearch() {
        main.removeCallbacks(retrySearch)
        finder?.stop()
        foundPcs.clear()
        pcList.removeAllViews()
        statusText.text = getString(R.string.searching)
        finderView.visibility = View.VISIBLE
        finder = PcFinder(this, this).also { it.start(prefs().getString(KEY_LAST_URL, null)) }
    }

    override fun onFound(pc: FoundPc) {
        if (webView != null || foundPcs.containsKey(pc.baseUrl)) return
        foundPcs[pc.baseUrl] = pc
        val button = pcButton(pc)
        pcList.addView(button)
        if (foundPcs.size == 1) button.requestFocus()
        statusText.text = getString(R.string.choose_pc)
        // The PC we used last time: connect straight away.
        if (!viewerChoosing && pc.baseUrl == prefs().getString(KEY_LAST_URL, null)) connect(pc.baseUrl)
    }

    override fun onSearchFinished() {
        if (webView != null) return
        when {
            foundPcs.isEmpty() -> {
                statusText.text = getString(R.string.nothing_found)
                main.postDelayed(retrySearch, RETRY_MS)
            }
            foundPcs.size == 1 && !viewerChoosing -> connect(foundPcs.keys.first())
        }
    }

    private fun connectManually() {
        viewerChoosing = true
        val baseUrl = normalizeAddress(addressInput.text.toString())
        if (baseUrl == null) {
            statusText.text = getString(R.string.bad_address)
            return
        }
        statusText.text = getString(R.string.checking, baseUrl)
        Thread {
            val pc = PcFinder.probe(baseUrl)
            main.post {
                if (pc != null) connect(pc.baseUrl) else statusText.text = getString(R.string.not_reachable, baseUrl)
            }
        }.start()
    }

    // ------------------------------------------------------------ Showing the cast

    @SuppressLint("SetJavaScriptEnabled")
    private fun connect(baseUrl: String) {
        main.removeCallbacks(retrySearch)
        finder?.stop()
        finder = null
        prefs().edit().putString(KEY_LAST_URL, baseUrl).apply()
        connectedUrl = baseUrl
        val pcHost = Uri.parse(baseUrl).host

        val web = WebView(this)
        web.setBackgroundColor(Color.BLACK)
        web.isFocusable = true
        web.isFocusableInTouchMode = true
        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            // Lets the stream start with sound without a button press.
            mediaPlaybackRequiresUserGesture = false
            userAgentString = "$userAgentString UvLinkTV/${BuildConfig.VERSION_NAME}"
        }
        web.webViewClient = object : WebViewClient() {
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame && view === webView) {
                    main.post { onPageFailed(error.description?.toString() ?: "error") }
                }
            }

            // Stay on the PC's Uv Link pages.
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                request.url.host != pcHost
        }
        web.webChromeClient = object : WebChromeClient() {
            // The receiver never needs camera or microphone.
            override fun onPermissionRequest(request: PermissionRequest) = request.deny()
        }
        // Only for the PC's own pages (shouldOverrideUrlLoading keeps the WebView there).
        web.addJavascriptInterface(TvPageBridge(web), "UvLinkTV")

        // Below the iPhone mirroring layer, which must stay on top.
        root.addView(web, root.indexOfChild(mirrorView), FrameLayout.LayoutParams(MATCH, MATCH))
        finderView.visibility = View.GONE
        webView = web
        web.requestFocus()
        web.loadUrl(tvPageUrl(baseUrl))
    }

    private fun tvPageUrl(baseUrl: String): String =
        Uri.parse(baseUrl).buildUpon()
            .path("/")
            .appendQueryParameter("mode", "tv")
            .appendQueryParameter("app", "android")
            .appendQueryParameter("device", if (isTv()) "Android TV" else "Android")
            .appendQueryParameter("name", Build.MODEL ?: "Android TV")
            .build()
            .toString()

    private fun onPageFailed(description: String) {
        val url = connectedUrl ?: return
        disconnect()
        startSearch()
        statusText.text = getString(R.string.connection_failed, url, description)
    }

    private fun disconnect() {
        val web = webView ?: return
        webView = null
        connectedUrl = null
        pcCasting = false
        root.removeView(web)
        applyDualLayout()
        web.stopLoading()
        web.loadUrl("about:blank")
        web.destroy()
        finderView.visibility = View.VISIBLE
    }

    // ------------------------------------------------------------ UI

    private fun buildFinder(): View {
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(dp(48), dp(32), dp(48), dp(32))
        }

        column.addView(
            ImageView(this).apply { setImageResource(R.mipmap.ic_launcher) },
            LinearLayout.LayoutParams(dp(72), dp(72))
        )
        column.addView(label(getString(R.string.app_name), 32f, Color.WHITE, bold = true).apply {
            setPadding(0, dp(12), 0, dp(6))
        })
        statusText = label(getString(R.string.searching), 18f, SLATE_300)
        column.addView(statusText)
        airPlayHint = label(getString(R.string.airplay_starting), 16f, SKY_300).apply {
            setPadding(0, dp(10), 0, 0)
        }
        column.addView(airPlayHint)

        // Shown only when GitHub has a newer version (see TvUpdater).
        updateButton = Button(this).apply {
            isAllCaps = false
            visibility = View.GONE
            setOnClickListener { updater.startUpdate() }
        }
        column.addView(updateButton, LinearLayout.LayoutParams(WRAP, WRAP).apply { topMargin = dp(12) })

        pcList = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(16), 0, dp(16))
        }
        column.addView(pcList, LinearLayout.LayoutParams(dp(460), WRAP))

        column.addView(label(getString(R.string.manual_hint), 14f, SLATE_400))
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(8), 0, 0)
        }
        addressInput = EditText(this).apply {
            hint = "192.168.1.20:3000"
            setHintTextColor(SLATE_500)
            setTextColor(Color.WHITE)
            isSingleLine = true
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            imeOptions = EditorInfo.IME_ACTION_GO
            setOnEditorActionListener { _, actionId, _ ->
                if (actionId == EditorInfo.IME_ACTION_GO) {
                    connectManually()
                    true
                } else {
                    false
                }
            }
        }
        row.addView(addressInput, LinearLayout.LayoutParams(dp(300), WRAP))
        row.addView(Button(this).apply {
            text = getString(R.string.connect)
            setOnClickListener { connectManually() }
        })
        column.addView(row)

        column.addView(
            Button(this).apply {
                text = getString(R.string.search_again)
                setOnClickListener {
                    viewerChoosing = true
                    startSearch()
                }
            },
            LinearLayout.LayoutParams(WRAP, WRAP).apply { topMargin = dp(16) }
        )

        // Latest AirPlay event, so a failed iPhone connection says why on screen.
        airPlayStatus = label("", 12f, SLATE_500).apply {
            setPadding(0, dp(20), 0, 0)
            maxLines = 2
        }
        column.addView(airPlayStatus, LinearLayout.LayoutParams(dp(640), WRAP))

        return ScrollView(this).apply {
            isFillViewport = true
            addView(column, FrameLayout.LayoutParams(MATCH, WRAP))
        }
    }

    /** Full-screen layer for iPhone mirroring: black, with the video fitted in the middle. */
    private fun buildMirrorView(): FrameLayout {
        val surfaceView = SurfaceView(this).apply {
            // Above any video surface the WebView may use; still below this window's own views.
            setZOrderMediaOverlay(true)
            holder.addCallback(object : SurfaceHolder.Callback {
                override fun surfaceCreated(holder: SurfaceHolder) = airPlay.setSurface(holder.surface)
                override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) = Unit
                override fun surfaceDestroyed(holder: SurfaceHolder) = airPlay.setSurface(null)
            })
        }
        mirrorFrame = AspectFitLayout(this).apply {
            addView(surfaceView, FrameLayout.LayoutParams(MATCH, MATCH))
        }
        // Shown until the first frame arrives, so a stuck connection says why instead of staying black.
        mirrorStatus = label("", 18f, SLATE_300).apply { setPadding(dp(48), 0, dp(48), 0) }
        return FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            visibility = View.GONE
            // Takes D-pad focus so remote presses don't reach the PC cast underneath.
            isFocusable = true
            addView(mirrorFrame, FrameLayout.LayoutParams(MATCH, MATCH))
            addView(mirrorStatus, FrameLayout.LayoutParams(MATCH, WRAP, Gravity.CENTER))
        }
    }

    // ------------------------------------------------------------ Updates

    override fun onUpdateState(text: String?, enabled: Boolean) {
        if (text == null) {
            updateButton.visibility = View.GONE
            return
        }
        updateButton.text = text
        updateButton.isEnabled = enabled
        updateButton.visibility = View.VISIBLE
    }

    // ------------------------------------------------------------ AirPlay (iPhone / iPad)

    override fun onReady(name: String) {
        airPlayHint.text = getString(R.string.airplay_hint, name)
    }

    override fun onMirrorStarted(client: String) {
        mirrorFrame.aspect = 16f / 9f
        mirrorStatus.text = getString(R.string.mirror_connecting, client)
        mirrorStatus.visibility = View.VISIBLE
        mirrorView.visibility = View.VISIBLE
        mirrorView.requestFocus()
        applyDualLayout()
        // With a PC cast on screen too, they share it: say how to change the layout.
        if (pcCasting && webView != null) showLayoutHint()
    }

    override fun onMirrorStopped() {
        mirrorView.visibility = View.GONE
        applyDualLayout()
        (webView ?: finderView).requestFocus()
    }

    override fun onVideoSize(width: Int, height: Int) {
        mirrorFrame.aspect = width.toFloat() / height
        mirrorStatus.visibility = View.GONE
        // Side by side and picture in picture follow the phone's shape (portrait / landscape).
        applyDualLayout()
    }

    override fun onStatus(line: String) {
        val event = line.substringAfter(' ')
        airPlayStatus.text = getString(R.string.airplay_status, event)
        if (mirrorView.visibility == View.VISIBLE && mirrorStatus.visibility == View.VISIBLE) {
            mirrorStatus.text = event
        }
    }

    private fun pcButton(pc: FoundPc): Button = Button(this).apply {
        text = getString(R.string.pc_entry, pc.name, Uri.parse(pc.baseUrl).host)
        isAllCaps = false
        textSize = 18f
        setOnClickListener {
            viewerChoosing = true
            connect(pc.baseUrl)
        }
        layoutParams = LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = dp(8) }
    }

    private fun label(text: String, sizeSp: Float, color: Int, bold: Boolean = false) = TextView(this).apply {
        this.text = text
        textSize = sizeSp
        setTextColor(color)
        gravity = Gravity.CENTER
        if (bold) typeface = Typeface.DEFAULT_BOLD
    }

    @Suppress("DEPRECATION")
    private fun hideSystemBars() {
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_FULLSCREEN or
                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            )
    }

    private fun isTv(): Boolean = packageManager.hasSystemFeature(PackageManager.FEATURE_LEANBACK)

    private fun prefs(): SharedPreferences = getSharedPreferences("uvlink", Context.MODE_PRIVATE)

    private fun dp(value: Int): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), resources.displayMetrics).toInt()

    companion object {
        private const val KEY_LAST_URL = "lastPcUrl"
        private const val KEY_DUAL_LAYOUT = "dualLayout"
        private const val LAYOUT_HINT_MS = 4000L
        private const val RETRY_MS = 8000L
        private const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
        private const val WRAP = ViewGroup.LayoutParams.WRAP_CONTENT
        private const val SLATE_300 = 0xFFCBD5E1.toInt()
        private const val SLATE_400 = 0xFF94A3B8.toInt()
        private const val SLATE_500 = 0xFF64748B.toInt()
        private const val SKY_300 = 0xFF7DD3FC.toInt()

        /** "192.168.1.20", "192.168.1.20:3000" or a full URL -> "http://192.168.1.20:3000". */
        fun normalizeAddress(input: String): String? {
            var text = input.trim()
            if (text.isEmpty()) return null
            if (!text.startsWith("http://") && !text.startsWith("https://")) text = "http://$text"
            val uri = Uri.parse(text)
            val host = uri.host?.takeIf { it.isNotBlank() } ?: return null
            val port = if (uri.port > 0) uri.port else PcFinder.DEFAULT_PORT
            return "${uri.scheme}://$host:$port"
        }
    }
}
