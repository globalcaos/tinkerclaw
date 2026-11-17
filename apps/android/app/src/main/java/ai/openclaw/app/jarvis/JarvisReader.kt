package ai.openclaw.app.jarvis

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import androidx.core.app.ServiceCompat
import ai.openclaw.app.MainActivity
import ai.openclaw.app.R
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.io.File
import java.util.Locale
import java.util.concurrent.Executors

// FORK 2026-11-12: read-aloud that goes on with the screen locked, and answers the headset.
// Before, the PDF reader's page sent one sentence at a time and waited for its "done" (JarvisTts.kt),
// and the page is put to sleep when the screen locks (TinkerScreen.kt, battery), so reading stopped
// there. Now the page hands over the whole reading list from the current sentence on (readQueue, then
// readAppend while it works through the rest of the document), and this object reads it by itself:
//   - a foreground service of type mediaPlayback and a wake lock keep it alive behind the lock screen;
//   - a media session takes the headset and car buttons: play/pause, and next/previous = the next or
//     previous PARAGRAPH (speed is on the notification and on the cover panel);
//   - the media notification shows on the lock screen; JarvisCoverWidget is the Flip cover-screen panel;
//   - every sentence is reported to the page ({ev:"reader"}), which highlights it and saves the place
//     when it is awake; the place is also kept here, so the page catches up after a lock;
//   - the list is kept in a file, so the cover panel can start reading again after Android has
//     dropped the app from memory.
// Everything here runs on the main thread.
object JarvisReader {
  private const val TAG = "JarvisReader"
  private const val CHANNEL_ID = "jarvis.reader"
  const val NOTIFICATION_ID = 0x52454144
  private const val PREFS = "jarvis.reader"
  private const val QUEUE_FILE = "reader-queue.jsonl"
  private const val EXTRA_CMD = "cmd"
  private const val IDLE_STOP_MS = 20 * 60_000L

  // The speeds of the page's own menu (reader.js).
  private val STEPS = floatArrayOf(0.8f, 0.9f, 1f, 1.1f, 1.25f, 1.4f, 1.6f, 1.8f, 2f)

  // The voice leaves about 0.85 s between sentences by itself; a paragraph ends with half of that
  // again and a title with 2 s in all, both shorter at a higher speed (the page's EXTRA table).
  private const val GAP = 0.85f

  /** One sentence: its words, the page it is printed on, and where the page's reading list holds it. */
  private class Item(
    val text: String,
    val page: Int,
    val pause: String,
    val para: Int,
    val listPage: Int,
    val listIdx: Int,
    val from: Int,
  )

  class Snapshot(
    val title: String,
    val line: String,
    val text: String,
    val speed: String,
    val playing: Boolean,
  )

  private val main = Handler(Looper.getMainLooper())
  private val disk = Executors.newSingleThreadExecutor()
  private var app: Context? = null
  private var engine: TextToSpeech? = null
  private var engineReady = false
  private val engineWaiting = ArrayList<(TextToSpeech) -> Unit>()
  private val items = ArrayList<Item>()
  private var queue = ""
  private var doc = ""
  private var title = ""
  private var lang = ""
  private var voiceSet: String? = null
  private var more = false
  private var waiting = false
  private var at = 0
  private var rate = 1f
  private var gen = 0
  private var playing = false
  private var session: MediaSession? = null
  private var wake: PowerManager.WakeLock? = null
  private var focus: AudioFocusRequest? = null
  private var resumeOnFocus = false
  private var noisyOn = false
  private var foregroundOn = false

  /** Sends one JSON message to the page; set by the bridge of the page that is open. */
  @Volatile
  var emit: ((String) -> Unit)? = null

  val hasQueue: Boolean get() = items.isNotEmpty()

  private val nextTick = Runnable { speak() }
  private val idleStop = Runnable { if (!playing) stop() }

  private val audioAttributes: AudioAttributes =
    AudioAttributes
      .Builder()
      .setUsage(AudioAttributes.USAGE_MEDIA)
      .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
      .build()

