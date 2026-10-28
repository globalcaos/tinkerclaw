package ai.openclaw.app.jarvis

import ai.openclaw.app.NodeApp
import android.Manifest
import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ContentResolver
import android.content.ContentUris
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Bundle
import android.os.PowerManager
import android.provider.MediaStore
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.core.content.edit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okio.BufferedSink
import okio.source
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZonedDateTime
import java.util.concurrent.TimeUnit

/**
 * Backs the phone's pictures up to the Pi's disk through the door (2026-10-21: a nightly job
 * inside the phone app). The door keeps them under
 * ~/Pictures/phone-backup/<device id>/<the phone's own folder>/<file name> on the Pi.
 *
 * Schedule: every night at 02:00 phone time it uploads for at most an hour, newest pictures first,
 * until the Pi holds them all; after a run that leaves nothing behind it waits a week, and any run
 * that ends with pictures left drops back to nightly. Any network: the owner asked
 * (2026-10-21) not to wait for wifi.
 * What is already on the Pi comes from /door/backup/manifest (path + size), so a run that is cut
 * off loses nothing and a picture is never sent twice.
 *
 * Node commands: jarvis.backup.run {minutes, force} starts a run now; jarvis.backup.status reports.
 */
object PhotoBackup {
  private const val TAG = "JarvisBackup"
  private const val PREFS = "jarvis.photobackup"
  private const val NEXT_DUE = "nextDueAt"
  private const val LAST = "lastRun"
  private const val PUBLIC = "publicOrigin"
  private const val NIGHT_HOUR = 2
  private const val RUN_BUDGET_MS = 60 * 60 * 1000L
  private const val TICK_MS = 15 * 60 * 1000L
  private const val WEEK_EXTRA_DAYS = 6L

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private var ticker: Job? = null

  @Volatile private var running: Job? = null

  @Volatile private var current: JSONObject? = null

  private val client: OkHttpClient by lazy {
    JarvisDoor.http
      .newBuilder()
      .writeTimeout(60, TimeUnit.SECONDS)
      .readTimeout(60, TimeUnit.SECONDS)
      .build()
  }

  /** Called when the node service starts: arms the night alarm and a 15-minute safety tick. */
  @Synchronized
  fun start(context: Context) {
    val app = context.applicationContext
    if (ticker?.isActive == true) return
    if (prefs(app).getLong(NEXT_DUE, 0L) == 0L) setNextDue(app, nextNight(System.currentTimeMillis(), 0))
    armAlarm(app)
    ticker =
      scope.launch {
        while (isActive) {
          runCatching { runIfDue(app) }.onFailure { Log.w(TAG, "tick: ${it.message}") }
          delay(TICK_MS)
        }
      }
  }

  fun onAlarm(context: Context) {
    val app = context.applicationContext
    scope.launch { runIfDue(app) }
  }

  private fun runIfDue(app: Context) {
    if (running?.isActive == true) return
    if (System.currentTimeMillis() < prefs(app).getLong(NEXT_DUE, 0L)) return
    runNow(app, RUN_BUDGET_MS, force = false, reason = "night")
  }

  /** Starts a run unless one is going. Returns false when one already is. */
  @Synchronized
  fun runNow(
    context: Context,
    budgetMs: Long,
    force: Boolean,
    reason: String,
  ): Boolean {
    if (running?.isActive == true) return false
    val app = context.applicationContext
    running = scope.launch { runOnce(app, budgetMs, force, reason) }
    return true
  }

  fun isRunning(): Boolean = running?.isActive == true

  fun statusJson(context: Context): String {
    val p = prefs(context.applicationContext)
    val next = p.getLong(NEXT_DUE, 0L)
    val last = p.getString(LAST, null)?.let { runCatching { JSONObject(it) }.getOrNull() }
    return JSONObject()
      .put("running", running?.isActive == true)
      .put("current", current ?: JSONObject.NULL)
      .put("last", last ?: JSONObject.NULL)
      .put("nextDueAt", if (next > 0) Instant.ofEpochMilli(next).toString() else JSONObject.NULL)
      .put("onWifi", onWifi(context))
      .put("publicOrigin", p.getString(PUBLIC, null) ?: JSONObject.NULL)
      .put("access", access(context))
      .toString()
  }

