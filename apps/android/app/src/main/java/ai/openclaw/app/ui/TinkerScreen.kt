package ai.openclaw.app.ui

import ai.openclaw.app.BuildConfig
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.jarvis.JarvisDoor
import ai.openclaw.app.jarvis.JarvisNativeBridge
import ai.openclaw.app.jarvis.JarvisScreen
import ai.openclaw.app.jarvis.isSameJarvisOrigin
import ai.openclaw.app.jarvis.jarvisDocumentStartScript
import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Rect
import android.net.Uri
import android.os.Environment
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import kotlinx.coroutines.delay

// FORK 2026-10-19 (the architect: phone app) — the Jarvis home: one long-lived WebView showing the Tinker
// page through the phone door, so the phone sees the laptop's tabs and chats. Fold/unfold and
// rotation do not reload it (MainActivity handles those config changes itself), and switching to a
// native screen only hides it.

/** Same colour as the launcher background and Tinker's dark wood, behind the system bars. */
internal val jarvisWoodDark = Color(0xFF1C140F)

private const val TINKER_PATH = "/tinker/"
private const val OFFLINE_RETRY_MS = 15_000L
private const val BACK_SCRIPT = "window.__jarvisBack ? window.__jarvisBack() : false"

internal sealed interface DoorState {
  data object Resolving : DoorState

  data class Online(
    val origin: String,
  ) : DoorState

  data class Offline(
    val detail: String,
  ) : DoorState
}

/** Mutable bits the WebView callbacks share with the composable (all touched on the main thread). */
private class TinkerWebHolder {
  @Volatile var origin: String? = null

  @Volatile var currentUrl: String? = null

  var visible: Boolean = true
  var online: Boolean = false
  var fileCallback: ValueCallback<Array<Uri>>? = null
  var pendingMicRequest: PermissionRequest? = null
  val scriptOrigins = mutableSetOf<String>()
  var loadedPairGeneration = -1
  var backCallback: OnBackPressedCallback? = null
  var bridge: JarvisNativeBridge? = null
  var bridgeOrigin: String? = null

  fun isTrustedPage(): Boolean = isSameJarvisOrigin(currentUrl, origin)
}

