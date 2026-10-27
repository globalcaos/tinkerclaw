package ai.openclaw.app.jarvis

import ai.openclaw.app.BuildConfig
import ai.openclaw.app.NodeApp
import android.content.Context
import android.net.Uri
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.Request
import java.io.File

/**
 * FORK 2026-10-23 (plan "phone app self-update", layer 2). The content pack on the phone: fetched
 * from <door>/door/app/pack.json at process start and on every Firebase wake (and on demand, node
 * command jarvis.pack.update), checked and switched by PackStore, run by JarvisScript. Each outcome
 * that is not "up to date" is reported to <door>/door/app/pack-installed, which the door audits.
 * The verifying key is baked in at build time (BuildConfig.JARVIS_PACK_KEY, from
 * ~/.config/jarvis-pack/public.b64); a build without it never takes a pack and uses the factory one.
 */
object JarvisPack {
  private const val TAG = "JarvisPack"
  private val lock = Mutex()

  // A wake that also starts the service runs two checks at once; one download is enough.
  private val checkLock = Mutex()
  val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

  @Volatile private var cachedFx: Pair<String, VoiceFx>? = null

  @Volatile private var lastOutcome: String? = null

  @Volatile private var lastCheckAtMs = 0L

  private fun publicKey(): ByteArray? =
    BuildConfig.JARVIS_PACK_KEY
      .takeIf { it.isNotBlank() }
      ?.let { runCatching { java.util.Base64.getDecoder().decode(it) }.getOrNull() }
      ?.takeIf { it.size == 32 }

  private fun store(context: Context) = PackStore(File(context.applicationContext.filesDir, "pack"), publicKey() ?: ByteArray(0))

  /** voice-fx.json of the active pack, else the APK's own copy; null only when neither parses. */
  fun voiceFx(context: Context): VoiceFx? {
    val app = context.applicationContext
    val dir = store(app).currentDir()
    val key = dir?.name ?: "factory"
    cachedFx?.takeIf { it.first == key }?.let { return it.second }
    val fromPack =
      dir?.let { d ->
        runCatching { VoiceFx.parse(File(d, "voice-fx.json").readText()) }
          .onFailure { Log.w(TAG, "pack ${d.name} voice-fx.json unreadable, using the APK's: ${it.message}") }
          .getOrNull()
      }
    val fx =
      fromPack ?: runCatching {
        VoiceFx.parse(app.assets.open("${JarvisScript.FACTORY_ASSET_DIR}/voice-fx.json").use { it.readBytes().decodeToString() })
      }.onFailure { Log.e(TAG, "the APK's voice-fx.json is unreadable", it) }.getOrNull()
    if (fx != null) cachedFx = (if (fromPack != null) key else "factory") to fx
    return fx
  }

  /** The start hook PackStore runs: the pack's "start" handler, unless this phone has no JS engine. */
  private suspend fun runStart(
    context: Context,
    dir: File?,
  ) {
    if (JarvisScript.engine() == "none") return
    JarvisScript.run(context, dir, "start", JsonObject(emptyMap()))
  }

  /** At process start: the active pack's start script (rolled back if it throws), then a check. */
  fun onAppStart(context: Context) {
    val app = context.applicationContext
    scope.launch {
      runCatching {
        val (active, error) = lock.withLock { store(app).startCurrent { runStart(app, it) } }
        cachedFx = null
        if (error != null) {
          Log.w(TAG, "pack start failed, now on ${active ?: "factory"}: $error")
          report(app, active ?: 0L, "rolled-back", error)
        }
      }.onFailure { Log.w(TAG, "start: ${it.message}") }
      check(app, "start")
    }
  }

  /** After a Firebase wake: look for a new pack, then give the pack's "wake" handler its turn. */
  fun onWake(
    context: Context,
    reason: String?,
  ) {
    val app = context.applicationContext
    scope.launch {
      check(app, "wake")
      runCatching { runEvent(app, "wake", JsonObject(mapOf("reason" to JsonPrimitive(reason.orEmpty())))) }
        .onFailure { Log.w(TAG, "wake handler: ${it.message}") }
    }
  }

  /** Fetches pack.json and installs a newer pack. Returns what happened, in a few words. */
  suspend fun check(
    context: Context,
    why: String,
  ): String {
    val app = context.applicationContext
    val outcome =
      try {
        checkLock.withLock { checkOnce(app) }
      } catch (err: Throwable) {
        Log.w(TAG, "check ($why) failed: ${err.message}")
        "failed: ${err.message ?: err.javaClass.simpleName}"
      }
    lastCheckAtMs = System.currentTimeMillis()
    lastOutcome = "$why: $outcome"
    Log.i(TAG, "check ($why): $outcome")
    return outcome
  }

