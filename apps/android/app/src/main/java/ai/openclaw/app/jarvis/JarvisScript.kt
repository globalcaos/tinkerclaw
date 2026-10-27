package ai.openclaw.app.jarvis

import android.app.KeyguardManager
import android.content.Context
import android.os.PowerManager
import android.util.Log
import androidx.javascriptengine.IsolateStartupParameters
import androidx.javascriptengine.JavaScriptConsoleCallback
import androidx.javascriptengine.JavaScriptSandbox
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * FORK 2026-10-23 (plan "phone app self-update", layer 2). Runs content-pack scripts in androidx
 * javascriptengine: a V8 isolate in the WebView's own sandbox process, with no network, files, page
 * or Android API. The script sees only the APK's prelude (assets/jarvis-script/prelude.js), whose
 * `jarvis` object queues layer-1 verbs; after the handler returns, this side keeps the calls whose
 * verb is in JarvisVerbs.names and runs them. So logic can change with a pack while the native reach
 * stays what this APK allows. No QuickJS fallback is bundled: the Flip6's WebView has the sandbox
 * (jarvis.pack.status reports "engine"); on a phone without it, packs still bring data (voice-fx.json)
 * and their scripts report "no JS engine".
 */
object JarvisScript {
  private const val TAG = "JarvisScript"
  private const val TIMEOUT_MS = 5_000L
  private const val HEAP_BYTES = 16L * 1024 * 1024
  private const val PRELUDE_ASSET = "jarvis-script/prelude.js"
  const val FACTORY_ASSET_DIR = "pack"

  @Volatile private var sandbox: JavaScriptSandbox? = null
  private val lock = Mutex()

  /** One verb call a script asked for. */
  data class Call(
    val verb: String,
    val args: JsonObject,
  )

  data class Result(
    val handled: Boolean,
    val calls: List<Call>,
    val dropped: Int,
  )

  fun engine(): String = if (runCatching { JavaScriptSandbox.isSupported() }.getOrDefault(false)) "javascriptengine" else "none"

  /** The program one evaluation runs: prelude, the pack's main script, then the event's handler. */
  internal fun program(
    prelude: String,
    main: String,
    event: String,
    ctx: JsonObject,
  ): String = "$prelude\n;\n$main\n;\n__jarvisRun(${JsonPrimitive(event)}, $ctx);\n"

  /** What the program returned, reduced to known verbs with an object of arguments (at most 20). */
  internal fun parseResult(raw: String): Result {
    val obj = Json.parseToJsonElement(raw) as? JsonObject ?: throw IllegalStateException("script returned no object")
    val handled = (obj["handled"] as? JsonPrimitive)?.booleanOrNull ?: false
    val all = (obj["calls"] as? JsonArray).orEmpty()
    val calls =
      all.mapNotNull { e ->
        val c = e as? JsonObject ?: return@mapNotNull null
        val verb = (c["verb"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return@mapNotNull null
        val args = c["args"] as? JsonObject ?: JsonObject(emptyMap())
        if (verb in JarvisVerbs.names) Call(verb, args) else null
      }.take(20)
    return Result(handled, calls, all.size - calls.size)
  }

  /** Battery-free facts a handler may branch on. */
  fun phoneContext(context: Context): JsonObject {
    val pm = context.getSystemService(PowerManager::class.java)
    val kg = context.getSystemService(KeyguardManager::class.java)
    return JsonObject(
      mapOf(
        "interactive" to JsonPrimitive(pm?.isInteractive ?: false),
        "locked" to JsonPrimitive(kg?.isKeyguardLocked ?: false),
        "foreground" to JsonPrimitive(JarvisLook.foreground),
      ),
    )
  }

  private fun read(
    context: Context,
    dir: File?,
    name: String,
  ): String = if (dir != null) File(dir, name).readText() else context.assets.open("$FACTORY_ASSET_DIR/$name").use { it.readBytes().decodeToString() }

  /**
   * Runs `event` in the pack at `dir` (null = the factory pack in the APK). Throws when the script
   * throws, times out or there is no engine; with `execute`, then runs the verbs it asked for.
   */
  suspend fun run(
    context: Context,
    dir: File?,
    event: String,
    data: JsonObject,
    execute: Boolean = true,
  ): JsonObject {
    val app = context.applicationContext
    val manifest = PackManifestReader.read(app, dir)
    val ctx = JsonObject(data + mapOf("event" to JsonPrimitive(event), "phone" to phoneContext(app)))
    val code = program(app.assets.open(PRELUDE_ASSET).use { it.readBytes().decodeToString() }, read(app, dir, manifest.main), event, ctx)
    val result = parseResult(evaluate(app, code))
    if (result.dropped > 0) Log.w(TAG, "$event: dropped ${result.dropped} call(s) that are not layer-1 verbs")
    val done =
      result.calls.map { call ->
        val outcome =
          if (!execute) {
            JsonPrimitive("not run")
          } else {
            runCatching { JarvisVerbs.run(app, call.verb, call.args) }.fold(
              onSuccess = { it },
              onFailure = { JsonObject(mapOf("error" to JsonPrimitive(it.message ?: it.javaClass.simpleName))) },
            )
          }
        JsonObject(mapOf("verb" to JsonPrimitive(call.verb), "result" to outcome))
      }
    val fields =
      mutableMapOf<String, JsonElement>(
        "event" to JsonPrimitive(event),
        "pack" to JsonPrimitive(manifest.version),
        "handled" to JsonPrimitive(result.handled),
        "calls" to JsonArray(done),
      )
    return JsonObject(fields)
  }

  private suspend fun evaluate(
    context: Context,
    code: String,
  ): String =
    lock.withLock {
      withContext(Dispatchers.IO) {
        if (!JavaScriptSandbox.isSupported()) throw IllegalStateException("no JS engine on this phone")
        val sb = sandbox ?: JavaScriptSandbox.createConnectedInstanceAsync(context).get(10, TimeUnit.SECONDS).also { sandbox = it }
        val params = IsolateStartupParameters()
        if (sb.isFeatureSupported(JavaScriptSandbox.JS_FEATURE_ISOLATE_MAX_HEAP_SIZE)) params.setMaxHeapSizeBytes(HEAP_BYTES)
        val isolate =
          try {
            sb.createIsolate(params)
          } catch (err: Throwable) {
            // The sandbox process died (WebView update, memory): reconnect on the next run.
            runCatching { sb.close() }
            sandbox = null
            throw err
          }
        try {
          if (sb.isFeatureSupported(JavaScriptSandbox.JS_FEATURE_CONSOLE_MESSAGING)) {
            isolate.setConsoleCallback(
              { it.run() },
              JavaScriptConsoleCallback { m -> Log.i(TAG, "console: ${m.message.take(300)}") },
            )
          }
          isolate.evaluateJavaScriptAsync(code).get(TIMEOUT_MS, TimeUnit.MILLISECONDS)
        } finally {
          isolate.close()
        }
      }
    }
}

/** manifest.json of the pack at `dir`, or of the factory pack in the APK. */
internal object PackManifestReader {
  private val json = Json { ignoreUnknownKeys = true }

  fun read(
    context: Context,
    dir: File?,
  ): PackManifest {
    val raw =
      if (dir != null) {
        File(dir, "manifest.json").readText()
      } else {
        context.assets.open("${JarvisScript.FACTORY_ASSET_DIR}/manifest.json").use { it.readBytes().decodeToString() }
      }
    return json.decodeFromString(PackManifest.serializer(), raw)
  }
}