@Composable
internal fun TinkerScreen(
  viewModel: MainViewModel,
  visible: Boolean,
  onOpenNative: (JarvisScreen) -> Unit,
  modifier: Modifier = Modifier,
) {
  var generation by remember { mutableIntStateOf(0) }
  Box(modifier = modifier.fillMaxSize().background(jarvisWoodDark)) {
    Box(modifier = Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
      // A crashed renderer leaves a dead WebView behind; a new generation builds a fresh one.
      key(generation) {
        TinkerWebHost(
          viewModel = viewModel,
          visible = visible,
          onOpenNative = onOpenNative,
          onRendererGone = { generation += 1 },
        )
      }
    }
  }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun TinkerWebHost(
  viewModel: MainViewModel,
  visible: Boolean,
  onOpenNative: (JarvisScreen) -> Unit,
  onRendererGone: () -> Unit,
) {
  val context = LocalContext.current
  val holder = remember { TinkerWebHolder() }
  val doorState = remember { mutableStateOf<DoorState>(DoorState.Resolving) }
  var retryKey by remember { mutableIntStateOf(0) }
  var pageShown by remember { mutableStateOf(false) }
  val pairGeneration by viewModel.jarvisPairGeneration.collectAsState()
  val candidates by viewModel.jarvisDoorCandidates.collectAsState()

  val fileChooser =
    rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
      val callback = holder.fileCallback ?: return@rememberLauncherForActivityResult
      holder.fileCallback = null
      callback.onReceiveValue(fileChooserResult(result.resultCode, result.data))
    }
  val micPermission =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      val request = holder.pendingMicRequest ?: return@rememberLauncherForActivityResult
      holder.pendingMicRequest = null
      if (granted) request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) else request.deny()
    }

  val webView =
    remember {
      createTinkerWebView(
        context = context,
        holder = holder,
        onOpenNative = onOpenNative,
        onShowFileChooser = { intent ->
          try {
            fileChooser.launch(intent)
            true
          } catch (_: ActivityNotFoundException) {
            false
          }
        },
        onRequestMic = { micPermission.launch(Manifest.permission.RECORD_AUDIO) },
        onMainFrameError = { description ->
          doorState.value = DoorState.Offline(description)
        },
        onPageShown = { pageShown = true },
        onRendererGone = onRendererGone,
      )
    }

  DisposableEffect(webView) {
    onDispose {
      holder.fileCallback?.onReceiveValue(null)
      holder.fileCallback = null
      holder.pendingMicRequest?.deny()
      holder.pendingMicRequest = null
      holder.bridge?.close()
      (webView.parent as? ViewGroup)?.removeView(webView)
      webView.stopLoading()
      webView.destroy()
    }
  }

  // Battery (the architect 2026-10-20): the foreground service keeps the process alive, so without this
  // the whole Tinker page (20 s timers, socket, animations) kept running with the screen off.
  // The page re-syncs its tabs on visibility/focus, so a resume catches up on its own.
  val lifecycleOwner = androidx.lifecycle.compose.LocalLifecycleOwner.current
  DisposableEffect(lifecycleOwner, webView) {
    val observer =
      androidx.lifecycle.LifecycleEventObserver { _, event ->
        when (event) {
          androidx.lifecycle.Lifecycle.Event.ON_START -> {
            webView.resumeTimers()
            webView.onResume()
          }
          androidx.lifecycle.Lifecycle.Event.ON_STOP -> {
            webView.onPause()
            webView.pauseTimers()
          }
          else -> Unit
        }
      }
    lifecycleOwner.lifecycle.addObserver(observer)
    onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
  }

  // Find the door, hand the WebView the device cookie, load Tinker. Runs again on Retry, after a
  // new pairing or an edit of the door list, and, while offline, every 15 s on its own.
  LaunchedEffect(retryKey, pairGeneration, candidates) {
    doorState.value = DoorState.Resolving
    val token = viewModel.jarvisDeviceToken()
    if (token == null) {
      doorState.value = DoorState.Offline("This phone is not paired with a door yet.")
      return@LaunchedEffect
    }
    val origin = viewModel.resolveJarvisDoor()
    if (origin == null) {
      val tried = viewModel.jarvisDoorCandidates.value.joinToString(", ")
      doorState.value = DoorState.Offline("No door answered ($tried). Is Tailscale on?")
      return@LaunchedEffect
    }
    JarvisDoor.installDeviceCookie(origin, token)
    holder.origin = origin
    installDocumentStartScript(webView, holder, origin)
    installNativeBridge(webView, holder, origin)
    doorState.value = DoorState.Online(origin)
    val newPairing = holder.loadedPairGeneration != pairGeneration
    if (retryKey > 0 || newPairing || !isSameJarvisOrigin(webView.url, origin)) {
      holder.loadedPairGeneration = pairGeneration
      // Set before loading: page scripts can call JarvisNative before onPageStarted arrives.
      holder.currentUrl = "$origin$TINKER_PATH"
      webView.loadUrl("$origin$TINKER_PATH")
    }
  }
  val state = doorState.value
  LaunchedEffect(state) {
    if (state is DoorState.Offline) {
      delay(OFFLINE_RETRY_MS)
      retryKey += 1
    }
  }

  // Back: Tinker first (closes a drawer or the tab list), then WebView history, then background.
  val dispatcher = LocalOnBackPressedDispatcherOwner.current?.onBackPressedDispatcher
  DisposableEffect(dispatcher, webView) {
    val callback =
      object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() {
          webView.evaluateJavascript(BACK_SCRIPT) { result ->
            if (result == "true") return@evaluateJavascript
            if (webView.canGoBack()) {
              webView.goBack()
              return@evaluateJavascript
            }
            // Nothing left to go back to: leave the app the way Android 12+ leaves a root launcher
            // activity, to the background with this page still loaded, not finished.
            val activity = context as? Activity
            if (activity != null) {
              activity.moveTaskToBack(true)
              return@evaluateJavascript
            }
            isEnabled = false
            dispatcher?.onBackPressed()
            isEnabled = holder.visible && holder.online
          }
        }
      }
    dispatcher?.addCallback(callback)
    holder.backCallback = callback
    onDispose {
      callback.remove()
      holder.backCallback = null
    }
  }
  SideEffect {
    holder.visible = visible
    holder.online = state is DoorState.Online
    holder.backCallback?.isEnabled = visible && state is DoorState.Online
  }

  Box(modifier = Modifier.fillMaxSize()) {
    AndroidView(
      modifier = Modifier.fillMaxSize(),
      factory = {
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView
      },
      update = { view ->
        view.visibility = if (visible && state !is DoorState.Offline) View.VISIBLE else View.INVISIBLE
      },
    )

    if (state is DoorState.Resolving && !pageShown) {
      CircularProgressIndicator(
        modifier = Modifier.align(Alignment.Center),
        color = Color(0xFFE8B86D),
      )
    }

    if (state is DoorState.Offline) {
      OfflineCard(
        detail = state.detail,
        onRetry = { retryKey += 1 },
        onOpenNative = onOpenNative,
        modifier = Modifier.align(Alignment.Center).padding(20.dp),
      )
    }

    // ✈ lives in Tinker's phone header (phone-mode.ts, via JarvisNative.openNative("trip")); a
    // floating button here covered the first line of the chat. Offline, the card has its own.
  }
}

