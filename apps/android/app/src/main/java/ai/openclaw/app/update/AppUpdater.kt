package ai.openclaw.app.update

import ai.openclaw.app.BuildConfig
import ai.openclaw.app.NodeApp
import ai.openclaw.app.jarvis.JARVIS_DEVICE_HEADER
import ai.openclaw.app.jarvis.JarvisDoor
import ai.openclaw.app.jarvis.JarvisNotifications
import ai.openclaw.app.jarvis.await
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import androidx.core.content.edit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.Request
import java.io.File
import java.security.MessageDigest
import java.util.Locale

// FORK 2026-10-19 (the architect: phone app) — the Jarvis app updates itself from the phone door: it reads
// <door>/door/app/latest.json, and when the versionCode is newer it offers the APK, checks its
// sha256 and hands it to PackageInstaller. No Play Store, no sideloading by hand from a trip.

/** <door>/door/app/latest.json, as written by the build step (see apps/android/README.md). */
@Serializable
data class AppRelease(
  val versionCode: Long,
  val versionName: String = "",
  val file: String,
  val sha256: String,
  val notes: String = "",
)

sealed interface UpdateState {
  data object Idle : UpdateState

  data class Downloading(
    val percent: Int,
  ) : UpdateState

  data object Installing : UpdateState

  /** Android wants the owner's tap; the confirm screen could not be opened from the background. */
  data object NeedsConfirm : UpdateState

  data class Failed(
    val message: String,
  ) : UpdateState
}

internal fun parseAppRelease(raw: String): AppRelease? =
  runCatching { updateJson.decodeFromString(AppRelease.serializer(), raw) }
    .getOrNull()
    ?.takeIf { it.file.matches(apkNameRegex) && it.sha256.matches(sha256Regex) }

internal fun isNewerRelease(
  release: AppRelease,
  installedVersionCode: Long,
): Boolean = release.versionCode > installedVersionCode

internal fun sha256Hex(file: File): String {
  val digest = MessageDigest.getInstance("SHA-256")
  file.inputStream().use { input ->
    val buffer = ByteArray(64 * 1024)
    while (true) {
      val read = input.read(buffer)
      if (read < 0) break
      digest.update(buffer, 0, read)
    }
  }
  return digest.digest().joinToString("") { "%02x".format(Locale.US, it) }
}

private val updateJson = Json { ignoreUnknownKeys = true }
private val apkNameRegex = Regex("^[A-Za-z0-9._-]+\\.apk$")
private val sha256Regex = Regex("^[0-9a-fA-F]{64}$")

/** The update banner's words, also shown in the page's chat drop-down (2026-10-23); null = nothing to say. */
fun updateStatusLine(): String? {
  val release = AppUpdater.available.value ?: return null
  return when (val s = AppUpdater.state.value) {
    is UpdateState.Downloading -> "Downloading Jarvis ${release.versionName}… ${s.percent}%"
    UpdateState.Installing -> "Installing…"
    UpdateState.NeedsConfirm -> "Tap Install to finish updating"
    is UpdateState.Failed -> s.message
    UpdateState.Idle -> "Jarvis update ready (${release.versionName.ifBlank { release.versionCode.toString() }})"
  }
}

/** True while the page's chat drop-down is open; the banner steps aside so its rows stay tappable. */
val pageSheetOpen = kotlinx.coroutines.flow.MutableStateFlow(false)

object AppUpdater {
  // The confirm screen Android asked for, kept so the banner can open it from the foreground.
  @Volatile private var pendingConfirm: Intent? = null
  private val watchdog = android.os.Handler(android.os.Looper.getMainLooper())
  private val installTimeout =
    Runnable {
      if (_state.value == UpdateState.Installing) {
        _state.value = UpdateState.Failed("The install did not finish. Tap Install to try again.")
      }
    }