  private val focusListener =
    AudioManager.OnAudioFocusChangeListener { change ->
      main.post {
        when (change) {
          AudioManager.AUDIOFOCUS_LOSS -> {
            resumeOnFocus = false
            if (playing) pause()
          }
          AudioManager.AUDIOFOCUS_LOSS_TRANSIENT, AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
            // A call or a navigation prompt: stop, and go on with the same sentence afterwards.
            if (playing) {
              pause(keepFocus = true)
              resumeOnFocus = true
            }
          }
          AudioManager.AUDIOFOCUS_GAIN ->
            if (resumeOnFocus) {
              resumeOnFocus = false
              resume()
            }
        }
      }
    }

  // Headphones pulled out or the earbuds switched off: stop, never go on through the speaker.
  private val noisyReceiver =
    object : BroadcastReceiver() {
      override fun onReceive(
        context: Context,
        intent: Intent,
      ) {
        if (intent.action == AudioManager.ACTION_AUDIO_BECOMING_NOISY && playing) pause()
      }
    }

  private fun onMain(action: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) action() else main.post(action)
  }

  // ---- what the page asks for -----------------------------------------------------------------

  /** A new reading list: {q, doc, title, rate, lang, items:[[text,page,pause,para,listPage,listIdx,from]], more}. */
  fun load(
    context: Context,
    json: String,
  ) = onMain {
    app = context.applicationContext
    val obj = parse(json) ?: return@onMain
    queue = obj.str("q")
    doc = obj.str("doc")
    title = obj.str("title")
    lang = obj.str("lang")
    rate = obj.str("rate").toFloatOrNull()?.coerceIn(0.5f, 2.5f) ?: 1f
    items.clear()
    addItems(obj)
    more = obj.str("more") == "true"
    at = 0
    gen++
    saveQueue(json, fresh = true)
    if (items.isEmpty() && !more) return@onMain
    playing = true
    acquire()
    speak()
  }

  /** More of the same list; `more:false` on the last part. */
  fun append(json: String) =
    onMain {
      val obj = parse(json) ?: return@onMain
      if (obj.str("q") != queue) return@onMain
      addItems(obj)
      more = obj.str("more") == "true"
      saveQueue(json, fresh = false)
      if (waiting && playing) speak()
    }

  /** pause, resume, toggle, next, prev (paragraphs), faster, slower, rate <x>, stop, state. */
  fun ctl(
    context: Context,
    cmd: String,
    arg: String = "",
  ) = onMain {
    app = context.applicationContext
    if (items.isEmpty() && cmd in setOf("resume", "toggle", "next", "prev")) restore()
    when (cmd) {
      "pause" -> if (playing) pause()
      "resume" -> if (!playing) resume()
      "toggle" -> if (playing) pause() else resume()
      "next" -> paragraph(1)
      "prev" -> paragraph(-1)
      "faster" -> step(1)
      "slower" -> step(-1)
      "rate" -> arg.toFloatOrNull()?.let { setRate(it) }
      "stop" -> stop()
      "state" -> report("state")
      else -> Log.d(TAG, "unknown reader command ${cmd.take(20)}")
    }
  }

  // ---- reading --------------------------------------------------------------------------------

  private fun speak() {
    main.removeCallbacks(nextTick)
    if (!playing) return
    val item = items.getOrNull(at)
    if (item == null) {
      if (more) {
        waiting = true // the page is still working through the document
        update("at")
      } else {
        finish()
      }
      return
    }
    waiting = false
    val myGen = gen
    val id = "$myGen:$at"
    withEngine { tts ->
      if (myGen != gen || !playing) return@withEngine
      if (voiceSet != lang) {
        voiceSet = lang
        val named = if (lang.startsWith("voice:")) runCatching { tts.voices }.getOrNull()?.firstOrNull { it.name == lang.removePrefix("voice:") } else null
        if (named != null) tts.voice = named else JarvisTts.pickVoice(tts, Locale.forLanguageTag(lang.ifBlank { "en-GB" }))
      }
      tts.setSpeechRate(rate)
      if (tts.speak(item.text, TextToSpeech.QUEUE_FLUSH, null, id) != TextToSpeech.SUCCESS) fail("the phone's speech engine refused the sentence")
    }
    update("at")
  }

  private fun sentenceDone(id: String) {
    if (!playing || id != "$gen:$at") return
    val extra =
      when (items.getOrNull(at)?.pause) {
        "para" -> 0.5f * GAP
        "head" -> 2f - GAP
        else -> 0f
      }
    at++
    if (extra > 0f) main.postDelayed(nextTick, (1000f * extra / rate).toLong()) else speak()
  }

  private fun pause(keepFocus: Boolean = false) {
    playing = false
    gen++
    main.removeCallbacks(nextTick)
    if (engineReady) engine?.stop()
    release(keepFocus)
    main.removeCallbacks(idleStop)
    main.postDelayed(idleStop, IDLE_STOP_MS)
    update("paused")
  }

  private fun resume() {
    if (items.isEmpty()) return
    if (at >= items.size) at = items.size - 1
    playing = true
    gen++
    acquire()
    speak()
  }

  private fun finish() {
    playing = false
    gen++
    at = (items.size - 1).coerceAtLeast(0)
    release(false)
    update("ended")
    foreground(false)
  }

  private fun fail(message: String) {
    Log.w(TAG, "reading stopped: $message")
    playing = false
    gen++
    release(false)
    update("error", message)
  }

  /** Reading is over: the notification goes, the list leaves memory (its file stays for the cover panel). */
  private fun stop() {
    playing = false
    gen++
    main.removeCallbacks(nextTick)
    main.removeCallbacks(idleStop)
    if (engineReady) engine?.stop()
    release(false)
    update("stopped")
    foreground(false)
    session?.release()
    session = null
    engine?.shutdown()
    engine = null
    engineReady = false
    voiceSet = null
    items.clear()
  }

  /** The start of the next paragraph, the start of this one, or (already at its start) of the one before. */
  private fun paragraph(dir: Int) {
    if (items.isEmpty()) return
    val here = at.coerceIn(0, items.size - 1)
    val para = items[here].para
    var start = here
    while (start > 0 && items[start - 1].para == para) start--
    val target =
      if (dir > 0) {
        var i = here
        while (i < items.size && items[i].para == para) i++
        if (i >= items.size) return
        i
      } else if (here > start || start == 0) {
        start
      } else {
        var i = start - 1
        val before = items[i].para
        while (i > 0 && items[i - 1].para == before) i--
        i
      }
    at = target
    gen++
    if (playing) speak() else update("paused")
  }

  private fun step(dir: Int) {
    var nearest = 0
    for (i in STEPS.indices) if (kotlin.math.abs(STEPS[i] - rate) < kotlin.math.abs(STEPS[nearest] - rate)) nearest = i
    setRate(STEPS[(nearest + dir).coerceIn(0, STEPS.size - 1)])
  }

  private fun setRate(value: Float) {
    rate = value.coerceIn(0.5f, 2.5f)
    if (playing) {
      gen++ // the sentence starts again at the new speed, so the change is heard at once
      speak()
    } else {
      update("paused")
    }
  }

  // ---- the phone's side: engine, focus, wake lock, session, notification ------------------------

  private fun withEngine(action: (TextToSpeech) -> Unit) {
    val c = app ?: return
    val ready = engine
    if (ready != null && engineReady) return action(ready)
    engineWaiting.add(action)
    if (ready != null) return
    engine =
      TextToSpeech(c) { status ->
        main.post {
          val tts = engine
          if (status != TextToSpeech.SUCCESS || tts == null) {
            engineWaiting.clear()
            engine = null
            fail("this phone has no working text-to-speech engine")
            return@post
          }
          tts.setAudioAttributes(audioAttributes)
          tts.setOnUtteranceProgressListener(
            object : UtteranceProgressListener() {
              override fun onStart(utteranceId: String?) {}

              override fun onDone(utteranceId: String?) {
                main.post { sentenceDone(utteranceId.orEmpty()) }
              }

              @Deprecated("Deprecated in Java")
              override fun onError(utteranceId: String?) {
                main.post { if (utteranceId == "$gen:$at") fail("the phone's speech engine failed") }
              }

              override fun onError(
                utteranceId: String?,
                errorCode: Int,
              ) {
                main.post { if (utteranceId == "$gen:$at") fail("the phone's speech engine failed (code $errorCode)") }
              }
            },
          )
          engineReady = true
          val queued = engineWaiting.toList()
          engineWaiting.clear()
          queued.forEach { it(tts) }
        }
      }
  }

  private fun acquire() {
    val c = app ?: return
    main.removeCallbacks(idleStop)
    if (wake == null) {
      wake = c.getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "jarvis:reader").apply { setReferenceCounted(false) }
    }
    runCatching { wake?.acquire(6 * 60 * 60_000L) }
    val audio = c.getSystemService(AudioManager::class.java)
    val request =
      focus ?: AudioFocusRequest
        .Builder(AudioManager.AUDIOFOCUS_GAIN)
        .setAudioAttributes(audioAttributes)
        .setOnAudioFocusChangeListener(focusListener, main)
        .build()
        .also { focus = it }
    audio.requestAudioFocus(request)
    if (!noisyOn) {
      c.registerReceiver(noisyReceiver, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY))
      noisyOn = true
    }
    ensureSession(c)
    claimMediaButtons()
    foreground(true)
  }

  private fun release(keepFocus: Boolean) {
    val c = app ?: return
    runCatching { if (wake?.isHeld == true) wake?.release() }
    if (!keepFocus) focus?.let { c.getSystemService(AudioManager::class.java).abandonAudioFocusRequest(it) }
    if (noisyOn) {
      runCatching { c.unregisterReceiver(noisyReceiver) }
      noisyOn = false
    }
  }

  // Android gives the headset buttons to the app that last played sound from its OWN process. The
  // voice is played by the speech engine's process, so a moment of silence from here claims them.
  private fun claimMediaButtons() {
    runCatching {
      val rate = 8000
      val frames = rate / 10
      val track =
        AudioTrack
          .Builder()
          .setAudioAttributes(audioAttributes)
          .setAudioFormat(
            AudioFormat
              .Builder()
              .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
              .setSampleRate(rate)
              .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
              .build(),
          ).setTransferMode(AudioTrack.MODE_STATIC)
          .setBufferSizeInBytes(frames * 2)
          .build()
      track.write(ShortArray(frames), 0, frames)
      track.play()
      main.postDelayed({ runCatching { track.release() } }, 600)
    }.onFailure { Log.w(TAG, "silent clip failed: ${it.message}") }
  }

  private fun ensureSession(c: Context) {
    if (session != null) return
    session =
      MediaSession(c, "JarvisReader").apply {
        setCallback(
          object : MediaSession.Callback() {
            override fun onPlay() {
              if (!playing) resume()
            }

            override fun onPause() {
              if (playing) pause()
            }

            override fun onSkipToNext() = paragraph(1)

            override fun onSkipToPrevious() = paragraph(-1)

            override fun onFastForward() = step(1)

            override fun onRewind() = step(-1)

            override fun onStop() = stop()

            override fun onCustomAction(
              action: String,
              extras: android.os.Bundle?,
            ) {
              when (action) {
                "slower" -> step(-1)
                "faster" -> step(1)
              }
            }
          },
          main,
        )
        isActive = true
      }
  }

  private fun rateLabel(): String = rate.toString().removeSuffix(".0")

  private fun pageLine(): String {
    val item = items.getOrNull(at.coerceAtMost(items.size - 1))
    return if (item != null) "Page ${item.page} · ${rateLabel()}×" else "${rateLabel()}×"
  }

  /** New state: the session, the notification, the cover panel, the kept place and the page all hear it. */
  private fun update(
    state: String,
    message: String = "",
  ) {
    val c = app ?: return
    val item = items.getOrNull(at.coerceAtMost(items.size - 1))
    session?.let { s ->
      s.setPlaybackState(
        PlaybackState
          .Builder()
          .setActions(
            PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE or
              PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SKIP_TO_PREVIOUS or
              PlaybackState.ACTION_FAST_FORWARD or PlaybackState.ACTION_REWIND or PlaybackState.ACTION_STOP,
          ).addCustomAction(PlaybackState.CustomAction.Builder("slower", "Slower", R.drawable.ic_reader_slower).build())
          .addCustomAction(PlaybackState.CustomAction.Builder("faster", "Faster", R.drawable.ic_reader_faster).build())
          .setState(if (playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED, PlaybackState.PLAYBACK_POSITION_UNKNOWN, if (playing) rate else 0f)
          .build(),
      )
      s.setMetadata(
        MediaMetadata
          .Builder()
          .putString(MediaMetadata.METADATA_KEY_TITLE, title.ifBlank { "Reading" })
          .putString(MediaMetadata.METADATA_KEY_ARTIST, pageLine())
          .putString(MediaMetadata.METADATA_KEY_ALBUM, "TinkerClaw reader")
          .build(),
      )
    }
    if (foregroundOn) {
      runCatching { c.getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(c)) }
    }
    if (item != null) {
      c
        .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        .edit()
        .putString("q", queue)
        .putString("doc", doc)
        .putString("title", title)
        .putString("text", item.text.take(240))
        .putInt("at", at)
        .putInt("page", item.page)
        .putInt("listPage", item.listPage)
        .putInt("listIdx", item.listIdx)
        .putInt("from", item.from)
        .putFloat("rate", rate)
        .putLong("ts", System.currentTimeMillis())
        .apply()
    }
    runCatching { JarvisCoverWidget.refresh(c) }.onFailure { Log.w(TAG, "cover panel update failed: ${it.message}") }
    report(state, message)
  }

  /** Tells the page where the reading is. With no list in memory it answers from the kept place. */
  private fun report(
    state: String,
    message: String = "",
  ) {
    val send = emit ?: return
    val c = app ?: return
    val fields = mutableMapOf<String, JsonElement>("ev" to JsonPrimitive("reader"), "state" to JsonPrimitive(state))
    val item = items.getOrNull(at.coerceAtMost(items.size - 1))
    if (item != null) {
      fields["q"] = JsonPrimitive(queue)
      fields["doc"] = JsonPrimitive(doc)
      fields["page"] = JsonPrimitive(item.listPage)
      fields["idx"] = JsonPrimitive(item.listIdx)
      if (item.from >= 0) fields["from"] = JsonPrimitive(item.from)
      fields["active"] = JsonPrimitive(true)
    } else {
      val p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      if (p.contains("listPage")) {
        fields["doc"] = JsonPrimitive(p.getString("doc", "").orEmpty())
        fields["page"] = JsonPrimitive(p.getInt("listPage", 0))
        fields["idx"] = JsonPrimitive(p.getInt("listIdx", 0))
        fields["ts"] = JsonPrimitive(p.getLong("ts", 0))
      }
      fields["active"] = JsonPrimitive(false)
    }
    fields["playing"] = JsonPrimitive(playing)
    fields["rate"] = JsonPrimitive(rateLabel())
    if (message.isNotEmpty()) fields["message"] = JsonPrimitive(message)
    runCatching { send(JsonObject(fields).toString()) }
  }

  fun snapshot(context: Context): Snapshot {
    val item = items.getOrNull(at.coerceAtMost(items.size - 1))
    if (item != null) return Snapshot(title, "Page ${item.page}", item.text, "${rateLabel()}×", playing)
    val p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val kept = p.getFloat("rate", 1f).toString().removeSuffix(".0")
    return Snapshot(
      p.getString("title", "").orEmpty(),
      if (p.contains("page")) "Page ${p.getInt("page", 0)}" else "",
      p.getString("text", "").orEmpty(),
      "$kept×",
      false,
    )
  }

  fun pending(
    context: Context,
    cmd: String,
  ): PendingIntent =
    PendingIntent.getBroadcast(
      context,
      cmd.hashCode(),
      Intent(context, JarvisReaderReceiver::class.java).setAction("ai.openclaw.app.reader.$cmd").putExtra(EXTRA_CMD, cmd),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

  fun commandOf(intent: Intent): String = intent.getStringExtra(EXTRA_CMD).orEmpty()

  fun notification(context: Context): Notification {
    val c = context.applicationContext
    val manager = c.getSystemService(NotificationManager::class.java)
    if (manager.getNotificationChannel(CHANNEL_ID) == null) {
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "Reading aloud", NotificationManager.IMPORTANCE_LOW).apply { setShowBadge(false) },
      )
    }
    val open =
      PendingIntent.getActivity(
        c,
        NOTIFICATION_ID,
        Intent(c, MainActivity::class.java).setAction(Intent.ACTION_MAIN).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )

    fun action(
      icon: Int,
      label: String,
      cmd: String,
    ) = Notification.Action.Builder(Icon.createWithResource(c, icon), label, pending(c, cmd)).build()
    val style = Notification.MediaStyle().setShowActionsInCompactView(1, 2, 3)
    session?.let { style.setMediaSession(it.sessionToken) }
    return Notification
      .Builder(c, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_reader_play)
      .setContentTitle(title.ifBlank { "Reading" })
      .setContentText(pageLine())
      .setContentIntent(open)
      .setVisibility(Notification.VISIBILITY_PUBLIC)
      .setOngoing(playing)
      .setOnlyAlertOnce(true)
      .setDeleteIntent(pending(c, "stop"))
      .addAction(action(R.drawable.ic_reader_slower, "Slower", "slower"))
      .addAction(action(R.drawable.ic_reader_prev, "Previous paragraph", "prev"))
      .addAction(if (playing) action(R.drawable.ic_reader_pause, "Pause", "pause") else action(R.drawable.ic_reader_play, "Read", "resume"))
      .addAction(action(R.drawable.ic_reader_next, "Next paragraph", "next"))
      .addAction(action(R.drawable.ic_reader_faster, "Faster", "faster"))
      .setStyle(style)
      .build()
  }

  private fun foreground(on: Boolean) {
    val c = app ?: return
    if (on) {
      if (foregroundOn) return
      foregroundOn = true
      runCatching { c.startForegroundService(Intent(c, JarvisReaderService::class.java)) }
        .onFailure {
          // Android refused a service start from the background: reading goes on while the app lives.
          Log.w(TAG, "reader service did not start: ${it.message}")
          runCatching { c.getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(c)) }
        }
    } else if (foregroundOn) {
      foregroundOn = false
      c.stopService(Intent(c, JarvisReaderService::class.java))
      runCatching { c.getSystemService(NotificationManager::class.java).cancel(NOTIFICATION_ID) }
    }
  }

  // ---- the list, parsed and kept ----------------------------------------------------------------

  private fun parse(json: String): JsonObject? =
    runCatching { Json.parseToJsonElement(json) as? JsonObject }.onFailure { Log.w(TAG, "bad reading list: ${it.message}") }.getOrNull()

  private fun JsonObject.str(key: String): String = (this[key] as? JsonPrimitive)?.content.orEmpty()

  private fun addItems(obj: JsonObject) {
    val list = obj["items"] as? JsonArray ?: return
    for (row in list) {
      val a = row as? JsonArray ?: continue

      fun s(i: Int) = (a.getOrNull(i) as? JsonPrimitive)?.content.orEmpty()
      val text = s(0)
      if (text.isBlank()) continue
      items.add(Item(text, s(1).toIntOrNull() ?: 0, s(2), s(3).toIntOrNull() ?: 0, s(4).toIntOrNull() ?: 0, s(5).toIntOrNull() ?: 0, s(6).toIntOrNull() ?: -1))
    }
  }

  private fun saveQueue(
    json: String,
    fresh: Boolean,
  ) {
    val c = app ?: return
    val file = File(c.filesDir, QUEUE_FILE)
    val line = json.replace("\n", " ") + "\n"
    disk.execute {
      runCatching { if (fresh) file.writeText(line) else file.appendText(line) }.onFailure { Log.w(TAG, "keeping the reading list failed: ${it.message}") }
    }
  }

  /** After Android dropped the app: the kept list and the kept place, so the cover panel can go on. */
  private fun restore() {
    val c = app ?: return
    val file = File(c.filesDir, QUEUE_FILE)
    if (!file.exists()) return
    val p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    runCatching {
      file.useLines { lines ->
        for ((n, line) in lines.withIndex()) {
          val obj = parse(line) ?: continue
          if (n == 0) {
            queue = obj.str("q")
            doc = obj.str("doc")
            title = obj.str("title")
            lang = obj.str("lang")
          } else if (obj.str("q") != queue) {
            continue
          }
          addItems(obj)
        }
      }
    }.onFailure { Log.w(TAG, "reading the kept list failed: ${it.message}") }
    more = false
    if (p.getString("q", "") == queue) {
      at = p.getInt("at", 0).coerceIn(0, (items.size - 1).coerceAtLeast(0))
      rate = p.getFloat("rate", 1f)
    } else {
      at = 0
    }
  }
}

/** Keeps the reading alive behind the lock screen, and carries its media notification. */
class JarvisReaderService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(
    intent: Intent?,
    flags: Int,
    startId: Int,
  ): Int {
    runCatching {
      ServiceCompat.startForeground(this, JarvisReader.NOTIFICATION_ID, JarvisReader.notification(this), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
    }.onFailure {
      Log.w("JarvisReader", "foreground start failed: ${it.message}")
      stopSelf()
    }
    if (!JarvisReader.hasQueue) {
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf()
    }
    return START_NOT_STICKY
  }
}

/** The buttons of the notification and of the cover panel. */
class JarvisReaderReceiver : BroadcastReceiver() {
  override fun onReceive(
    context: Context,
    intent: Intent,
  ) {
    val cmd = JarvisReader.commandOf(intent)
    if (cmd.isNotEmpty()) JarvisReader.ctl(context, cmd)
  }
}