@Composable
private fun OfflineCard(
  detail: String,
  onRetry: () -> Unit,
  onOpenNative: (JarvisScreen) -> Unit,
  modifier: Modifier = Modifier,
) {
  Surface(
    modifier = modifier.widthIn(max = 420.dp).fillMaxWidth(),
    shape = RoundedCornerShape(18.dp),
    color = Color(0xFF2A1F17),
    border = androidx.compose.foundation.BorderStroke(1.dp, Color(0x33E8E0D4)),
  ) {
    Column(
      modifier = Modifier.padding(18.dp),
      verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
          "Jarvis is not reachable",
          color = Color(0xFFF3E6CF),
          fontSize = 18.sp,
          fontWeight = FontWeight.SemiBold,
          modifier = Modifier.weight(1f),
        )
        JarvisNativeMenu(onOpen = onOpenNative, tint = Color(0xFFF3E6CF))
      }
      Text(detail, color = Color(0xFFCBBBA4), fontSize = 14.sp)
      Text("Trying again every 15 seconds.", color = Color(0xFF9C8B75), fontSize = 12.sp)
      Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Button(onClick = onRetry) { Text("Retry") }
        OutlinedButton(
          onClick = { onOpenNative(JarvisScreen.Trip) },
          colors = ButtonDefaults.outlinedButtonColors(contentColor = Color(0xFFF3E6CF)),
          border = androidx.compose.foundation.BorderStroke(1.dp, Color(0x66E8E0D4)),
        ) { Text("Open Trip (offline copy)") }
      }
    }
  }
}

/** The ⋮ menu that reaches the native screens when Tinker itself cannot. */
@Composable
internal fun JarvisNativeMenu(
  onOpen: (JarvisScreen) -> Unit,
  tint: Color,
) {
  var open by remember { mutableStateOf(false) }
  Box {
    IconButton(onClick = { open = true }) {
      Icon(Icons.Default.MoreVert, contentDescription = "More", tint = tint)
    }
    DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
      listOf(
        JarvisScreen.Connect to "Connection",
        JarvisScreen.Voice to "Voice",
        JarvisScreen.Screen to "Screen",
        JarvisScreen.Settings to "Settings",
      ).forEach { (screen, label) ->
        DropdownMenuItem(
          text = { Text(label) },
          onClick = {
            open = false
            onOpen(screen)
          },
        )
      }
    }
  }
}