  private suspend fun checkOnce(app: Context): String {
    if (publicKey() == null) return "packs off: no key in this build"
    val prefs = (app as NodeApp).prefs
    val token = prefs.loadJarvisDeviceToken() ?: return "not paired"
    var origin = JarvisDoor.origin.value ?: JarvisDoor.resolve(prefs.jarvisDoorCandidates.value) ?: return "no door answers"
    var raw = JarvisDoor.fetchText(origin, "/door/app/pack.json", token)
    if (raw == null) {
      origin = JarvisDoor.resolve(prefs.jarvisDoorCandidates.value) ?: return "no door answers"
      raw = JarvisDoor.fetchText(origin, "/door/app/pack.json", token) ?: return "no pack published"
    }
    val pointer = parsePackPointer(raw) ?: return "pack.json unreadable"
    val store = store(app)
    val before = store.state()
    if (pointer.version <= (before.current ?: 0L)) return "up to date (${before.current})"
    if (pointer.version in before.bad) return "pack ${pointer.version} failed before; waiting for a newer one"
    val zip = download(origin, token, pointer)
    val result = lock.withLock { store.install(pointer, zip, BuildConfig.VERSION_CODE.toLong()) { runStart(app, it) } }
    cachedFx = null
    val (status, detail) =
      when (result) {
        is PackOutcome.Activated -> "active" to "previous ${result.previous ?: "factory"}"
        is PackOutcome.RolledBack -> "rolled-back" to result.error
        is PackOutcome.Rejected -> "rejected" to result.reason
        is PackOutcome.Skipped -> "skipped" to result.reason
      }
    report(app, pointer.version, status, detail, origin, token)
    return "$status ${pointer.version} ($detail)"
  }

  private suspend fun download(
    origin: String,
    token: String,
    pointer: PackPointer,
  ): ByteArray =
    withContext(Dispatchers.IO) {
      require(pointer.size <= PackStore.MAX_ZIP_BYTES) { "pack too large (${pointer.size} bytes)" }
      val request =
        Request
          .Builder()
          .url("$origin/door/app/${pointer.file}")
          .header(JARVIS_DEVICE_HEADER, token)
          .get()
          .build()
      JarvisDoor.http.newCall(request).await().use { response ->
        if (!response.isSuccessful) throw IllegalStateException("download failed (HTTP ${response.code})")
        val bytes = response.body.bytes()
        require(bytes.size <= PackStore.MAX_ZIP_BYTES) { "pack too large" }
        bytes
      }
    }

  private suspend fun report(
    app: Context,
    version: Long,
    status: String,
    detail: String,
    knownOrigin: String? = null,
    knownToken: String? = null,
  ) {
    val prefs = (app as NodeApp).prefs
    val token = knownToken ?: prefs.loadJarvisDeviceToken() ?: return
    val origin = knownOrigin ?: JarvisDoor.origin.value ?: JarvisDoor.resolve(prefs.jarvisDoorCandidates.value) ?: return
    val q =
      "version=$version&status=${Uri.encode(status)}&engine=${Uri.encode(JarvisScript.engine())}" +
        "&app=${BuildConfig.VERSION_CODE}&detail=${Uri.encode(detail.take(200))}"
    JarvisDoor.fetchText(origin, "/door/app/pack-installed?$q", token)
  }

  /** Runs `event` in the active pack (factory if none) and the verbs it asks for. */
  suspend fun runEvent(
    context: Context,
    event: String,
    data: JsonObject,
  ): JsonObject {
    val app = context.applicationContext
    return JarvisScript.run(app, store(app).currentDir(), event, data)
  }

  fun status(context: Context): JsonObject {
    val app = context.applicationContext
    val s = store(app).state()
    val n = { v: Long? -> v?.let { JsonPrimitive(it) } ?: JsonNull }
    return JsonObject(
      mapOf(
        "current" to n(s.current),
        "previous" to n(s.previous),
        "bad" to JsonArray(s.bad.map { JsonPrimitive(it) }),
        "engine" to JsonPrimitive(JarvisScript.engine()),
        "key" to JsonPrimitive(publicKey() != null),
        // which copy the closed-app voice reads: a pack version, "factory" (the APK's) or "none"
        "voiceFx" to JsonPrimitive(if (voiceFx(app) != null) cachedFx?.first ?: "factory" else "none"),
        "lastCheck" to JsonPrimitive(lastOutcome ?: "never"),
        "lastCheckAtMs" to JsonPrimitive(lastCheckAtMs),
        "app" to JsonPrimitive(BuildConfig.VERSION_CODE),
      ),
    )
  }
}
