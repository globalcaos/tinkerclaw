package ai.openclaw.app.jarvis

import ai.openclaw.app.MainActivity
import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.VibratorManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// FORK 2026-10-19 (the architect: phone app) — window.JarvisNative, the page's way into the app.
// addJavascriptInterface would put the object into EVERY frame, including the sandboxed srcdoc
// iframes Tinker renders model-written HTML in. So the app exposes only a message port
// (WebViewCompat.addWebMessageListener, allowed for the door origin, checked per frame) and the
// document-start script builds window.JarvisNative on top of it, in the door's top frame only.
// The native side also drops any message that is not from the door's main frame.

/** Native screens the page may open through JarvisNative.openNative(name). */
enum class JarvisScreen(
  val bridgeName: String,
) {
  Tinker("tinker"),
  Trip("trip"),
  Terminal("terminal"),
  Connect("connect"),
  Voice("voice"),
  Screen("screen"),
  Settings("settings"),
  ;

  companion object {
    fun fromBridgeName(name: String?): JarvisScreen? {
      val key = name?.trim()?.lowercase().orEmpty()
      return entries.firstOrNull { it.bridgeName == key }
    }
  }
}

/** One JarvisNative call as the page posts it: {"m": "copyText", "a": ["text"]}. */
data class JarvisBridgeCall(
  val method: String,
  val args: List<String?>,
)

private const val MAX_BRIDGE_MESSAGE_CHARS = 1_000_000