@SuppressLint("SetJavaScriptEnabled")
@Suppress("DEPRECATION")
private fun createTinkerWebView(
  context: Context,
  holder: TinkerWebHolder,
  onOpenNative: (JarvisScreen) -> Unit,
  onShowFileChooser: (Intent) -> Boolean,
  onRequestMic: () -> Unit,
  onMainFrameError: (String) -> Unit,
  onPageShown: () -> Unit,
  onRendererGone: () -> Unit,
): WebView {
  // Remote debugging drives the logged-in page: only in a JARVIS_DEV build, never just because the
  // APK is debuggable.
  if (BuildConfig.JARVIS_DEV) WebView.setWebContentsDebuggingEnabled(true)
  val webView = WebView(context)
  ai.openclaw.app.jarvis.JarvisLook.attachTinker(webView)
  webView.settings.apply {
    javaScriptEnabled = true
    domStorageEnabled = true
    databaseEnabled = true
    mediaPlaybackRequiresUserGesture = false
    allowFileAccess = false
    allowContentAccess = false
    allowFileAccessFromFileURLs = false
    allowUniversalAccessFromFileURLs = false
    mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
    setSupportMultipleWindows(false)
    userAgentString = "$userAgentString JarvisApp/${BuildConfig.VERSION_NAME}"
  }
  if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
    WebSettingsCompat.setAlgorithmicDarkeningAllowed(webView.settings, false)
  }
  webView.setBackgroundColor(android.graphics.Color.rgb(0x1C, 0x14, 0x0F))
  CookieManager.getInstance().setAcceptCookie(true)
  holder.bridge?.close()
  holder.bridge = JarvisNativeBridge(context = context, onOpenNative = onOpenNative)

  // In-page edge swipes open Tinker's drawers; Android allows at most 200 dp per edge.
  webView.addOnLayoutChangeListener { view, _, _, _, _, _, _, _, _ -> applyEdgeSwipeExclusion(view) }

  webView.webViewClient =
    object : WebViewClient() {
      override fun shouldOverrideUrlLoading(
        view: WebView,
        request: WebResourceRequest,
      ): Boolean {
        if (!request.isForMainFrame) return false
        val url = request.url
        if (isSameJarvisOrigin(url.toString(), holder.origin)) return false
        if (url.scheme == "about" || url.scheme == "javascript") return false
        // Anything outside the door opens in the browser (or the app that owns the link).
        try {
          view.context.startActivity(Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (_: ActivityNotFoundException) {
          Toast.makeText(view.context, "No app can open this link", Toast.LENGTH_SHORT).show()
        }
        return true
      }

      override fun onPageStarted(
        view: WebView,
        url: String?,
        favicon: android.graphics.Bitmap?,
      ) {
        holder.currentUrl = url
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT) && holder.isTrustedPage()) {
          view.evaluateJavascript(jarvisDocumentStartScript(BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE), null)
        }
      }

      override fun onPageCommitVisible(
        view: WebView,
        url: String?,
      ) {
        holder.currentUrl = url
        onPageShown()
      }

      override fun doUpdateVisitedHistory(
        view: WebView,
        url: String?,
        isReload: Boolean,
      ) {
        holder.currentUrl = url
      }

      override fun onPageFinished(
        view: WebView,
        url: String?,
      ) {
        holder.currentUrl = url
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT) && holder.isTrustedPage()) {
          view.evaluateJavascript(jarvisDocumentStartScript(BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE), null)
        }
      }

      override fun onReceivedError(
        view: WebView,
        request: WebResourceRequest,
        error: WebResourceError,
      ) {
        if (!request.isForMainFrame) return
        Log.w(JarvisNativeBridge.LOG_TAG, "main frame error ${error.errorCode}: ${error.description}")
        onMainFrameError("The door stopped answering (${error.description}).")
      }

      override fun onRenderProcessGone(
        view: WebView,
        detail: android.webkit.RenderProcessGoneDetail,
      ): Boolean {
        Log.w(JarvisNativeBridge.LOG_TAG, "renderer gone, crashed=${detail.didCrash()}")
        (view.parent as? ViewGroup)?.removeView(view)
        onRendererGone()
        return true
      }
    }

  webView.webChromeClient =
    object : WebChromeClient() {
      override fun onShowFileChooser(
        webView: WebView,
        filePathCallback: ValueCallback<Array<Uri>>,
        fileChooserParams: FileChooserParams,
      ): Boolean {
        holder.fileCallback?.onReceiveValue(null)
        holder.fileCallback = filePathCallback
        val intent =
          fileChooserParams.createIntent().apply {
            if (fileChooserParams.mode == FileChooserParams.MODE_OPEN_MULTIPLE) {
              putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            }
          }
        if (!onShowFileChooser(intent)) {
          holder.fileCallback = null
          return false
        }
        return true
      }

      override fun onPermissionRequest(request: PermissionRequest) {
        val wantsAudio = request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)
        if (!wantsAudio || !isSameJarvisOrigin(request.origin.toString(), holder.origin)) {
          request.deny()
          return
        }
        val granted =
          ContextCompat.checkSelfPermission(webView.context, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        if (granted) {
          request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
        } else {
          holder.pendingMicRequest?.deny()
          holder.pendingMicRequest = request
          onRequestMic()
        }
      }

      override fun onConsoleMessage(message: ConsoleMessage): Boolean {
        Log.d(
          JarvisNativeBridge.LOG_TAG,
          "console ${message.messageLevel()} ${message.sourceId()}:${message.lineNumber()} ${message.message()}",
        )
        return true
      }
    }

  webView.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
    enqueueDownload(webView.context, url, userAgent, contentDisposition, mimeType)
  }
  return webView
}

