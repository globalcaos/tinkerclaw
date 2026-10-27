package ai.openclaw.app.ui

import ai.openclaw.app.BuildConfig
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.jarvis.JarvisScreen
import ai.openclaw.app.update.AppUpdater
import ai.openclaw.app.update.UpdateState
import android.app.Activity
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat
import kotlinx.coroutines.launch

// FORK 2026-10-19 (the architect: phone app) — what a paired Jarvis app shows after onboarding: Tinker as
// the home screen (no bottom tab bar), the trip corner, and the stock native screens one tap away
// through JarvisNative.openNative or the ⋮ menu. Back from any of them returns to Tinker.

@Composable
fun JarvisHome(
  viewModel: MainViewModel,
  modifier: Modifier = Modifier,
) {
  val screen by viewModel.jarvisScreen.collectAsState()
  val open: (JarvisScreen) -> Unit = viewModel::openJarvisScreen
  val toTinker = { viewModel.openJarvisScreen(JarvisScreen.Tinker) }

  LaunchedEffect(screen) {
    viewModel.setVoiceScreenActive(screen == JarvisScreen.Voice)
  }

  // Tinker and the trip page are dark wood; the stock screens follow the system theme.
  val view = LocalView.current
  val systemDark = isSystemInDarkTheme()
  SideEffect {
    val window = (view.context as? Activity)?.window ?: return@SideEffect
    // Every Jarvis screen is dark wood now (2026-10-20), so the system bars stay light-on-dark.
    val lightBars = false && !systemDark
    WindowCompat.getInsetsController(window, window.decorView).apply {
      isAppearanceLightStatusBars = lightBars
      isAppearanceLightNavigationBars = lightBars
    }
  }

  Box(modifier = modifier.fillMaxSize().background(jarvisWoodDark)) {
    TinkerScreen(
      viewModel = viewModel,
      visible = screen == JarvisScreen.Tinker,
      onOpenNative = open,
    )

    when (screen) {
      JarvisScreen.Tinker -> Unit
      JarvisScreen.Trip -> TripScreen(viewModel = viewModel, onBack = toTinker, onOpenNative = open)
      JarvisScreen.Terminal -> TerminalScreen(viewModel = viewModel, onBack = toTinker)
      else ->
        NativeScreenFrame(title = nativeTitle(screen), onBack = toTinker) {
          when (screen) {
            JarvisScreen.Connect -> ConnectTabScreen(viewModel = viewModel)
            JarvisScreen.Voice -> VoiceTabScreen(viewModel = viewModel)
            JarvisScreen.Screen -> ScreenTabScreen(viewModel = viewModel, visible = true)
            JarvisScreen.Settings -> JarvisSettings(viewModel = viewModel)
            else -> Unit
          }
        }
    }

    // Under Tinker's header, so it covers neither the header buttons nor the chat input.
    UpdateBanner(modifier = Modifier.align(Alignment.TopCenter))
  }
}

private fun nativeTitle(screen: JarvisScreen): String =
  when (screen) {
    JarvisScreen.Connect -> "Connection"
    JarvisScreen.Voice -> "Voice"
    JarvisScreen.Screen -> "Screen"
    JarvisScreen.Settings -> "Settings"
    else -> "Jarvis"
  }

@Composable
private fun NativeScreenFrame(
  title: String,
  onBack: () -> Unit,
  content: @Composable () -> Unit,
) {
  BackHandler(onBack = onBack)
  // Surface: an opaque layer that also keeps touches off the Tinker WebView underneath.
  // 2026-10-20 (the architect): same look as Tinker on the phone: wood palette, Tinker-sized text (0.8x).
  val density = androidx.compose.ui.platform.LocalDensity.current
  val wood = woodMobileColors()
  androidx.compose.runtime.CompositionLocalProvider(
    LocalMobileColors provides wood,
    androidx.compose.ui.platform.LocalDensity provides
      androidx.compose.ui.unit.Density(density.density, density.fontScale * 0.8f),
  ) {
  androidx.compose.material3.MaterialTheme(
    colorScheme =
      androidx.compose.material3.darkColorScheme(
        primary = wood.accent,
        onPrimary = Color(0xFF1C140F),
        secondary = wood.accent,
        surface = wood.surface,
        onSurface = wood.text,
        surfaceVariant = wood.cardSurface,
        onSurfaceVariant = wood.textSecondary,
        background = wood.surface,
        onBackground = wood.text,
        outline = wood.borderStrong,
      ),
  ) {
  Surface(modifier = Modifier.fillMaxSize(), color = mobileSurface) {
    Column(modifier = Modifier.fillMaxSize().background(mobileBackgroundGradient)) {
      Row(
        modifier =
          Modifier
            .fillMaxWidth()
            .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))
            .padding(horizontal = 4.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        IconButton(onClick = onBack) {
          Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back to Jarvis", tint = mobileText)
        }
        Text(title, style = mobileTitle2, color = mobileText)
      }
      Box(
        modifier =
          Modifier
            .weight(1f)
            .fillMaxWidth()
            .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal)),
      ) {
        content()
      }
    }
  }
  }
  }
}

