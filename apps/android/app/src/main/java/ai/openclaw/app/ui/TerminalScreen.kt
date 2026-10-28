package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.jarvis.JarvisDoor
import ai.openclaw.app.jarvis.isSameJarvisOrigin
import android.annotation.SuppressLint
import android.content.Context
import android.text.InputType
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputConnectionWrapper
import android.webkit.WebResourceRequest
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
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView

// 2026-10-20: a terminal on the host, to reach Claude Code and repair the gateway when it hangs. The page and its shell live in the phone door (scripts/phone-door/term.mjs), not in the
// gateway or the Tinker page server, so this screen still works when those are stuck.
private const val TERM_PATH = "/door/term/"

@SuppressLint("SetJavaScriptEnabled")
@Composable
internal fun TerminalScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val context = LocalContext.current
  var status by remember { mutableStateOf<String?>(null) }
  var reloadKey by remember { mutableIntStateOf(0) }
  val origin = remember { arrayOfNulls<String>(1) }

  BackHandler(onBack = onBack)

  val webView = remember { createTerminalWebView(context) { origin[0] } }
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
      status = "Door not reachable (Tailscale on?)"
      return@LaunchedEffect
    }
    status = null
    JarvisDoor.installDeviceCookie(door, token)
    webView.loadUrl("$door$TERM_PATH")
  }

  Column(
    modifier =
      Modifier
        .fillMaxSize()
        .background(Color(0xFF1B1510))
        .windowInsetsPadding(WindowInsets.safeDrawing)
        .imePadding(),
  ) {
    Row(
      modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 2.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      IconButton(onClick = onBack) {
        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back to Tinker", tint = Color(0xFFF3E6CF))
      }
      Column(modifier = Modifier.weight(1f)) {
        Text("⌨ Pi terminal", color = Color(0xFFF3E6CF), fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
        status?.let { Text(it, color = Color(0xFFE8B86D), fontSize = 12.sp) }
      }
      IconButton(onClick = { reloadKey += 1 }) {
        Icon(Icons.Default.Refresh, contentDescription = "Reconnect", tint = Color(0xFFF3E6CF))
      }
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
private fun createTerminalWebView(
  context: Context,
  origin: () -> String?,
): WebView {
  // Shell input is case-sensitive: never let the keyboard start a "sentence" in caps. xterm already
  // sets autocapitalize=off on its textarea, but Samsung's keyboard ignores it, so strip the flags here.
  val webView =
    object : WebView(context) {
      override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
        val ic = super.onCreateInputConnection(outAttrs)
        outAttrs.inputType =
          outAttrs.inputType and
          (
            InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or
              InputType.TYPE_TEXT_FLAG_CAP_WORDS or
              InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS
          ).inv()
        outAttrs.initialCapsMode = 0
        // Keyboards also ask the connection at each cursor move whether to shift; always say no.
        return ic?.let {
          object : InputConnectionWrapper(it, true) {
            override fun getCursorCapsMode(reqModes: Int): Int = 0
          }
        }
      }
    }
  webView.setBackgroundColor(android.graphics.Color.rgb(0x1B, 0x15, 0x10))
  webView.settings.apply {
    javaScriptEnabled = true
    domStorageEnabled = true
    allowFileAccess = false
    allowContentAccess = false
  }
  webView.webViewClient =
    object : WebViewClient() {
      // The terminal never navigates away from the door.
      override fun shouldOverrideUrlLoading(
        view: WebView,
        request: WebResourceRequest,
      ): Boolean = request.isForMainFrame && !isSameJarvisOrigin(request.url.toString(), origin())
    }
  return webView
}
