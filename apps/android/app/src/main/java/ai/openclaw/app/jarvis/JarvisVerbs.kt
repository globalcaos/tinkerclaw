package ai.openclaw.app.jarvis

import ai.openclaw.app.MainActivity
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.VibratorManager
import android.util.Log
import android.view.WindowManager
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

/**
 * FORK 2026-10-23 (plan "phone app self-update", layer 1; the architect 17:45 "Build it"). The fixed set of
 * phone actions that the page (JarvisNative.buzz/say/play/notify/open/keepAwake), the Pi (node
 * commands jarvis.<verb>) and content-pack scripts (JarvisScript) all share, so a new phone feature is
 * a page, Pi or pack change instead of a new APK. Each verb takes a JSON object and answers one.
 * Bad input throws IllegalArgumentException; the callers turn it into their own error shape.
 */
object JarvisVerbs {
  val names = setOf("buzz", "say", "play", "notify", "open", "keepAwake", "badge")
  private const val TAG = "JarvisVerbs"

  fun run(
    context: Context,
    verb: String,
    args: JsonObject,
  ): JsonObject {
    val app = context.applicationContext
    return when (verb) {
      "buzz" -> buzz(app, buzzTimings(args["pattern"]))
      "say" -> {
        val text = args.string("text")?.trim().orEmpty()
        require(text.isNotEmpty()) { "say: text is required" }
        val voice = args["voice"] as? JsonObject
        JarvisSay.say(
          app,
          text.take(500),
          buzz = args.bool("buzz") ?: false,
          speed = voice?.get("speed")?.let { (it as? JsonPrimitive)?.doubleOrNull },
          voiceName = voice?.string("name"),
          fx = voice?.bool("fx") ?: true,
        )
        obj("queued" to JsonPrimitive(true))
      }
      "play" -> JarvisPlay.play(app, args.string("url").orEmpty())
      "notify" -> {
        val tap = args.string("tap")?.takeIf { it.isNotBlank() }?.let(::parseOpenTarget)
        val title = args.string("title")?.ifBlank { null } ?: "Jarvis"
        JarvisNotifications.post(app, title, args.string("body").orEmpty(), tap = tap)
        obj("posted" to JsonPrimitive(JarvisNotifications.canPost(app)))
      }
      "open" -> JarvisOpen.open(app, parseOpenTarget(args.string("target") ?: args.string("screen") ?: args.string("url")))
      "keepAwake" -> JarvisAwake.keep(app, (args["minutes"] as? JsonPrimitive)?.doubleOrNull ?: 0.0)
      // 2026-10-28: the app icon's number = Tinker chats with an unread result (JarvisBadge.kt).
      "badge" -> {
        val count = (args["count"] as? JsonPrimitive)?.longOrNull
        requireNotNull(count) { "badge: count is required" }
        val titles = (args["titles"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.content?.take(80) }.orEmpty()
        JarvisBadge.set(app, count.toInt().coerceIn(0, 999), titles)
      }
      else -> throw IllegalArgumentException("unknown verb ${verb.take(40)}")
    }
  }

  private fun buzz(
    context: Context,
    timings: LongArray,
  ): JsonObject {
    val vibrator = context.getSystemService(VibratorManager::class.java)?.defaultVibrator
    requireNotNull(vibrator) { "buzz: no vibrator" }
    // timings = [0, on, off, on, ...]: the same shape VibrationEffect.createWaveform takes.
    val effect =
      if (timings.size == 2) {
        VibrationEffect.createOneShot(timings[1], VibrationEffect.DEFAULT_AMPLITUDE)
      } else {
        VibrationEffect.createWaveform(timings, -1)
      }
    vibrator.vibrate(effect)
    return obj("buzzed" to JsonPrimitive(true), "ms" to JsonPrimitive(timings.sum()))
  }

  private fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

  private fun JsonObject.bool(key: String): Boolean? = (this[key] as? JsonPrimitive)?.booleanOrNull

  internal fun obj(vararg pairs: Pair<String, JsonElement>): JsonObject = JsonObject(mapOf(*pairs))

  internal fun log(message: String) = Log.i(TAG, message)
}

/**
 * buzz {pattern}: a number (one buzz of that many ms) or [on, off, on, ...] in ms. Returns the
 * waveform timings with the leading 0 delay. At most 20 steps and 10 s in all, each step 1-2000 ms.
 */
internal fun buzzTimings(pattern: JsonElement?): LongArray {
  val steps =
    when (pattern) {
      null, JsonNull -> listOf(180L)
      is JsonPrimitive -> listOf(pattern.longOrNull ?: pattern.doubleOrNull?.toLong() ?: throw IllegalArgumentException("buzz: pattern is not a number"))
      is JsonArray ->
        pattern.map {
          (it as? JsonPrimitive)?.let { p -> p.longOrNull ?: p.doubleOrNull?.toLong() }
            ?: throw IllegalArgumentException("buzz: pattern holds a non-number")
        }
      else -> throw IllegalArgumentException("buzz: pattern must be a number or a list")
    }
  require(steps.isNotEmpty() && steps.size <= 20) { "buzz: 1 to 20 steps" }
  val clamped = steps.map { it.coerceIn(1L, 2_000L) }
  require(clamped.sum() <= 10_000L) { "buzz: longer than 10 s" }
  return (listOf(0L) + clamped).toLongArray()
}

/** Where open {target} and a notification tap go: a native screen, or a URL. */
sealed interface JarvisOpenTarget {
  data class Screen(
    val screen: JarvisScreen,
  ) : JarvisOpenTarget