/** The stock settings with a Jarvis card on top: door addresses and the app version / updater. */
@Composable
private fun JarvisSettings(viewModel: MainViewModel) {
  val candidates by viewModel.jarvisDoorCandidates.collectAsState()
  val activeDoor by viewModel.jarvisDoorOrigin.collectAsState()
  var draft by rememberSaveable(candidates) { mutableStateOf(candidates.joinToString("\n")) }
  var message by remember { mutableStateOf<String?>(null) }
  val scope = rememberCoroutineScope()
  val context = LocalContext.current

  Column(modifier = Modifier.fillMaxSize()) {
    Surface(
      modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
      shape = RoundedCornerShape(16.dp),
      color = mobileCardSurface,
      border = androidx.compose.foundation.BorderStroke(1.dp, mobileBorder),
    ) {
      Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Jarvis door", style = mobileHeadline, color = mobileText)
        Text(
          "Now using: ${activeDoor ?: "none answering"} · app ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})",
          style = mobileCaption1,
          color = mobileTextSecondary,
        )
        OutlinedTextField(
          value = draft,
          onValueChange = {
            draft = it
            message = null
          },
          label = { Text("Door addresses, tried in order") },
          modifier = Modifier.fillMaxWidth(),
          minLines = 2,
          maxLines = 4,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
          Button(onClick = {
            message = viewModel.setJarvisDoorCandidates(draft) ?: "Saved."
          }) { Text("Save") }
          OutlinedButton(onClick = {
            message = "Checking…"
            scope.launch {
              val release = AppUpdater.check(context)
              message = if (release == null) "No newer app on the door." else "Update ${release.versionName} is ready below."
            }
          }) { Text("Check for update") }
        }
        message?.let { Text(it, style = mobileCaption1, color = mobileTextSecondary) }
      }
    }
    Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
      SettingsSheet(viewModel = viewModel)
    }
  }
}

@Composable
private fun UpdateBanner(modifier: Modifier = Modifier) {
  val release by AppUpdater.available.collectAsState()
  val state by AppUpdater.state.collectAsState()
  val sheetOpen by ai.openclaw.app.update.pageSheetOpen.collectAsState()
  var dismissedCode by rememberSaveable { mutableStateOf(0L) }
  val context = LocalContext.current
  val scope = rememberCoroutineScope()
  val current = release ?: return
  // 2026-10-23: the open drop-down shows this line in its footer, so the banner leaves its rows free.
  if (sheetOpen) return
  if (dismissedCode == current.versionCode && state !is UpdateState.Failed) return

  Surface(
    modifier =
      modifier
        .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))
        .padding(start = 56.dp, end = 8.dp, top = 52.dp)
        .fillMaxWidth(),
    shape = RoundedCornerShape(14.dp),
    color = Color(0xF22A1F17),
    border = androidx.compose.foundation.BorderStroke(1.dp, Color(0x66E8B86D)),
  ) {
    Row(
      modifier = Modifier.padding(start = 14.dp, end = 4.dp, top = 6.dp, bottom = 6.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      val label = ai.openclaw.app.update.updateStatusLine() ?: return@Row
      Text(label, color = Color(0xFFF3E6CF), fontSize = 14.sp, modifier = Modifier.weight(1f))
      val busy = state is UpdateState.Downloading || state == UpdateState.Installing
      if (!busy) {
        Button(onClick = {
          AppUpdater.clearFailure()
          if (!(state == UpdateState.NeedsConfirm && AppUpdater.openConfirm(context))) {
            scope.launch { AppUpdater.downloadAndInstall(context) }
          }
        }) { Text("Install") }
        IconButton(onClick = {
          AppUpdater.clearFailure()
          dismissedCode = current.versionCode
        }) {
          Icon(Icons.Default.Close, contentDescription = "Later", tint = Color(0xFFCBBBA4))
        }
      }
    }
  }
}
