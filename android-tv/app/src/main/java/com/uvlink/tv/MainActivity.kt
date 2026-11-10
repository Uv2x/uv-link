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
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
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

/**
 * Uv Link TV receiver.
 *
 * Finds the PC running Uv Link (see [PcFinder]), then shows its TV page (`/?mode=tv`) in a
 * fullscreen WebView. The page does the WebRTC receiving; this app adds discovery, autoplay
 * with sound, keep-screen-on and an Android TV launcher entry.
 */
class MainActivity : Activity(), PcFinder.Listener {

    private val main = Handler(Looper.getMainLooper())
    private lateinit var root: FrameLayout
    private lateinit var finderView: View
    private lateinit var statusText: TextView
    private lateinit var pcList: LinearLayout
    private lateinit var addressInput: EditText

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
        setContentView(root)
    }

    override fun onStart() {
        super.onStart()
        hideSystemBars()
        if (webView == null) startSearch()
    }

    override fun onStop() {
        super.onStop()
        // Leaving the app ends the cast; coming back finds the PC again.
        main.removeCallbacks(retrySearch)
        finder?.stop()
        finder = null
        disconnect()
    }

    override fun onDestroy() {
        main.removeCallbacks(retrySearch)
        finder?.stop()
        disconnect()
        super.onDestroy()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (webView != null) {
            // Back from the cast goes to the PC list instead of closing the app.
            viewerChoosing = true
            disconnect()
            startSearch()
        } else {
            @Suppress("DEPRECATION")
            super.onBackPressed()
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

        root.addView(web, FrameLayout.LayoutParams(MATCH, MATCH))
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
        root.removeView(web)
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

        return ScrollView(this).apply {
            isFillViewport = true
            addView(column, FrameLayout.LayoutParams(MATCH, WRAP))
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
        private const val RETRY_MS = 8000L
        private const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
        private const val WRAP = ViewGroup.LayoutParams.WRAP_CONTENT
        private const val SLATE_300 = 0xFFCBD5E1.toInt()
        private const val SLATE_400 = 0xFF94A3B8.toInt()
        private const val SLATE_500 = 0xFF64748B.toInt()

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