  data class Url(
    val url: String,
  ) : JarvisOpenTarget
}

/** "tinker", "trip", ... (JarvisScreen) or an http(s) URL; a path ("/tinker/...") is on the door. */
internal fun parseOpenTarget(raw: String?): JarvisOpenTarget {
  val value = raw?.trim().orEmpty()
  require(value.isNotEmpty()) { "open: target is required" }
  JarvisScreen.fromBridgeName(value)?.let { return JarvisOpenTarget.Screen(it) }
  if (value.startsWith("/") && !value.startsWith("//")) return JarvisOpenTarget.Url(value)
  val scheme = value.substringBefore(':', "").lowercase()
  require(scheme == "http" || scheme == "https") { "open: not a screen or an http(s) URL" }
  return JarvisOpenTarget.Url(value)
}

/** A door path ("/tinker/x") becomes a full URL on the door in use; anything else is left alone. */
internal fun resolveOnDoor(
  url: String,
  door: String?,
): String? =
  when {
    url.startsWith("/") && !url.startsWith("//") -> door?.trimEnd('/')?.let { it + url }
    else -> url
  }

/** open: brings the app up on that screen or URL; with the app in the background Android only allows that from a tap. */
object JarvisOpen {
  const val ACTION_OPEN = "ai.openclaw.app.action.JARVIS_OPEN"
  const val EXTRA_SCREEN = "jarvis.open.screen"
  const val EXTRA_URL = "jarvis.open.url"

  fun intent(
    context: Context,
    target: JarvisOpenTarget,
  ): Intent {
    val i =
      Intent(context, MainActivity::class.java)
        .setAction(ACTION_OPEN)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    when (target) {
      is JarvisOpenTarget.Screen -> i.putExtra(EXTRA_SCREEN, target.screen.bridgeName)
      is JarvisOpenTarget.Url -> i.putExtra(EXTRA_URL, target.url)
    }
    return i
  }

