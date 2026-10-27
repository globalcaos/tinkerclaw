package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.jarvis.JarvisDoor
import ai.openclaw.app.jarvis.JarvisScreen
import ai.openclaw.app.jarvis.TripCache
import ai.openclaw.app.jarvis.isSameJarvisOrigin
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.view.ViewGroup
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.DateFormat
import java.util.Date

// FORK 2026-10-19 (the architect: phone app) — the trip corner: <door>/trip/ live, and the last good copy
// of it from disk when the door cannot be reached (airports, planes, roaming without data).

private const val TRIP_PATH = "/trip/"

@SuppressLint("SetJavaScriptEnabled")
@Composable
internal fun TripScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
  onOpenNative: (JarvisScreen) -> Unit,
) {
  val context = LocalContext.current
  val scope = rememberCoroutineScope()
  var offlineLabel by remember { mutableStateOf<String?>(null) }
  var reloadKey by remember { mutableIntStateOf(0) }
  val origin = remember { arrayOfNulls<String>(1) }

  BackHandler(onBack = onBack)

  val webView =
    remember {
      createTripWebView(
        context = context,
        origin = { origin[0] },
        onLoaded = { url ->
          val door = origin[0]
          val token = viewModel.jarvisDeviceToken()
          if (door != null && token != null && isSameJarvisOrigin(url, door)) {
            offlineLabel = null
            snapshotTrip(context, scope, door, token)
          }
        },
        onFailed = {
          offlineLabel = showOfflineCopy(context, it)
        },
      )
    }
  DisposableEffect(webView) {
    onDispose {
      (webView.parent as? ViewGroup)?.removeView(webView)
      webView.stopLoading()
      webView.destroy()
    }
  }

  LaunchedEffect(reloadKey) {
    val token = viewModel.jarvisDeviceToken()
    val door = if (token == null) null else viewModel.resolveJarvisDoor()
    origin[0] = door
    if (door == null || token == null) {
      offlineLabel = showOfflineCopy(context, webView)
      return@LaunchedEffect
    }
    JarvisDoor.installDeviceCookie(door, token)
    webView.loadUrl("$door$TRIP_PATH")
  }

  Column(
    modifier =
      Modifier
        .fillMaxSize()
        .background(jarvisWoodDark)
        .windowInsetsPadding(WindowInsets.safeDrawing),
  ) {
    Row(
      modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 2.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      // 2026-10-25 (the architect): no back arrow; the phone's own Back (BackHandler above) returns to Jarvis.
      Column(modifier = Modifier.weight(1f).padding(start = 12.dp)) {
        Text("✈ Trip", color = Color(0xFFF3E6CF), fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
        offlineLabel?.let { Text(it, color = Color(0xFFE8B86D), fontSize = 12.sp) }
      }
      IconButton(onClick = { reloadKey += 1 }) {
        Icon(Icons.Default.Refresh, contentDescription = "Reload", tint = Color(0xFFF3E6CF))
      }
      JarvisNativeMenu(onOpen = onOpenNative, tint = Color(0xFFF3E6CF))
    }
    Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
      AndroidView(
        modifier = Modifier.fillMaxSize(),
        factory = {
          (webView.parent as? ViewGroup)?.removeView(webView)
          webView
        },
      )
    }
  }
}

@SuppressLint("SetJavaScriptEnabled")
private fun createTripWebView(
  context: Context,
  origin: () -> String?,
  onLoaded: (String?) -> Unit,
  onFailed: (WebView) -> Unit,
): WebView {
  val webView = WebView(context)
  webView.setBackgroundColor(android.graphics.Color.rgb(0x1C, 0x14, 0x0F))
  webView.settings.apply {
    javaScriptEnabled = true
    domStorageEnabled = true
    allowFileAccess = false
    allowContentAccess = false
  }
  var failed = false
  webView.webViewClient =
    object : WebViewClient() {
      override fun shouldOverrideUrlLoading(
        view: WebView,
        request: WebResourceRequest,
      ): Boolean {
        if (!request.isForMainFrame) return false
        if (isSameJarvisOrigin(request.url.toString(), origin())) return false
        try {
          view.context.startActivity(Intent(Intent.ACTION_VIEW, request.url).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (_: ActivityNotFoundException) {
          // Nothing to open it with; stay on the trip page.
        }
        return true
      }

      override fun onPageStarted(
        view: WebView,
        url: String?,
        favicon: android.graphics.Bitmap?,
      ) {
        if (isSameJarvisOrigin(url, origin())) failed = false
      }

      override fun onReceivedError(
        view: WebView,
        request: WebResourceRequest,
        error: WebResourceError,
      ) {
        if (!request.isForMainFrame || failed) return
        failed = true
        onFailed(view)
      }

      override fun onReceivedHttpError(
        view: WebView,
        request: WebResourceRequest,
        errorResponse: WebResourceResponse,
      ) {
        // A 404 means no trip has been rendered yet; the door's own page explains that.
        if (!request.isForMainFrame || errorResponse.statusCode < 500 || failed) return
        failed = true
        onFailed(view)
      }

      override fun onPageFinished(
        view: WebView,
        url: String?,
      ) {
        if (!failed) onLoaded(url)
      }
    }
  return webView
}

/** Loads the saved copy into [webView]; returns the banner text. */
private fun showOfflineCopy(
  context: Context,
  webView: WebView,
): String {
  val saved = TripCache.load(context)
  if (saved == null) {
    webView.loadDataWithBaseURL(
      null,
      "<html><body style=\"background:#1c140f;color:#e8e0d4;font-family:sans-serif;padding:24px\">" +
        "<h3>No offline copy yet</h3><p>Open the trip once while Jarvis is reachable and it is kept here.</p>" +
        "</body></html>",
      "text/html",
      "UTF-8",
      null,
    )
    return "Offline, no saved copy"
  }
  val (html, savedAt) = saved
  // No base URL: trip.html is self-contained, and a door-origin base would look like a live load.
  webView.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null)
  val time = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(savedAt))
  return "Offline copy from $time"
}

/** Fetches the same page with the device header and keeps it for offline use. */
private fun snapshotTrip(
  context: Context,
  scope: CoroutineScope,
  door: String,
  token: String,
) {
  val appContext = context.applicationContext
  scope.launch {
    val html = JarvisDoor.fetchText(door, TRIP_PATH, token) ?: return@launch
    if (html.isBlank()) return@launch
    withContext(Dispatchers.IO) { runCatching { TripCache.save(appContext, html) } }
  }
}