  /** Open the installer's confirm screen from the banner (foreground, so Android allows it). */
  fun openConfirm(context: Context): Boolean {
    val confirm = pendingConfirm ?: return false
    return runCatching { context.startActivity(Intent(confirm).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }.isSuccess
  }

  private const val TAG = "JarvisUpdater"
  private const val CHECK_EVERY_MS = 6 * 60 * 60 * 1000L

  // A debug APK is about 90 MB, a release one under 10 MB; anything far past that is not ours.
  private const val MAX_APK_BYTES = 300L * 1024 * 1024
  private const val PREFS = "jarvis.updater"
  private const val NOTIFIED_KEY = "notifiedVersionCode"
  private const val NOTIFICATION_ID = 0x4A41

  const val ACTION_INSTALL_UPDATE = "ai.openclaw.app.action.JARVIS_INSTALL_UPDATE"
  internal const val ACTION_INSTALL_STATUS = "ai.openclaw.app.action.JARVIS_INSTALL_STATUS"

  private val _available = MutableStateFlow<AppRelease?>(null)
  val available: StateFlow<AppRelease?> = _available.asStateFlow()

  private val _state = MutableStateFlow<UpdateState>(UpdateState.Idle)
  val state: StateFlow<UpdateState> = _state.asStateFlow()

  private val lock = Mutex()

  @Volatile private var lastCheckAtMs = 0L

  /**
   * At app start (first call in the process) and then at most every six hours. Only a check that
   * reached the door counts: unpaired, or no door answering (plane, Tailscale off), the next tick
   * (15 min) tries again.
   */
  suspend fun checkIfDue(context: Context) {
    if (System.currentTimeMillis() - lastCheckAtMs < CHECK_EVERY_MS && lastCheckAtMs != 0L) return
    check(context)
  }

  suspend fun check(context: Context): AppRelease? =
    lock.withLock {
      val appContext = context.applicationContext
      val prefs = (appContext as NodeApp).prefs
      val token = prefs.loadJarvisDeviceToken() ?: return@withLock null
      val path = "/door/app/latest.json"
      val known = JarvisDoor.origin.value
      var raw = known?.let { JarvisDoor.fetchText(it, path, token) }
      if (raw == null) {
        // The door in use may have moved (Pi <-> laptop): probe the list once more.
        val origin = JarvisDoor.resolve(prefs.jarvisDoorCandidates.value) ?: return@withLock null
        raw = JarvisDoor.fetchText(origin, path, token) ?: return@withLock null
      }
      lastCheckAtMs = System.currentTimeMillis()
      val release = parseAppRelease(raw)?.takeIf { isNewerRelease(it, BuildConfig.VERSION_CODE.toLong()) }
      _available.value = release
      if (release != null) notifyOnce(appContext, release)
      release
    }

  private fun notifyOnce(
    context: Context,
    release: AppRelease,
  ) {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    if (prefs.getLong(NOTIFIED_KEY, 0L) >= release.versionCode) return
    val label = release.versionName.ifBlank { release.versionCode.toString() }
    JarvisNotifications.post(
      context,
      title = "Jarvis update ready",
      body = "Version $label. Tap to install.",
      id = NOTIFICATION_ID,
      intentAction = ACTION_INSTALL_UPDATE,
    )
    prefs.edit { putLong(NOTIFIED_KEY, release.versionCode) }
  }

  /**
   * Downloads the APK, checks its sha256 and starts a PackageInstaller session. Until the user has
   * allowed this app to install apps, it opens that settings page instead and returns.
   */
  suspend fun downloadAndInstall(context: Context) {
    // From the notification in a fresh process nothing has been checked yet.
    val release = _available.value ?: check(context) ?: return
    val appContext = context.applicationContext
    if (!appContext.packageManager.canRequestPackageInstalls()) {
      val intent =
        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${appContext.packageName}"))
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      runCatching { context.startActivity(intent) }
      _state.value = UpdateState.Failed("Allow Jarvis to install apps, then tap Install again.")
      return
    }
    lock.withLock {
      try {
        val prefs = (appContext as NodeApp).prefs
        val token = prefs.loadJarvisDeviceToken() ?: throw IllegalStateException("not paired")
        val origin =
          JarvisDoor.origin.value ?: JarvisDoor.resolve(prefs.jarvisDoorCandidates.value)
            ?: throw IllegalStateException("Jarvis is not reachable")
        _state.value = UpdateState.Downloading(0)
        val apk = download(appContext, origin, token, release)
        val actual = withContext(Dispatchers.IO) { sha256Hex(apk) }
        if (!actual.equals(release.sha256, ignoreCase = true)) {
          apk.delete()
          throw IllegalStateException("The download is damaged (sha256 mismatch).")
        }
        _state.value = UpdateState.Installing
        watchdog.removeCallbacks(installTimeout)
        watchdog.postDelayed(installTimeout, 90_000L)
        withContext(Dispatchers.IO) { install(appContext, apk) }
      } catch (err: Throwable) {
        Log.w(TAG, "update failed: ${err.message}")
        _state.value = UpdateState.Failed(err.message ?: "Update failed")
      }
    }
  }

  private suspend fun download(
    context: Context,
    origin: String,
    token: String,
    release: AppRelease,
  ): File =
    withContext(Dispatchers.IO) {
      val dir = File(context.cacheDir, "updates").apply { mkdirs() }
      dir.listFiles()?.forEach { it.delete() }
      val target = File(dir, release.file)
      val request =
        Request
          .Builder()
          .url("$origin/door/app/${release.file}")
          .header(JARVIS_DEVICE_HEADER, token)
          .get()
          .build()
      JarvisDoor.http.newCall(request).await().use { response ->
        if (!response.isSuccessful) throw IllegalStateException("Download failed (HTTP ${response.code})")
        val body = response.body
        val total = body.contentLength()
        if (total > MAX_APK_BYTES) throw IllegalStateException("Update is too large ($total bytes)")
        body.byteStream().use { input ->
          target.outputStream().use { output ->
            val buffer = ByteArray(64 * 1024)
            var done = 0L
            while (true) {
              val read = input.read(buffer)
              if (read < 0) break
              output.write(buffer, 0, read)
              done += read
              if (done > MAX_APK_BYTES) throw IllegalStateException("Update is too large")
              if (total > 0) {
                val percent = ((done * 100) / total).toInt()
                if ((_state.value as? UpdateState.Downloading)?.percent != percent) {
                  _state.value = UpdateState.Downloading(percent)
                }
              }
            }
          }
        }
      }
      target
    }

  private fun install(
    context: Context,
    apk: File,
  ) {
    val installer = context.packageManager.packageInstaller
    val params =
      PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
        setAppPackageName(context.packageName)
        setSize(apk.length())
        setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        if (Build.VERSION.SDK_INT >= 33) {
          setPackageSource(PackageInstaller.PACKAGE_SOURCE_DOWNLOADED_FILE)
        }
      }
    val sessionId = installer.createSession(params)
    installer.openSession(sessionId).use { session ->
      apk.inputStream().use { input ->
        session.openWrite("jarvis.apk", 0, apk.length()).use { output ->
          input.copyTo(output, 64 * 1024)
          session.fsync(output)
        }
      }
      val status =
        Intent(context, AppUpdateReceiver::class.java)
          .setAction(ACTION_INSTALL_STATUS)
          .setPackage(context.packageName)
      // The installer fills in the status extras, so this one has to be mutable (explicit intent).
      val pending =
        PendingIntent.getBroadcast(
          context,
          sessionId,
          status,
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
        )
      session.commit(pending.intentSender)
    }
  }

