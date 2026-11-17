package ai.openclaw.app.jarvis

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.MediaRecorder
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import androidx.core.content.ContextCompat
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.io.File

// FORK 2026-11-04 (the architect: phone app) — the Tinker record button, recorded by the app. The door is
// plain http, and a WebView on http has no navigator.mediaDevices, so the page asks the app instead:
// JarvisNative.recStart() / recStop(). The finished file goes back to the page in base64 pieces
// ({ev:"rec-chunk"}), and the page sends it exactly as a browser recording.

/** Same cap as the page (voice-recorder.ts RECORDING_MAX_BYTES): fits the gateway's 25 MB frame. */
private const val MAX_BYTES = 17L * 1024 * 1024

/** Raw bytes per piece sent to the page; base64 keeps each message well under the port limit. */
private const val CHUNK_BYTES = 192 * 1024

class JarvisRecorder(
  private val context: Context,
  private val emit: (String) -> Unit,
  private val requestMic: () -> Unit,
) {
  private val main = Handler(Looper.getMainLooper())
  private var recorder: MediaRecorder? = null
  private var file: File? = null
  private var startedAt = 0L

  private val tick =
    object : Runnable {
      override fun run() {
        if (recorder == null) return
        send("rec", "state" to JsonPrimitive("tick"), "bytes" to JsonPrimitive(file?.length() ?: 0L))
        main.postDelayed(this, 1000)
      }
    }

  fun start() {
    if (recorder != null) return
    if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      requestMic()
      send("rec", "state" to JsonPrimitive("error"), "message" to JsonPrimitive("Allow the microphone for Jarvis, then press record again."))
      return
    }
    val out = File(context.cacheDir, "tinker-recording.ogg")
    out.delete()
    val rec = MediaRecorder(context)
    try {
      rec.setAudioSource(MediaRecorder.AudioSource.VOICE_RECOGNITION)
      rec.setOutputFormat(MediaRecorder.OutputFormat.OGG)
      rec.setAudioEncoder(MediaRecorder.AudioEncoder.OPUS)
      rec.setAudioChannels(1)
      rec.setAudioSamplingRate(48_000)
      rec.setAudioEncodingBitRate(24_000)
      rec.setMaxFileSize(MAX_BYTES)
      rec.setOnInfoListener { _, what, _ ->
        if (what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_FILESIZE_REACHED) main.post { stop(capped = true) }
      }
      rec.setOutputFile(out.absolutePath)
      rec.prepare()
      rec.start()
    } catch (t: Throwable) {
      Log.w(JarvisNativeBridge.LOG_TAG, "recorder start failed", t)
      rec.release()
      send("rec", "state" to JsonPrimitive("error"), "message" to JsonPrimitive("The microphone could not start: ${t.message ?: t.javaClass.simpleName}"))
      return
    }
    recorder = rec
    file = out
    startedAt = SystemClock.elapsedRealtime()
    send("rec", "state" to JsonPrimitive("started"))
    main.postDelayed(tick, 1000)
  }

  fun stop(capped: Boolean = false) {
    val rec = recorder ?: return
    recorder = null
    main.removeCallbacks(tick)
    val durationMs = SystemClock.elapsedRealtime() - startedAt
    val ok = runCatching { rec.stop() }.isSuccess
    rec.release()
    val out = file
    file = null
    if (!ok || out == null || out.length() == 0L) {
      out?.delete()
      send("rec", "state" to JsonPrimitive("error"), "message" to JsonPrimitive("The recording was empty."))
      return
    }
    Thread {
      try {
        val bytes = out.readBytes()
        val total = (bytes.size + CHUNK_BYTES - 1) / CHUNK_BYTES
        for (i in 0 until total) {
          val end = minOf(bytes.size, (i + 1) * CHUNK_BYTES)
          val b64 = Base64.encodeToString(bytes, i * CHUNK_BYTES, end - i * CHUNK_BYTES, Base64.NO_WRAP)
          send(
            "rec-chunk",
            "seq" to JsonPrimitive(i),
            "total" to JsonPrimitive(total),
            "b64" to JsonPrimitive(b64),
            "mime" to JsonPrimitive("audio/ogg"),
            "bytes" to JsonPrimitive(bytes.size),
            "durationMs" to JsonPrimitive(durationMs),
            "capped" to JsonPrimitive(capped),
          )
        }
      } catch (t: Throwable) {
        Log.w(JarvisNativeBridge.LOG_TAG, "recorder read failed", t)
        send("rec", "state" to JsonPrimitive("error"), "message" to JsonPrimitive("The recording could not be read: ${t.message}"))
      } finally {
        out.delete()
      }
    }.start()
  }

  /** The WebView is gone: stop without sending anything. */
  fun close() {
    val rec = recorder ?: return
    recorder = null
    main.removeCallbacks(tick)
    runCatching { rec.stop() }
    rec.release()
    file?.delete()
    file = null
  }

  private fun send(
    ev: String,
    vararg fields: Pair<String, JsonElement>,
  ) {
    val msg = JsonObject(mapOf("ev" to JsonPrimitive(ev)) + fields).toString()
    main.post { runCatching { emit(msg) }.onFailure { Log.w(JarvisNativeBridge.LOG_TAG, "rec reply failed: ${it.message}") } }
  }
}
