package ai.openclaw.app.jarvis

import ai.openclaw.app.BuildConfig
import ai.openclaw.app.NodeApp
import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.File

/**
 * 2026-10-26 (the architect: "the Jarvis app keeps stopping unexpectedly … put logs to monitor it"):
 * a crash leaves the Pi a report. Two sources:
 *  1. our own uncaught-exception handler writes the full Java stack trace to filesDir/crash/ before
 *     Android kills the process;
 *  2. Android's exit history (ApplicationExitInfo) names every abnormal death since the last report:
 *     crash, ANR, native crash, low-memory kill, excessive resource use. ANR and native exits carry a trace.
 * On each start the reports are POSTed to <door>/door/app/crash, which stores them on the Pi.
 */
object JarvisCrash {
  private const val PREFS = "jarvis-crash"
  private const val KEY_LAST_EXIT = "lastExitTimestamp"
  private const val MAX_TRACE = 48_000

  private fun dir(context: Context) = File(context.filesDir, "crash").apply { mkdirs() }

  fun install(context: Context) {
    val app = context.applicationContext
    val previous = Thread.getDefaultUncaughtExceptionHandler()
    Thread.setDefaultUncaughtExceptionHandler { thread, error ->
      runCatching {
        val text =
          buildString {
            append("kind: java-crash\n")
            append("at: ").append(System.currentTimeMillis()).append('\n')
            append("app: ").append(BuildConfig.VERSION_CODE).append('\n')
            append("thread: ").append(thread.name).append('\n')
            append("headline: ").append(error.toString().take(300)).append("\n\n")
            append(error.stackTraceToString().take(MAX_TRACE))
          }
        File(dir(app), "java-${System.currentTimeMillis()}.txt").writeText(text)
      }
      previous?.uncaughtException(thread, error)
    }
    CoroutineScope(SupervisorJob() + Dispatchers.IO).launch { reportLoop(app) }
  }

  private fun reasonName(reason: Int): String =
    when (reason) {
      ApplicationExitInfo.REASON_CRASH -> "crash"
      ApplicationExitInfo.REASON_CRASH_NATIVE -> "crash-native"
      ApplicationExitInfo.REASON_ANR -> "anr"
      ApplicationExitInfo.REASON_LOW_MEMORY -> "low-memory"
      ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "excessive-resource-use"
      ApplicationExitInfo.REASON_INITIALIZATION_FAILURE -> "init-failure"
      ApplicationExitInfo.REASON_SIGNALED -> "signaled"
      ApplicationExitInfo.REASON_DEPENDENCY_DIED -> "dependency-died"
      ApplicationExitInfo.REASON_PERMISSION_CHANGE -> "permission-change"
      ApplicationExitInfo.REASON_OTHER -> "other"
      else -> "reason-$reason"
    }

  // Normal exits (user swipe, our own stop, an app update) are not problems.
  private val normal =
    setOf(
      ApplicationExitInfo.REASON_EXIT_SELF,
      ApplicationExitInfo.REASON_USER_REQUESTED,
      ApplicationExitInfo.REASON_USER_STOPPED,
      ApplicationExitInfo.REASON_PACKAGE_UPDATED,
      ApplicationExitInfo.REASON_UNKNOWN,
    )

  /** Exit-history entries since the last report, written as files beside the Java traces. */
  private fun collectExits(context: Context) {
    val sp = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val since = sp.getLong(KEY_LAST_EXIT, 0L)
    val am = context.getSystemService(ActivityManager::class.java) ?: return
    val exits = runCatching { am.getHistoricalProcessExitReasons(context.packageName, 0, 20) }.getOrNull() ?: return
    var newest = since
    for (e in exits) {
      if (e.timestamp <= since) continue
      if (e.timestamp > newest) newest = e.timestamp
      if (e.reason in normal) continue
      val trace =
        runCatching { e.traceInputStream?.use { it.readBytes().decodeToString().take(MAX_TRACE) } }.getOrNull()
      val text =
        buildString {
          append("kind: exit-").append(reasonName(e.reason)).append('\n')
          append("at: ").append(e.timestamp).append('\n')
          append("app: ").append(BuildConfig.VERSION_CODE).append('\n')
          append("process: ").append(e.processName).append('\n')
          append("importance: ").append(e.importance).append('\n')
          append("pss-kb: ").append(e.pss).append(" rss-kb: ").append(e.rss).append('\n')
          append("status: ").append(e.status).append('\n')
          append("headline: ").append(e.description ?: "").append("\n\n")
          if (trace != null) append(trace)
        }
      File(dir(context), "exit-${e.timestamp}.txt").writeText(text)
    }
    if (newest > since) sp.edit().putLong(KEY_LAST_EXIT, newest).apply()
  }

  private suspend fun reportLoop(context: Context) {
    runCatching { collectExits(context) }
    while (true) {
      val files = dir(context).listFiles()?.sortedBy { it.name }.orEmpty()
      if (files.isEmpty()) return
      delay(10_000L)
      val prefs = (context as? NodeApp)?.prefs ?: return
      val token = prefs.loadJarvisDeviceToken() ?: continue
      val origin =
        JarvisDoor.origin.value ?: JarvisDoor.resolve(prefs.jarvisDoorCandidates.value) ?: continue
      for (f in files) {
        val ok = JarvisDoor.postText(origin, "/door/app/crash", token, f.readText())
        if (ok != null) f.delete() else break
      }
      if (dir(context).listFiles().isNullOrEmpty()) return
      delay(60_000L)
    }
  }
}
