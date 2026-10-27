package ai.openclaw.app

import android.app.Application
import android.os.StrictMode

class NodeApp : Application() {
  val prefs: SecurePrefs by lazy { SecurePrefs(this) }

  @Volatile private var runtimeInstance: NodeRuntime? = null

  fun ensureRuntime(): NodeRuntime {
    runtimeInstance?.let { return it }
    return synchronized(this) {
      runtimeInstance ?: NodeRuntime(this, prefs).also { runtimeInstance = it }
    }
  }

  fun peekRuntime(): NodeRuntime? = runtimeInstance

  override fun onCreate() {
    super.onCreate()
    // 2026-10-26: crash and abnormal-exit reports go to the Pi's door (the architect: "keeps stopping").
    if (BuildConfig.JARVIS_APP) ai.openclaw.app.jarvis.JarvisCrash.install(this)
    ai.openclaw.app.jarvis.JarvisLook.attachApp(this)
    if (BuildConfig.DEBUG) {
      StrictMode.setThreadPolicy(
        StrictMode.ThreadPolicy
          .Builder()
          .detectAll()
          .penaltyLog()
          .build(),
      )
      StrictMode.setVmPolicy(
        StrictMode.VmPolicy
          .Builder()
          .detectAll()
          .penaltyLog()
          .build(),
      )
    }
  }
}
