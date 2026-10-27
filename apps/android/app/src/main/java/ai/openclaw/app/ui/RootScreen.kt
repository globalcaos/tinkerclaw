package ai.openclaw.app.ui

import ai.openclaw.app.BuildConfig
import ai.openclaw.app.MainViewModel
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier

@Composable
fun RootScreen(viewModel: MainViewModel) {
  val onboardingCompleted by viewModel.onboardingCompleted.collectAsState()
  // FORK 2026-10-19 (the architect: phone app) — the Jarvis build pairs with a phone door first, then runs
  // the stock permission steps once, then lives on the Tinker page.
  val jarvisPaired by viewModel.jarvisPaired.collectAsState()
  var classicSetup by rememberSaveable { mutableStateOf(false) }
  val jarvisApp = BuildConfig.JARVIS_APP

  if (jarvisApp) JarvisPairConfirmDialog(viewModel = viewModel)

  if (!onboardingCompleted) {
    if (jarvisApp && !jarvisPaired && !classicSetup) {
      JarvisPairScreen(
        viewModel = viewModel,
        onClassicSetup = { classicSetup = true },
        modifier = Modifier.fillMaxSize(),
      )
      return
    }
    OnboardingFlow(viewModel = viewModel, modifier = Modifier.fillMaxSize(), jarvisPaired = jarvisApp && jarvisPaired)
    return
  }

  if (jarvisApp && jarvisPaired) {
    JarvisHome(viewModel = viewModel, modifier = Modifier.fillMaxSize())
    return
  }

  PostOnboardingTabs(viewModel = viewModel, modifier = Modifier.fillMaxSize())
}