  private suspend fun runOnce(
    app: Context,
    budgetMs: Long,
    force: Boolean,
    reason: String,
  ) {
    val started = System.currentTimeMillis()
    val deadline = started + budgetMs
    val st =
      JSONObject()
        .put("reason", reason)
        .put("startedAt", Instant.ofEpochMilli(started).toString())
        .put("budgetMinutes", budgetMs / 60_000)
        .put("uploaded", 0)
        .put("bytes", 0L)
        .put("failed", 0)
    current = st
    val wake =
      (app.getSystemService(Context.POWER_SERVICE) as PowerManager)
        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "jarvis:photo-backup")
    wake.acquire(budgetMs + 5 * 60 * 1000L)
    var stop = "done"
    try {
      val prefs = (app as NodeApp).prefs
      val token = prefs.loadJarvisDeviceToken() ?: error("not paired with a door")
      // Tailscale first; there the door also says which public address forwards the backup
      // (Funnel, /door/backup/ only). Without Tailscale, the remembered public address.
      val tailnet =
        JarvisDoor.origin.value?.takeIf { JarvisDoor.probe(it) }
          ?: JarvisDoor.resolve(prefs.jarvisDoorCandidates.value)
      if (tailnet != null) learnPublicOrigin(app, tailnet, token)
      val origin =
        tailnet
          ?: prefs(app).getString(PUBLIC, null)
          ?: error("door not reachable and no public address known yet")
      st.put("route", if (tailnet != null) "tailscale" else "public")
      val onPi = manifest(origin, token)
      val photos = listPhotos(app.contentResolver)
      val todo = photos.filter { onPi[it.key] != it.size }
      st.put("phonePictures", photos.size).put("alreadyOnPi", photos.size - todo.size).put("pendingAtStart", todo.size)
      var uploaded = 0
      var failed = 0
      var bytes = 0L
      for (photo in todo) {
        if (System.currentTimeMillis() >= deadline) {
          stop = "time budget used"
          break
        }
        val ok =
          runCatching { upload(app.contentResolver, origin, token, photo) }
            .onFailure {
              st.put("lastError", "${photo.key}: ${it.message}")
              Log.w(TAG, "upload ${photo.key}: ${it.message}")
            }.getOrDefault(-1L)
        if (ok >= 0) {
          uploaded++
          bytes += ok
        } else {
          failed++
          if (failed >= 20 && uploaded == 0) {
            stop = "every upload failing"
            break
          }
        }
        st.put("uploaded", uploaded).put("bytes", bytes).put("failed", failed)
      }
      st.put("remaining", todo.size - uploaded)
    } catch (err: Throwable) {
      stop = "error: ${err.message}"
      st.put("lastError", err.message ?: err.toString())
    } finally {
      wake.release()
      val ended = System.currentTimeMillis()
      st.put("endedAt", Instant.ofEpochMilli(ended).toString()).put("stop", stop)
      val caughtUp = st.optInt("remaining", -1) == 0 && st.optInt("failed", 0) == 0
      st.put("phase", if (caughtUp) "weekly" else "nightly")
      // Caught up: next run a week on. Pictures left: next night. A run that could not start keeps
      // its due time, so the 15-minute tick tries again.
      if (!stop.startsWith("error")) {
        setNextDue(app, nextNight(ended, if (caughtUp) WEEK_EXTRA_DAYS else 0))
      }
      prefs(app).edit { putString(LAST, st.toString()) }
      current = null
      Log.i(TAG, "run ended: $st")
    }
  }

  private data class Photo(
    val uri: Uri,
    val key: String,
    val size: Long,
    val mtimeMs: Long,
  )

  private fun listPhotos(resolver: ContentResolver): List<Photo> {
    val projection =
      arrayOf(
        MediaStore.Images.Media._ID,
        MediaStore.Images.Media.RELATIVE_PATH,
        MediaStore.Images.Media.DISPLAY_NAME,
        MediaStore.Images.Media.SIZE,
        MediaStore.Images.Media.DATE_MODIFIED,
        MediaStore.Images.Media.DATE_TAKEN,
      )
    val args =
      Bundle().apply {
        putString(ContentResolver.QUERY_ARG_SQL_SORT_ORDER, "${MediaStore.Images.Media.DATE_ADDED} DESC")
      }
    val base = MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
    val out = mutableListOf<Photo>()
    resolver.query(base, projection, args, null)?.use { c ->
      val id = c.getColumnIndexOrThrow(MediaStore.Images.Media._ID)
      val rel = c.getColumnIndexOrThrow(MediaStore.Images.Media.RELATIVE_PATH)
      val name = c.getColumnIndexOrThrow(MediaStore.Images.Media.DISPLAY_NAME)
      val size = c.getColumnIndexOrThrow(MediaStore.Images.Media.SIZE)
      val mod = c.getColumnIndexOrThrow(MediaStore.Images.Media.DATE_MODIFIED)
      val taken = c.getColumnIndexOrThrow(MediaStore.Images.Media.DATE_TAKEN)
      while (c.moveToNext()) {
        val file = c.getString(name)?.takeIf { it.isNotBlank() } ?: continue
        val folder = c.getString(rel)?.trim('/')?.takeIf { it.isNotBlank() } ?: "Other"
        val mtime = if (!c.isNull(mod)) c.getLong(mod) * 1000 else if (!c.isNull(taken)) c.getLong(taken) else 0L
        out +=
          Photo(
            uri = ContentUris.withAppendedId(base, c.getLong(id)),
            key = "$folder/$file",
            size = c.getLong(size),
            mtimeMs = mtime,
          )
      }
    }
    return out
  }

  private suspend fun learnPublicOrigin(
    app: Context,
    origin: String,
    token: String,
  ) {
    val raw = JarvisDoor.fetchText(origin, "/door/whoami", token) ?: return
    val pub = runCatching { JSONObject(raw).optString("publicOrigin") }.getOrNull().orEmpty()
    prefs(app).edit {
      if (Regex("^https://[A-Za-z0-9.-]+$").matches(pub)) putString(PUBLIC, pub) else remove(PUBLIC)
    }
  }

  private suspend fun manifest(
    origin: String,
    token: String,
  ): Map<String, Long> {
    val raw = JarvisDoor.fetchText(origin, "/door/backup/manifest", token) ?: error("manifest not readable")
    val files = JSONObject(raw).getJSONArray("files")
    val out = HashMap<String, Long>(files.length() * 2)
    for (i in 0 until files.length()) {
      val row: JSONArray = files.getJSONArray(i)
      out[row.getString(0)] = row.getLong(1)
    }
    return out
  }

  /** One PUT; returns the bytes sent. The length comes from the file itself, not MediaStore. */
  private suspend fun upload(
    resolver: ContentResolver,
    origin: String,
    token: String,
    photo: Photo,
  ): Long {
    val length =
      resolver.openFileDescriptor(photo.uri, "r")?.use { it.statSize }?.takeIf { it >= 0 }
        ?: error("cannot open")
    val body =
      object : RequestBody() {
        override fun contentType() = "application/octet-stream".toMediaType()

        override fun contentLength() = length

        override fun writeTo(sink: BufferedSink) {
          (resolver.openInputStream(photo.uri) ?: error("cannot read")).source().use { sink.writeAll(it) }
        }
      }
    val url =
      "$origin/door/backup/file"
        .toHttpUrl()
        .newBuilder()
        .addQueryParameter("path", photo.key)
        .addQueryParameter("mtime", photo.mtimeMs.toString())
        .build()
    val request =
      Request
        .Builder()
        .url(url)
        .header(JARVIS_DEVICE_HEADER, token)
        .put(body)
        .build()
    client.newCall(request).await().use { r ->
      if (!r.isSuccessful) error("HTTP ${r.code}")
    }
    return length
  }

  /** True when the phone sits on an unmetered Wi-Fi (Tailscale on top does not change that). */
  private fun onWifi(context: Context): Boolean {
    val cm = context.getSystemService(ConnectivityManager::class.java) ?: return false
    @Suppress("DEPRECATION")
    return cm.allNetworks.any { n ->
      val caps = cm.getNetworkCapabilities(n) ?: return@any false
      caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) &&
        caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) &&
        caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }
  }

  private fun access(context: Context): String {
    fun has(p: String) = ContextCompat.checkSelfPermission(context, p) == PackageManager.PERMISSION_GRANTED
    return when {
      has(Manifest.permission.READ_MEDIA_IMAGES) -> "all"
      has(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) -> "selected only"
      else -> "none"
    }
  }

  /** The next 02:00 local strictly after `fromMs`, plus `extraDays`. */
  private fun nextNight(
    fromMs: Long,
    extraDays: Long,
  ): Long {
    val zone = ZoneId.systemDefault()
    val from = Instant.ofEpochMilli(fromMs).atZone(zone)
    var at: ZonedDateTime = from.toLocalDate().atTime(LocalTime.of(NIGHT_HOUR, 0)).atZone(zone)
    if (!at.isAfter(from)) at = at.plusDays(1)
    return at.plusDays(extraDays).toInstant().toEpochMilli()
  }

  private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  private fun setNextDue(
    app: Context,
    at: Long,
  ) {
    prefs(app).edit { putLong(NEXT_DUE, at) }
    armAlarm(app)
  }

  /** Inexact, allowed in Doze; the 15-minute tick covers an alarm the system drops. */
  private fun armAlarm(app: Context) {
    val at = prefs(app).getLong(NEXT_DUE, 0L).takeIf { it > 0 } ?: return
    val am = app.getSystemService(AlarmManager::class.java) ?: return
    val pi =
      PendingIntent.getBroadcast(
        app,
        0x4A42,
        Intent(app, PhotoBackupAlarm::class.java),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
  }
}

class PhotoBackupAlarm : BroadcastReceiver() {
  override fun onReceive(
    context: Context,
    intent: Intent,
  ) {
    PhotoBackup.onAlarm(context)
  }
}
