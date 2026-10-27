package ai.openclaw.app.jarvis

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.VibratorManager
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * FORK 2026-10-22 (the architect 13:28: "Build the capability of being able to reach me anytime by voice").
 * Node command jarvis.say {text}: Jarvis speaks on the phone even with the app closed (the gateway's
 * Firebase wake brings the node back, then retries the invoke). Same voice as in the app: GBD,
 * faster, intonation widened, the singing fork and the metallic chain (JarvisVoiceFx), pitch dropped
 * at playback. The words are chosen on the Pi and are discreet by rule (jarvis-voice SKILL.md
 * § Calling the architect). 2026-10-23: the speed and pitch drop come from the pack's voice-fx.json too, and
 * the say verb (JarvisVerbs) may override speed, voice name, or skip the effects (voice.fx = false).
 */
object JarvisSay {
  private const val TAG = "JarvisSay"
  private val main = Handler(Looper.getMainLooper())

  fun say(
    context: Context,
    text: String,
    buzz: Boolean = false,
    speed: Double? = null,
    voiceName: String? = null,
    fx: Boolean = true,
  ): String {
    val app = context.applicationContext
    val tuned = JarvisPack.voiceFx(app)
    val voiceFx = tuned?.takeIf { fx }
    // Jarvis's speed either way; only with the effects does the pitch drop slow the line down.
    val playbackRate = voiceFx?.speech?.playbackRate ?: 1.0
    val rate = ((speed ?: tuned?.speech?.speed ?: 1.0) / playbackRate).toFloat()
    if (buzz) {
      // Same 180 ms buzz the page gives when an answer lands (app.ts buzzIfPhonePrompted).
      runCatching {
        app.getSystemService(VibratorManager::class.java)?.defaultVibrator
          ?.vibrate(VibrationEffect.createOneShot(180, VibrationEffect.DEFAULT_AMPLITUDE))
      }.onFailure { Log.w(TAG, "buzz failed: ${it.message}") }
    }
    val id = "say-${System.currentTimeMillis()}"
    val file = File(app.cacheDir, "$id.wav")
    main.post {
      var tts: TextToSpeech? = null
      tts =
        TextToSpeech(app) { status ->
          val engine = tts ?: return@TextToSpeech
          if (status != TextToSpeech.SUCCESS) {
            Log.w(TAG, "speech engine did not start: $status")
            engine.shutdown()
            return@TextToSpeech
          }
          pickVoice(engine, voiceName)
          engine.setSpeechRate(rate)
          engine.setOnUtteranceProgressListener(
            object : UtteranceProgressListener() {
              override fun onStart(utteranceId: String?) {}

              override fun onDone(utteranceId: String?) {
                main.post { engine.shutdown() }
                Thread { play(app, file, voiceFx) }.start()
              }

              @Deprecated("Deprecated in Java")
              override fun onError(utteranceId: String?) {
                Log.w(TAG, "speech engine failed on $utteranceId")
                main.post { engine.shutdown() }
                file.delete()
              }
            },
          )
          engine.synthesizeToFile(text, null, file, id)
        }
    }
    return """{"queued":true}"""
  }

  /** The named voice if installed, else GBD (online first), else any male British voice, else British English. */
  private fun pickVoice(
    tts: TextToSpeech,
    name: String?,
  ) {
    val voices = runCatching { tts.voices }.getOrNull().orEmpty().filter { !it.features.contains("notInstalled") }
    voices.firstOrNull { !name.isNullOrBlank() && it.name == name }?.let {
      tts.voice = it
      return
    }
    val gbd = voices.filter { it.name.contains("-x-gbd-") }.sortedByDescending { it.isNetworkConnectionRequired }
    val male = voices.filter { v -> listOf("-x-gbb-", "-x-rjs-").any { v.name.contains(it) } }
    val pick = gbd.firstOrNull() ?: male.firstOrNull()
    if (pick != null) tts.voice = pick else tts.language = java.util.Locale.UK
  }

  private fun play(
    context: Context,
    file: File,
    fx: VoiceFx?,
  ) {
    try {
      val (pcm, sr) = readWav(file) ?: return
      val y = if (fx != null) JarvisVoiceFx.process(pcm, sr, fx) else pcm
      val shorts = ShortArray(y.size) { (y[it].coerceIn(-1f, 1f) * 32767).toInt().toShort() }
      val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
      val attrs =
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_ASSISTANT)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
          .build()
      val focus =
        AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK).setAudioAttributes(attrs).build()
      audio.requestAudioFocus(focus)
      val playRate = (sr * (fx?.speech?.playbackRate ?: 1.0)).toInt()
      val track =
        AudioTrack.Builder()
          .setAudioAttributes(attrs)
          .setAudioFormat(
            AudioFormat.Builder()
              .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
              .setSampleRate(playRate)
              .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
              .build(),
          )
          .setTransferMode(AudioTrack.MODE_STATIC)
          .setBufferSizeInBytes(shorts.size * 2)
          .build()
      track.write(shorts, 0, shorts.size)
      track.play()
      Thread.sleep(shorts.size * 1000L / playRate + 300)
      track.release()
      audio.abandonAudioFocusRequest(focus)
    } catch (t: Throwable) {
      Log.w(TAG, "playback failed: ${t.message}")
    } finally {
      file.delete()
    }
  }

  /** 16-bit PCM WAV, first channel, as floats; null if the file is not that. */
  private fun readWav(file: File): Pair<FloatArray, Int>? {
    val b = ByteBuffer.wrap(file.readBytes()).order(ByteOrder.LITTLE_ENDIAN)
    if (b.capacity() < 44) return null
    var pos = 12
    var sr = 0
    var channels = 1
    var bits = 16
    while (pos + 8 <= b.capacity()) {
      val tag = String(ByteArray(4) { b.get(pos + it) })
      val size = b.getInt(pos + 4)
      val body = pos + 8
      if (tag == "fmt ") {
        channels = b.getShort(body + 2).toInt()
        sr = b.getInt(body + 4)
        bits = b.getShort(body + 14).toInt()
      } else if (tag == "data") {
        if (bits != 16 || sr == 0) return null
        val len = minOf(size, b.capacity() - body) / 2 / channels
        val out = FloatArray(len) { b.getShort(body + it * 2 * channels) / 32768f }
        return out to sr
      }
      pos = body + size + (size and 1)
    }
    return null
  }
}
