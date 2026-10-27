package ai.openclaw.app.jarvis

import android.content.Context
import android.net.Uri
import android.webkit.CookieManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

// FORK 2026-10-19 (the architect: phone app) — finding the phone door and talking to it outside the WebView
// (health probe, trip snapshot, update check). The WebView itself authenticates with the cookie.
object JarvisDoor {
  private const val PROBE_TIMEOUT_MS = 2_500L

  private val _origin = MutableStateFlow<String?>(null)

  /** The door that answered last, or null when none did. */
  val origin: StateFlow<String?> = _origin.asStateFlow()

  val http: OkHttpClient by lazy {
    OkHttpClient
      .Builder()
      .connectTimeout(5, TimeUnit.SECONDS)
      .readTimeout(30, TimeUnit.SECONDS)
      .build()
  }

  private val probeClient: OkHttpClient by lazy {
    http
      .newBuilder()
      .connectTimeout(PROBE_TIMEOUT_MS, TimeUnit.MILLISECONDS)
      .readTimeout(PROBE_TIMEOUT_MS, TimeUnit.MILLISECONDS)
      .callTimeout(PROBE_TIMEOUT_MS + 1_000L, TimeUnit.MILLISECONDS)
      .build()
  }

  /**
   * Probes every candidate at once and returns the first one, in list order, whose /door/health
   * answers "ok". An unreachable first candidate costs one timeout, not one per candidate.
   */
  suspend fun resolve(candidates: List<String>): String? {
    val origins = candidates.mapNotNull(::normalizeJarvisDoorOrigin).distinct()
    val found =
      coroutineScope {
        val probes = origins.map { origin -> async { if (probe(origin)) origin else null } }
        var hit: String? = null
        for (probe in probes) {
          hit = probe.await()
          if (hit != null) break
        }
        probes.forEach { it.cancel() }
        hit
      }
    _origin.value = found
    return found
  }

  suspend fun probe(origin: String): Boolean =
    runCatching {
      val request =
        Request
          .Builder()
          .url("$origin/door/health")
          .get()
          .build()
      probeClient.newCall(request).await().use { response ->
        response.isSuccessful && response.body.string().trim() == "ok"
      }
    }.getOrDefault(false)

  /** The WebView sends this cookie on every request; the door strips it before proxying. */
  fun installDeviceCookie(
    origin: String,
    deviceToken: String,
  ) {
    val cookies = CookieManager.getInstance()
    cookies.setAcceptCookie(true)
    cookies.setCookie(
      origin,
      "$JARVIS_DEVICE_COOKIE=${Uri.encode(deviceToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000",
    )
    cookies.flush()
  }

  /** GET <origin><path> with the device header; null on any failure or non-2xx. */
  suspend fun fetchText(
    origin: String,
    path: String,
    deviceToken: String,
  ): String? =
    withContext(Dispatchers.IO) {
      runCatching {
        val request =
          Request
            .Builder()
            .url("$origin$path")
            .header(JARVIS_DEVICE_HEADER, deviceToken)
            .header("Cache-Control", "no-cache")
            .get()
            .build()
        http.newCall(request).await().use { response ->
          if (!response.isSuccessful) null else response.body.string()
        }
      }.getOrNull()
    }

  /** POST a plain-text body to <origin><path> with the device header; null on any failure or non-2xx. */
  suspend fun postText(
    origin: String,
    path: String,
    deviceToken: String,
    body: String,
  ): String? =
    withContext(Dispatchers.IO) {
      runCatching {
        val request =
          Request
            .Builder()
            .url("$origin$path")
            .header(JARVIS_DEVICE_HEADER, deviceToken)
            .post(body.toRequestBody("text/plain; charset=utf-8".toMediaType()))
            .build()
        http.newCall(request).await().use { response ->
          if (!response.isSuccessful) null else response.body.string()
        }
      }.getOrNull()
    }
}

/** OkHttp call as a cancellable suspend function (cancelling the coroutine cancels the call). */
internal suspend fun Call.await(): Response =
  suspendCancellableCoroutine { cont ->
    cont.invokeOnCancellation { runCatching { cancel() } }
    enqueue(
      object : Callback {
        override fun onFailure(
          call: Call,
          e: IOException,
        ) {
          if (cont.isActive) cont.resumeWithException(e)
        }

        override fun onResponse(
          call: Call,
          response: Response,
        ) {
          if (cont.isActive) cont.resume(response) else response.close()
        }
      },
    )
  }

/** Offline copy of the trip page: filesDir/trip/trip.html plus the time it was saved. */
object TripCache {
  private fun dir(context: Context) = File(context.filesDir, "trip")

  fun save(
    context: Context,
    html: String,
    savedAtMs: Long = System.currentTimeMillis(),
  ) {
    val dir = dir(context)
    dir.mkdirs()
    val tmp = File(dir, "trip.html.tmp")
    tmp.writeText(html)
    tmp.renameTo(File(dir, "trip.html"))
    File(dir, "saved-at.txt").writeText(savedAtMs.toString())
  }

  fun load(context: Context): Pair<String, Long>? {
    val dir = dir(context)
    val page = File(dir, "trip.html").takeIf { it.isFile } ?: return null
    val savedAt =
      File(dir, "saved-at.txt")
        .takeIf { it.isFile }
        ?.readText()
        ?.trim()
        ?.toLongOrNull() ?: page.lastModified()
    return runCatching { page.readText() to savedAt }.getOrNull()
  }
}