  internal fun onInstallStatus(
    context: Context,
    intent: Intent,
  ) {
    when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
      PackageInstaller.STATUS_PENDING_USER_ACTION -> {
        val confirm =
          if (Build.VERSION.SDK_INT >= 33) {
            intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
          } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(Intent.EXTRA_INTENT)
          }
        if (confirm == null) {
          _state.value = UpdateState.Failed("The installer did not ask for confirmation.")
          return
        }
        confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        pendingConfirm = confirm
        watchdog.removeCallbacks(installTimeout)
        // Android 14 silently drops a background activity start, so the banner asks for the tap.
        _state.value = UpdateState.NeedsConfirm
        runCatching { context.startActivity(confirm) }
      }
      PackageInstaller.STATUS_SUCCESS -> {
        watchdog.removeCallbacks(installTimeout)
        pendingConfirm = null
        _state.value = UpdateState.Idle
        _available.value = null
      }
      else -> {
        val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
        _state.value = UpdateState.Failed("Install failed ($status)${message?.let { ": $it" } ?: ""}")
      }
    }
  }

  fun clearFailure() {
    if (_state.value is UpdateState.Failed) _state.value = UpdateState.Idle
  }
}

class AppUpdateReceiver : BroadcastReceiver() {
  override fun onReceive(
    context: Context,
    intent: Intent,
  ) {
    if (intent.action != AppUpdater.ACTION_INSTALL_STATUS) return
    AppUpdater.onInstallStatus(context, intent)
  }
}
