package ai.openclaw.app.jarvis

import android.content.Context
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import android.util.Log
import java.util.Locale

// FORK 2026-10-21: read aloud with a good voice — the PDF reader's
// read-aloud on the phone speaks with Android's own engine (Google's neural voices), on the phone,
// instead of waiting for the Pi to synthesise each sentence (13 s a sentence when the Pi is busy).
// The page sends one sentence at a time with an id; the engine's done/error for that id goes back
// to the page, which then highlights and sends the next one.

class JarvisTts(
  context: Context,
  /** (utterance id, "done" | "error", message) */
  private val onEvent: (String, String, String) -> Unit,
) {
  private var engine: TextToSpeech? = null
  private var ready = false
  private var failed = false
  private val waiting = ArrayDeque<() -> Unit>()
  private var lang = ""

  init {
    engine =
      TextToSpeech(context.applicationContext) { status ->
        ready = status == TextToSpeech.SUCCESS
        failed = !ready
        if (ready) {
          engine?.setOnUtteranceProgressListener(
            object : UtteranceProgressListener() {
              override fun onStart(utteranceId: String?) {}

              override fun onDone(utteranceId: String?) {
                val file = synthFiles.remove(utteranceId.orEmpty())
                if (file != null) {
                  val bytes = runCatching { file.readBytes() }.getOrNull()
                  file.delete()
                  onAudio?.invoke(utteranceId.orEmpty(), bytes)
                  return
                }
                onEvent(utteranceId.orEmpty(), "done", "")
              }

              @Deprecated("Deprecated in Java")
              override fun onError(utteranceId: String?) {
                if (synthFiles.remove(utteranceId.orEmpty()) != null) return onAudio?.invoke(utteranceId.orEmpty(), null) ?: Unit
                onEvent(utteranceId.orEmpty(), "error", "the phone's speech engine failed")
              }

              override fun onError(
                utteranceId: String?,
                errorCode: Int,
              ) {
                if (synthFiles.remove(utteranceId.orEmpty()) != null) return onAudio?.invoke(utteranceId.orEmpty(), null) ?: Unit
                onEvent(utteranceId.orEmpty(), "error", "the phone's speech engine failed (code $errorCode)")
              }
            },
          )
        } else {
          Log.w(JarvisNativeBridge.LOG_TAG, "text-to-speech engine did not start: status $status")
        }
        val queued = waiting.toList()
        waiting.clear()
        queued.forEach { it() }
      }
  }

  // 2026-10-22: the metallic voice was missing: Jarvis's lines are rendered to a wav instead of
  // the speaker, so the page can run them through the Pi's metallic chain (Web Audio) before playing.
  private val cacheDir = context.applicationContext.cacheDir
  private val synthFiles = java.util.concurrent.ConcurrentHashMap<String, java.io.File>()
  var onAudio: ((String, ByteArray?) -> Unit)? = null

  fun synth(
    id: String,
    text: String,
    rate: Float,
    language: String,
  ) {
    whenReady(id) {
      val tts = engine ?: return@whenReady
      useVoice(tts, language)
      tts.setSpeechRate(rate.coerceIn(0.5f, 2.5f))
      val file = java.io.File(cacheDir, "jarvis-line-${id.filter { it.isLetterOrDigit() }}.wav")
      synthFiles[id] = file
      val r = tts.synthesizeToFile(text, null, file, id)
      if (r != TextToSpeech.SUCCESS) {
        synthFiles.remove(id)
        onAudio?.invoke(id, null)
      }
    }
  }

  private fun useVoice(
    tts: TextToSpeech,
    language: String,
  ) {
    if (language == lang) return
    lang = language
    val named = if (language.startsWith("voice:")) tts.voices?.firstOrNull { it.name == language.removePrefix("voice:") } else null
    if (named != null) tts.voice = named else pickVoice(tts, Locale.forLanguageTag(language.ifBlank { "en-GB" }))
  }

  fun speak(
    id: String,
    text: String,
    rate: Float,
    language: String,
  ) {
    whenReady(id) {
      val tts = engine ?: return@whenReady
      if (language != lang) {
        lang = language
        // 2026-10-22 (need: a phone voice with natural intonation): "voice:<name>" picks one
        // installed voice by name, from the list voices() sends to the page.
        val named = if (language.startsWith("voice:")) tts.voices?.firstOrNull { it.name == language.removePrefix("voice:") } else null
        if (named != null) tts.voice = named else pickVoice(tts, Locale.forLanguageTag(language.ifBlank { "en-GB" }))
      }
      tts.setSpeechRate(rate.coerceIn(0.5f, 2.5f))
      val r = tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, id)
      if (r != TextToSpeech.SUCCESS) onEvent(id, "error", "the phone's speech engine refused the sentence")
    }
  }

  /** Every voice the phone's engine offers, for the page's voice menu. */
  fun voices(onList: (List<Voice>) -> Unit) {
    whenReady("") { onList(runCatching { engine?.voices }.getOrNull().orEmpty().sortedBy { it.name }) }
  }

  fun stop() {
    if (ready) engine?.stop()
  }

  fun shutdown() {
    engine?.shutdown()
    engine = null
  }

  private fun whenReady(
    id: String,
    action: () -> Unit,
  ) {
    when {
      ready -> action()
      failed -> onEvent(id, "error", "this phone has no working text-to-speech engine")
      else -> waiting.addLast(action)
    }
  }

  /** The best installed voice for the language: highest quality, one that works offline first. */
  private fun pickVoice(
    tts: TextToSpeech,
    locale: Locale,
  ) {
    val voices: Set<Voice> = runCatching { tts.voices }.getOrNull().orEmpty()
    val sameLang = voices.filter { it.locale.language == locale.language && !it.features.contains("notInstalled") }
    val pool = sameLang.filter { it.locale.country == locale.country }.ifEmpty { sameLang }
    val best =
      pool.maxWithOrNull(
        // Male British names first (Google: gbb, gbd, rjs), then quality; an online voice is allowed,
        // its prosody is better than the offline one's.
        compareBy<Voice> { v -> MALE_GB.any { v.name.contains(it) } }.thenBy { it.quality }.thenBy { -it.latency },
      )
    if (best != null) {
      tts.voice = best
    } else {
      tts.language = locale
    }
  }

  private companion object {
    val MALE_GB = listOf("x-gbb", "x-gbd", "x-rjs")
  }
}