private fun installDocumentStartScript(
  webView: WebView,
  holder: TinkerWebHolder,
  origin: String,
) {
  if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
  if (!holder.scriptOrigins.add(origin)) return
  WebViewCompat.addDocumentStartJavaScript(
    webView,
    jarvisDocumentStartScript(BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE),
    setOf(origin),
  )
}

/**
 * The JarvisNative message port, injected only into frames on the door origin. The listener still
 * insists on the main frame and the current door, so a same-origin iframe gets nothing either.
 * WebViews too old for WEB_MESSAGE_LISTENER get no bridge at all (the page still sees html.jarvis-app).
 */
private fun installNativeBridge(
  webView: WebView,
  holder: TinkerWebHolder,
  origin: String,
) {
  if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
    Log.w(JarvisNativeBridge.LOG_TAG, "WebView without WEB_MESSAGE_LISTENER: JarvisNative is off")
    return
  }
  if (holder.bridgeOrigin == origin) return
  if (holder.bridgeOrigin != null) WebViewCompat.removeWebMessageListener(webView, JarvisNativeBridge.PORT_NAME)
  WebViewCompat.addWebMessageListener(webView, JarvisNativeBridge.PORT_NAME, setOf(origin)) { _, message, sourceOrigin, isMainFrame, replyProxy ->
    if (!isMainFrame || !isSameJarvisOrigin(sourceOrigin.toString(), holder.origin) || !holder.isTrustedPage()) {
      return@addWebMessageListener
    }
    holder.bridge?.dispatch(message.data) { msg -> replyProxy.postMessage(msg) }
  }
  holder.bridgeOrigin = origin
}

/** 48 dp strips on both edges, 200 dp tall, vertically centred. */
internal fun applyEdgeSwipeExclusion(view: View) {
  val width = view.width
  val height = view.height
  if (width <= 0 || height <= 0) return
  val density = view.resources.displayMetrics.density
  val strip = (48 * density).toInt()
  val tall = minOf((200 * density).toInt(), height)
  val top = (height - tall) / 2
  ViewCompat.setSystemGestureExclusionRects(
    view,
    listOf(
      Rect(0, top, strip, top + tall),
      Rect(width - strip, top, width, top + tall),
    ),
  )
}

private fun fileChooserResult(
  resultCode: Int,
  data: Intent?,
): Array<Uri>? {
  if (resultCode != Activity.RESULT_OK || data == null) return null
  val clip = data.clipData
  if (clip != null && clip.itemCount > 0) {
    return Array(clip.itemCount) { clip.getItemAt(it).uri }
  }
  return data.data?.let { arrayOf(it) }
}

private fun enqueueDownload(
  context: Context,
  url: String,
  userAgent: String?,
  contentDisposition: String?,
  mimeType: String?,
) {
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    Toast.makeText(context, "This file cannot be downloaded from the app", Toast.LENGTH_SHORT).show()
    return
  }
  val name = URLUtil.guessFileName(url, contentDisposition, mimeType)
  try {
    val request =
      DownloadManager
        .Request(Uri.parse(url))
        .setTitle(name)
        .setMimeType(mimeType)
        .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
        .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
    userAgent?.let { request.addRequestHeader("User-Agent", it) }
    // The door wants the device cookie on downloads as well.
    CookieManager.getInstance().getCookie(url)?.let { request.addRequestHeader("Cookie", it) }
    context.getSystemService(DownloadManager::class.java).enqueue(request)
    Toast.makeText(context, "Downloading $name", Toast.LENGTH_SHORT).show()
  } catch (err: Exception) {
    Log.w(JarvisNativeBridge.LOG_TAG, "download failed: ${err.message}")
    Toast.makeText(context, "Download failed", Toast.LENGTH_SHORT).show()
  }
}
