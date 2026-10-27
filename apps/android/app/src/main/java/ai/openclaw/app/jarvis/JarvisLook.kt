package ai.openclaw.app.jarvis

import android.app.Activity
import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.view.PixelCopy
import android.webkit.WebView
import java.io.ByteArrayOutputStream
import java.lang.ref.WeakReference
import kotlin.coroutines.resume
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import org.json.JSONObject

/**
 * Lets Jarvis see what the architect sees in the app (2026-10-19, the architect: "you created the phone app without
 * the ability for you to check what I am seeing"). Two node commands use it:
 *   jarvis.screenshot  → the whole app window as JPEG (PixelCopy, so the GPU-drawn WebView is in it)
 *   jarvis.tinker.eval → run JavaScript in the Tinker page, return its result as JSON text
 * Both need the app in the foreground; the dispatcher refuses them otherwise.
 */
object JarvisLook {
  @Volatile private var activityRef: WeakReference<Activity>? = null
  @Volatile private var tinkerRef: WeakReference<WebView>? = null

  @Volatile private var app: android.content.Context? = null

  fun attachActivity(activity: Activity) {
    activityRef = WeakReference(activity)
    app = activity.applicationContext
  }

  /** 2026-10-23: true between MainActivity's onStart and onStop; open and keepAwake read it. */
  @Volatile var foreground = false

  fun activity(): Activity? = activityRef?.get()

  /** 2026-10-22: set at process start, so commands that arrive after a Firebase wake (no screen) work. */
  fun attachApp(context: android.content.Context) {
    if (app == null) app = context.applicationContext
  }

  fun appContext(): android.content.Context = app ?: error("app not started yet")

  fun attachTinker(webView: WebView) {
    tinkerRef = WeakReference(webView)
  }

  fun tinkerWebView(): WebView? = tinkerRef?.get()

  suspend fun screenshotJson(maxWidth: Int, quality: Int): String {
    val activity = activityRef?.get() ?: error("no activity")
    val window = activity.window ?: error("no window")
    val decor = window.decorView
    val w = decor.width
    val h = decor.height
    if (w <= 0 || h <= 0) error("window not laid out")
    val full = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
    val code =
      suspendCancellableCoroutine { cont ->
        PixelCopy.request(window, full, { result -> cont.resume(result) }, Handler(Looper.getMainLooper()))
      }
    if (code != PixelCopy.SUCCESS) error("PixelCopy failed: $code")
    return withContext(Dispatchers.Default) {
      val scaled =
        if (maxWidth in 1 until w) {
          Bitmap.createScaledBitmap(full, maxWidth, (h.toLong() * maxWidth / w).toInt(), true)
        } else {
          full
        }
      val out = ByteArrayOutputStream()
      scaled.compress(Bitmap.CompressFormat.JPEG, quality.coerceIn(30, 95), out)
      JSONObject()
        .put("format", "jpeg")
        .put("width", scaled.width)
        .put("height", scaled.height)
        .put("base64", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP))
        .toString()
    }
  }

  suspend fun tinkerEvalJson(js: String): String {
    val webView = tinkerRef?.get() ?: error("no Tinker page")
    val raw =
      withContext(Dispatchers.Main) {
        suspendCancellableCoroutine { cont -> webView.evaluateJavascript(js) { value -> cont.resume(value ?: "null") } }
      }
    return JSONObject().put("result", raw).toString()
  }
}