  fun open(
    context: Context,
    target: JarvisOpenTarget,
  ): JsonObject {
    val label =
      when (target) {
        is JarvisOpenTarget.Screen -> target.screen.bridgeName
        is JarvisOpenTarget.Url -> target.url
      }
    // Android 14 drops an activity start from the background without a word; a tap is allowed.
    if (JarvisLook.foreground) {
      val started = runCatching { context.startActivity(intent(context, target)) }.isSuccess
      if (started) return JarvisVerbs.obj("opened" to JsonPrimitive(true))
    }
    JarvisNotifications.post(context, "Jarvis", "Tap to open ${label.take(80)}", tap = target)
    return JarvisVerbs.obj("opened" to JsonPrimitive(false), "notified" to JsonPrimitive(true))
  }
}

/** play {url}: one sound at a time on the assistant stream; a door URL carries the device token. */
object JarvisPlay {
  private val main = Handler(Looper.getMainLooper())
  private var player: MediaPlayer? = null

  fun play(
    context: Context,
    raw: String,
  ): JsonObject {
    val url = resolveOnDoor(raw.trim(), JarvisDoor.origin.value) ?: throw IllegalArgumentException("play: no door for a path")
    val uri = Uri.parse(url)
    require(uri.scheme == "http" || uri.scheme == "https") { "play: http(s) URL or door path only" }
    val door = JarvisDoor.origin.value
    val headers = mutableMapOf<String, String>()
    if (door != null && isSameJarvisOrigin(url, door)) {
      (context.applicationContext as? ai.openclaw.app.NodeApp)?.prefs?.loadJarvisDeviceToken()?.let { headers[JARVIS_DEVICE_HEADER] = it }
    }
    main.post {
      stop()
      val attrs =
        AudioAttributes
          .Builder()
          .setUsage(AudioAttributes.USAGE_ASSISTANT)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
          .build()
      val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
      val focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK).setAudioAttributes(attrs).build()
      runCatching {
        player =
          MediaPlayer().apply {
            setAudioAttributes(attrs)
            setDataSource(context, uri, headers)
            setOnPreparedListener {
              audio.requestAudioFocus(focus)
              it.start()
            }
            setOnCompletionListener {
              audio.abandonAudioFocusRequest(focus)
              stop()
            }
            setOnErrorListener { _, what, extra ->
              Log.w("JarvisPlay", "playback error $what/$extra")
              audio.abandonAudioFocusRequest(focus)
              stop()
              true
            }
            prepareAsync()
          }
      }.onFailure { Log.w("JarvisPlay", "play failed: ${it.message}") }
    }
    return JarvisVerbs.obj("playing" to JsonPrimitive(true))
  }

  private fun stop() {
    runCatching { player?.release() }
    player = null
  }
}

/** keepAwake {minutes}: holds the CPU awake (and the screen on while the app is up); 0 lets go. */
object JarvisAwake {
  private val main = Handler(Looper.getMainLooper())
  private var lock: PowerManager.WakeLock? = null
  private var screenSet = false
  private val release = Runnable { clear() }

  fun keep(
    context: Context,
    minutes: Double,
  ): JsonObject {
    val ms = (minutes.coerceIn(0.0, 60.0) * 60_000).toLong()
    main.removeCallbacks(release)
    clear()
    if (ms <= 0L) return JarvisVerbs.obj("awake" to JsonPrimitive(false))
    val pm = context.getSystemService(PowerManager::class.java)
    lock =
      pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "jarvis:keepAwake").apply {
        setReferenceCounted(false)
        acquire(ms)
      }
    val screen = JarvisLook.foreground
    if (screen) {
      screenSet = true
      main.post { JarvisLook.activity()?.window?.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
    }
    main.postDelayed(release, ms)
    return JarvisVerbs.obj("awake" to JsonPrimitive(true), "minutes" to JsonPrimitive(ms / 60_000.0), "screen" to JsonPrimitive(screen))
  }

  private fun clear() {
    runCatching { lock?.takeIf { it.isHeld }?.release() }
    lock = null
    // Only a flag this verb set; the app's own "prevent sleep" setting keeps its own.
    if (screenSet) {
      screenSet = false
      main.post { JarvisLook.activity()?.window?.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
    }
  }
}