fun parseJarvisBridgeCall(raw: String?): JarvisBridgeCall? {
  if (raw.isNullOrEmpty() || raw.length > MAX_BRIDGE_MESSAGE_CHARS) return null
  val obj = runCatching { Json.parseToJsonElement(raw) as? JsonObject }.getOrNull() ?: return null
  val method = (obj["m"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
  val args =
    when (val a = obj["a"]) {
      null -> emptyList()
      is JsonArray -> a.map { (it as? JsonPrimitive)?.takeUnless { p -> p is JsonNull }?.content }
      else -> return null
    }
  return JarvisBridgeCall(method, args)
}

class JarvisNativeBridge(
  private val context: Context,
  private val onOpenNative: (JarvisScreen) -> Unit,
) {
  private val main = Handler(Looper.getMainLooper())

  // 2026-10-21: replies to the page (the phone voice's done/error) go back on the port the last
  // message came in on; the page turns them into a "jarvis-native" event.
  private var reply: ((String) -> Unit)? = null
  private var tts: JarvisTts? = null

  private fun voice(): JarvisTts =
    tts ?: JarvisTts(context) { id, state, message ->
      val msg =
        JsonObject(
          mapOf("ev" to JsonPrimitive("tts"), "id" to JsonPrimitive(id), "state" to JsonPrimitive(state), "message" to JsonPrimitive(message)),
        ).toString()
      main.post { runCatching { reply?.invoke(msg) }.onFailure { Log.w(LOG_TAG, "tts reply failed: ${it.message}") } }
    }.also { t ->
      tts = t
      // 2026-10-22: a rendered line goes back as base64 wav; the page adds the metallic chain.
      t.onAudio = { id, bytes ->
        val fields =
          mutableMapOf<String, kotlinx.serialization.json.JsonElement>("ev" to JsonPrimitive("tts-audio"), "id" to JsonPrimitive(id))
        if (bytes != null) fields["b64"] = JsonPrimitive(android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP))
        val msg = JsonObject(fields).toString()
        main.post { runCatching { reply?.invoke(msg) }.onFailure { Log.w(LOG_TAG, "tts audio reply failed: ${it.message}") } }
      }
    }

  /** Releases the phone voice; the WebView that owned this bridge is gone. */
  fun close() {
    tts?.shutdown()
    tts = null
  }

  /** A message the door's main frame posted on the port. The caller has checked the sender. */
  fun dispatch(
    raw: String?,
    replyTo: ((String) -> Unit)? = null,
  ) {
    val call = parseJarvisBridgeCall(raw) ?: return
    val first = call.args.getOrNull(0)
    if (replyTo != null) reply = replyTo
    when (call.method) {
      "speak" ->
        voice().speak(
          id = first.orEmpty(),
          text = call.args.getOrNull(1).orEmpty(),
          rate = call.args.getOrNull(2)?.toFloatOrNull() ?: 1f,
          language = call.args.getOrNull(3).orEmpty(),
        )
      "synth" ->
        voice().synth(
          id = first.orEmpty(),
          text = call.args.getOrNull(1).orEmpty(),
          rate = call.args.getOrNull(2)?.toFloatOrNull() ?: 1f,
          language = call.args.getOrNull(3).orEmpty(),
        )
      "stopSpeaking" -> tts?.stop()
      "voices" ->
        voice().voices { list ->
          val arr =
            JsonArray(
              list.map {
                JsonObject(
                  mapOf(
                    "name" to JsonPrimitive(it.name),
                    "locale" to JsonPrimitive(it.locale.toLanguageTag()),
                    "quality" to JsonPrimitive(it.quality),
                    "network" to JsonPrimitive(it.isNetworkConnectionRequired),
                    "installed" to JsonPrimitive(!it.features.contains("notInstalled")),
                  ),
                )
              },
            )
          val msg = JsonObject(mapOf("ev" to JsonPrimitive("voices"), "list" to arr)).toString()
          main.post { runCatching { reply?.invoke(msg) } }
        }
      "openNative" -> openNative(first)
      "copyText" -> copyText(first)
      "share" -> share(first)
      "vibrate" -> vibrate(first?.toDoubleOrNull()?.toInt() ?: 0)
      // 2026-10-23: the page's chat drop-down opened ("1") or closed; answer with the update line.
      "sheet" -> {
        ai.openclaw.app.update.pageSheetOpen.value = first == "1"
        val line = ai.openclaw.app.update.updateStatusLine() ?: ""
        val msg = JsonObject(mapOf("ev" to JsonPrimitive("update"), "line" to JsonPrimitive(line))).toString()
        main.post { runCatching { reply?.invoke(msg) } }
      }
      "notify" -> notify(first, call.args.getOrNull(1))
      // 2026-10-23 (layer 1): JarvisNative.buzz/say/play/notify/open/keepAwake, one shape for all:
      // a = [requestId, verb, argsJson]; the answer comes back as {"ev":"verb", id, verb, ok, result|error}.
      "verb" -> verb(first.orEmpty(), call.args.getOrNull(1).orEmpty(), call.args.getOrNull(2))
      else -> Log.d(LOG_TAG, "unknown bridge call ${call.method.take(40)}")
    }
  }

  private fun verb(
    id: String,
    name: String,
    argsJson: String?,
  ) {
    val fields = mutableMapOf<String, kotlinx.serialization.json.JsonElement>("ev" to JsonPrimitive("verb"), "id" to JsonPrimitive(id), "verb" to JsonPrimitive(name))
    runCatching {
      require(name in JarvisVerbs.names) { "unknown verb ${name.take(40)}" }
      val args = argsJson?.takeIf { it.isNotBlank() }?.let { Json.parseToJsonElement(it) as? JsonObject } ?: JsonObject(emptyMap())
      JarvisVerbs.run(context, name, args)
    }.fold(
      onSuccess = {
        fields["ok"] = JsonPrimitive(true)
        fields["result"] = it
      },
      onFailure = {
        Log.w(LOG_TAG, "verb $name failed: ${it.message}")
        fields["ok"] = JsonPrimitive(false)
        fields["error"] = JsonPrimitive(it.message ?: it.javaClass.simpleName)
      },
    )
    val msg = JsonObject(fields).toString()
    main.post { runCatching { reply?.invoke(msg) } }
  }

  private fun openNative(screen: String?) {
    val target = JarvisScreen.fromBridgeName(screen) ?: return
    main.post { onOpenNative(target) }
  }

  private fun copyText(text: String?) {
    val value = text.orEmpty()
    main.post {
      val clipboard = context.getSystemService(ClipboardManager::class.java) ?: return@post
      clipboard.setPrimaryClip(ClipData.newPlainText("Jarvis", value))
    }
  }

  private fun share(text: String?) {
    val value = text.orEmpty().ifBlank { return }
    main.post {
      val send =
        Intent(Intent.ACTION_SEND)
          .setType("text/plain")
          .putExtra(Intent.EXTRA_TEXT, value)
      val chooser = Intent.createChooser(send, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      runCatching { context.startActivity(chooser) }
    }
  }

  private fun vibrate(ms: Int) {
    val duration = ms.coerceIn(1, 2_000).toLong()
    runCatching {
      val vibrator = context.getSystemService(VibratorManager::class.java)?.defaultVibrator ?: return
      vibrator.vibrate(VibrationEffect.createOneShot(duration, VibrationEffect.DEFAULT_AMPLITUDE))
    }.onFailure { Log.w(LOG_TAG, "vibrate failed: ${it.message}") }
  }

  private fun notify(
    title: String?,
    body: String?,
  ) {
    JarvisNotifications.post(context, title.orEmpty().ifBlank { "Jarvis" }, body.orEmpty())
  }

  companion object {
    const val NAME = "JarvisNative"

    /** The message port the app injects; only the document-start script should touch it. */
    const val PORT_NAME = "__jarvisNativePort"
    const val LOG_TAG = "JarvisWebView"
  }
}

/**
 * Runs before the page's own scripts: marks the document as the app (Tinker's phone mode keys on
 * html.jarvis-app), builds window.JarvisNative on the message port in the top frame only and,
 * because plain HTTP over Tailscale is not a secure context, gives navigator.clipboard.writeText a
 * native fallback.
 */
fun jarvisDocumentStartScript(
  versionName: String,
  versionCode: Int,
): String {
  val version = JsonPrimitive(versionName).toString()
  val nativeName = JarvisNativeBridge.NAME
  val portName = JarvisNativeBridge.PORT_NAME
  return """
    (function () {
      try {
        window.__JARVIS_APP__ = { platform: "android", version: $version, versionCode: $versionCode };
        var mark = function () {
          if (document.documentElement) document.documentElement.classList.add("jarvis-app");
        };
        mark();
        document.addEventListener("DOMContentLoaded", mark, { once: true });
        if (window.top !== window) return;
        if (!window.$nativeName) {
          var send = function (m, a) {
            var port = window.$portName;
            if (port) port.postMessage(JSON.stringify({ m: m, a: a }));
          };
          var str = function (v) { return v == null ? "" : String(v); };
          var seq = 0;
          var verb = function (name, args) {
            var id = "v" + (++seq);
            send("verb", [id, name, JSON.stringify(args)]);
            return id;
          };
          var api = {
            isApp: function () { return true; },
            appVersion: function () { return JSON.stringify({ versionName: $version, versionCode: $versionCode }); },
            openNative: function (screen) { send("openNative", [str(screen)]); },
            copyText: function (text) { send("copyText", [str(text)]); },
            share: function (text) { send("share", [str(text)]); },
            vibrate: function (ms) { send("vibrate", [Number(ms) || 0]); },
            sheet: function (open) { send("sheet", [open ? "1" : "0"]); },
            // 2026-10-21: the PDF reader speaks with the phone's own voice. Each sentence carries an
            // id; its "done" or "error" comes back as a "jarvis-native" event on this window.
            speak: function (id, text, rate, lang) { send("speak", [str(id), str(text), str(rate), str(lang)]); },
            stopSpeaking: function () { send("stopSpeaking", []); },
            voices: function () { send("voices", []); },
            synth: function (id, text, rate, lang) { send("synth", [str(id), str(text), str(rate), str(lang)]); },
            // 2026-10-23 (layer 1 verbs, JarvisVerbs.kt): the same six actions the Pi and pack scripts
            // use. Each returns its request id; the answer is a "jarvis-native" event {ev:"verb", id, ok}.
            buzz: function (pattern) { return verb("buzz", { pattern: pattern }); },
            say: function (text, voice) { return verb("say", { text: str(text), voice: voice || {} }); },
            play: function (url) { return verb("play", { url: str(url) }); },
            notify: function (title, body, tap) { return verb("notify", { title: str(title), body: str(body), tap: str(tap) }); },
            open: function (target) { return verb("open", { target: str(target) }); },
            keepAwake: function (minutes) { return verb("keepAwake", { minutes: Number(minutes) || 0 }); },
          };
          var port0 = window.$portName;
          if (port0) {
            port0.onmessage = function (e) {
              try {
                window.dispatchEvent(new CustomEvent("jarvis-native", { detail: JSON.parse(e.data) }));
              } catch (err) {}
            };
          }
          Object.defineProperty(window, "$nativeName", { value: Object.freeze(api), configurable: false, writable: false });
        }
        if (!window.isSecureContext) {
          var write = function (text) {
            window.$nativeName.copyText(String(text));
            return Promise.resolve();
          };
          if (navigator.clipboard) {
            try { navigator.clipboard.writeText = write; } catch (e) {}
          } else {
            Object.defineProperty(navigator, "clipboard", {
              configurable: true,
              value: {
                writeText: write,
                readText: function () { return Promise.reject(new Error("clipboard read is not available")); },
              },
            });
          }
        }
      } catch (e) {}
    })();
    """.trimIndent()
}

/** Local notifications from the app itself, on the channel system.notify already uses. */
object JarvisNotifications {
  private const val CHANNEL_ID = "openclaw.system.notify.active"
  private const val CHANNEL_NAME = "OpenClaw Active"

  fun canPost(context: Context): Boolean {
    if (Build.VERSION.SDK_INT >= 33 &&
      ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
      PackageManager.PERMISSION_GRANTED
    ) {
      return false
    }
    return NotificationManagerCompat.from(context).areNotificationsEnabled()
  }

  fun post(
    context: Context,
    title: String,
    body: String,
    id: Int = (System.currentTimeMillis() and 0x7FFFFFFF).toInt(),
    intentAction: String? = null,
    tap: JarvisOpenTarget? = null,
  ) {
    val appContext = context.applicationContext
    if (!canPost(appContext)) return
    val manager = appContext.getSystemService(NotificationManager::class.java)
    if (manager.getNotificationChannel(CHANNEL_ID) == null) {
      manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_DEFAULT))
    }
    // 2026-10-23: notify {tap} opens that screen or URL (JarvisOpen) instead of just the app.
    val open =
      tap?.let { JarvisOpen.intent(appContext, it) }
        ?: Intent(appContext, MainActivity::class.java)
          .setAction(intentAction ?: Intent.ACTION_MAIN)
          .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    val pending =
      PendingIntent.getActivity(
        appContext,
        id,
        open,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    val notification =
      NotificationCompat
        .Builder(appContext, CHANNEL_ID)
        .setSmallIcon(android.R.drawable.ic_dialog_info)
        .setContentTitle(title)
        .setContentText(body)
        .setStyle(NotificationCompat.BigTextStyle().bigText(body))
        .setContentIntent(pending)
        .setAutoCancel(true)
        .build()
    try {
      NotificationManagerCompat.from(appContext).notify(id, notification)
    } catch (_: SecurityException) {
      // Permission revoked between the check and the post.
    }
  }
}
