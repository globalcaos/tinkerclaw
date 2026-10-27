package ai.openclaw.app

import ai.openclaw.app.ui.OpenClawTheme
import ai.openclaw.app.ui.RootScreen
import ai.openclaw.app.update.AppUpdater
import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.core.view.WindowCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
  private val viewModel: MainViewModel by viewModels()
  private lateinit var permissionRequester: PermissionRequester
  private var didAttachRuntimeUi = false
  private var didStartNodeService = false
  private val assistSpeech =
    registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
      if (result.resultCode != RESULT_OK) return@registerForActivityResult
      ai.openclaw.app.jarvis.JarvisAssist.firstResult(result.data)?.let(ai.openclaw.app.jarvis.JarvisAssist::deliver)
    }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    if (savedInstanceState == null) handleAssistantIntent(intent)
    if (savedInstanceState == null) handleJarvisIntent(intent)
    WindowCompat.setDecorFitsSystemWindows(window, false)
    permissionRequester = PermissionRequester(this)

    lifecycleScope.launch {
      repeatOnLifecycle(Lifecycle.State.STARTED) {
        viewModel.preventSleep.collect { enabled ->
          if (enabled) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
          } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
          }
        }
      }
    }

    lifecycleScope.launch {
      repeatOnLifecycle(Lifecycle.State.STARTED) {
        viewModel.runtimeInitialized.collect { ready ->
          if (!ready || didAttachRuntimeUi) return@collect
          viewModel.attachRuntimeUi(owner = this@MainActivity, permissionRequester = permissionRequester)
          didAttachRuntimeUi = true
          if (!didStartNodeService) {
            NodeForegroundService.start(this@MainActivity)
            didStartNodeService = true
          }
        }
      }
    }

    // FORK 2026-10-19 (the architect: phone app) — the Jarvis build checks the door for a newer APK at start
    // and then every six hours while it is on screen.
    if (BuildConfig.JARVIS_APP) {
      lifecycleScope.launch {
        repeatOnLifecycle(Lifecycle.State.STARTED) {
          while (isActive) {
            AppUpdater.checkIfDue(applicationContext)
            delay(15 * 60 * 1000L)
          }
        }
      }
    }

    setContent {
      OpenClawTheme {
        Surface(modifier = Modifier) {
          RootScreen(viewModel = viewModel)
        }
      }
    }
  }

  override fun onStart() {
    super.onStart()
    ai.openclaw.app.jarvis.JarvisLook.attachActivity(this)
    ai.openclaw.app.jarvis.JarvisLook.foreground = true
    viewModel.setForeground(true)
  }

  override fun onStop() {
    ai.openclaw.app.jarvis.JarvisLook.foreground = false
    viewModel.setForeground(false)
    super.onStop()
  }

  override fun onNewIntent(intent: android.content.Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    handleAssistantIntent(intent)
    handleJarvisIntent(intent)
  }

  // FORK 2026-10-19 (the architect: phone app) — jarvis://pair links (the door's pair page) and the
  // "Jarvis update ready" notification both land here.
  private fun handleJarvisIntent(intent: android.content.Intent?) {
    if (!BuildConfig.JARVIS_APP || intent == null) return
    // Reopening from Recents re-delivers the intent that created the task: never replay a pair link
    // or an install from there.
    if ((intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return
    if (intent.action == AppUpdater.ACTION_INSTALL_UPDATE) {
      setIntent(Intent(intent).setAction(Intent.ACTION_MAIN))
      lifecycleScope.launch { AppUpdater.downloadAndInstall(this@MainActivity) }
      return
    }
    // 2026-10-23: the open verb (or a notification tap from notify {tap}) names a screen or a URL.
    if (intent.action == ai.openclaw.app.jarvis.JarvisOpen.ACTION_OPEN) {
      setIntent(Intent(intent).setAction(Intent.ACTION_MAIN))
      openJarvisTarget(intent)
      return
    }
    val data = intent.data ?: return
    if (!data.scheme.equals("jarvis", ignoreCase = true) || !data.host.equals("pair", ignoreCase = true)) return
    // The link carries both tokens: keep them off the activity's intent once read.
    setIntent(Intent(intent).setData(null))
    val error = viewModel.offerJarvisPairLink(data.toString())
    if (error != null) Toast.makeText(this, error, Toast.LENGTH_LONG).show()
  }

  private fun openJarvisTarget(intent: Intent) {
    val screen = ai.openclaw.app.jarvis.JarvisScreen.fromBridgeName(intent.getStringExtra(ai.openclaw.app.jarvis.JarvisOpen.EXTRA_SCREEN))
    if (screen != null) {
      viewModel.openJarvisScreen(screen)
      return
    }
    val raw = intent.getStringExtra(ai.openclaw.app.jarvis.JarvisOpen.EXTRA_URL) ?: return
    val door = ai.openclaw.app.jarvis.JarvisDoor.origin.value
    val url = ai.openclaw.app.jarvis.resolveOnDoor(raw, door) ?: return
    val tinker = ai.openclaw.app.jarvis.JarvisLook.tinkerWebView()
    if (tinker != null && ai.openclaw.app.jarvis.isSameJarvisOrigin(url, door)) {
      // A door page opens in the app's own Tinker view, which carries the device cookie.
      viewModel.openJarvisScreen(ai.openclaw.app.jarvis.JarvisScreen.Tinker)
      tinker.loadUrl(url)
      return
    }
    runCatching { startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url))) }
      .onFailure { Toast.makeText(this, "Cannot open $url", Toast.LENGTH_LONG).show() }
  }

  private fun handleAssistantIntent(intent: android.content.Intent?) {
    // FORK 2026-10-21 (the architect): the side-key long press, with Jarvis as the digital assistant app,
    // listens for a voice prompt and sends it to Tinker (jarvis/JarvisAssist.kt).
    if (BuildConfig.JARVIS_APP && intent?.action == Intent.ACTION_ASSIST) {
      setIntent(Intent(intent).setAction(Intent.ACTION_MAIN))
      if ((intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return
      try {
        assistSpeech.launch(ai.openclaw.app.jarvis.JarvisAssist.recognizerIntent())
      } catch (err: android.content.ActivityNotFoundException) {
        android.util.Log.e("JarvisAssist", "no speech recognizer on this phone", err)
        Toast.makeText(this, "No speech recognizer on this phone", Toast.LENGTH_LONG).show()
      }
      return
    }
    val request = parseAssistantLaunchIntent(intent) ?: return
    viewModel.handleAssistantLaunch(request)
  }
}
