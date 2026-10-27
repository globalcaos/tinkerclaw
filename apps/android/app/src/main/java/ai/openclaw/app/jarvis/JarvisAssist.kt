package ai.openclaw.app.jarvis

import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.speech.RecognizerIntent
import android.util.Log
import org.json.JSONObject

/**
 * The side-key long press (2026-10-21, the architect: "When I make a long press on the lock button I would
 * like you to take the voice command instead of gemini on my phone, then open a new tab if none is
 * selected and answer"). With Jarvis set as the phone's digital assistant app, the long press sends
 * ACTION_ASSIST to MainActivity, which opens the speech recognizer. The words land here and go to
 * the Tinker page's `window.__jarvisAssist(text)` (tinker-ui app.ts), which picks the tab and sends.
 * A cold start has no page yet, so the prompt waits and is retried for up to 30 s.
 */
object JarvisAssist {
  private const val TAG = "JarvisAssist"
  private const val RETRY_MS = 500L
  private const val MAX_ATTEMPTS = 60
  private val main = Handler(Looper.getMainLooper())

  @Volatile private var pending: String? = null

  fun recognizerIntent(): Intent =
    Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
      .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
      .putExtra(RecognizerIntent.EXTRA_PROMPT, "Jarvis is listening")

  fun firstResult(data: Intent?): String? =
    data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()?.trim()?.ifEmpty { null }

  fun deliver(text: String) {
    pending = text
    main.post { tryInject(text, 0) }
  }

  private fun tryInject(text: String, attempt: Int) {
    if (pending != text) return
    val web = JarvisLook.tinkerWebView()
    if (web == null) {
      retry(text, attempt)
      return
    }
    val js = "(function(){var f=window.__jarvisAssist;return typeof f==='function'?f(${JSONObject.quote(text)}):false})()"
    web.evaluateJavascript(js) { result ->
      if (result == "true") {
        if (pending == text) pending = null
      } else {
        retry(text, attempt)
      }
    }
  }

  private fun retry(text: String, attempt: Int) {
    if (attempt + 1 >= MAX_ATTEMPTS) {
      Log.e(TAG, "the Tinker page never took the voice prompt (${text.length} chars)")
      if (pending == text) pending = null
      return
    }
    main.postDelayed({ tryInject(text, attempt + 1) }, RETRY_MS)
  }
}
