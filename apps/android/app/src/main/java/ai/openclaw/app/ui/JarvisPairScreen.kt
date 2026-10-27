package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.jarvis.jarvisDoorHostPort
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning

// FORK 2026-10-19 (the architect: phone app) — first screen of an unpaired Jarvis app. The usual way in is
// the door's pair page (its "Open in app" button fires jarvis://pair); this screen is the manual
// route: paste that link, or scan it as a QR code with the same scanner onboarding uses.

@Composable
fun JarvisPairScreen(
  viewModel: MainViewModel,
  onClassicSetup: () -> Unit,
  modifier: Modifier = Modifier,
) {
  val context = LocalContext.current
  var link by rememberSaveable { mutableStateOf("") }
  var error by rememberSaveable { mutableStateOf<String?>(null) }
  val scanner =
    remember(context) {
      GmsBarcodeScanning.getClient(
        context,
        GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build(),
      )
    }

  fun pair(raw: String) {
    val parsed = viewModel.parseJarvisPairLinkHere(raw)
    val pairLink = parsed.link
    if (pairLink == null) {
      error = parsed.error
      return
    }
    error = null
    link = ""
    viewModel.applyJarvisPairLink(pairLink)
  }

  Column(
    modifier =
      modifier
        .fillMaxSize()
        .background(mobileBackgroundGradient)
        .windowInsetsPadding(WindowInsets.safeDrawing)
        .imePadding()
        .verticalScroll(rememberScrollState())
        .padding(horizontal = 20.dp, vertical = 24.dp),
    verticalArrangement = Arrangement.spacedBy(14.dp),
  ) {
    Text("Jarvis", style = mobileDisplay, color = mobileText)
    Text("Pair this phone", style = mobileTitle1, color = mobileTextSecondary)
    Text(
      "On the laptop, run: node scripts/phone-door/devices.mjs add \"the architect phone\", then open the pairing URL " +
        "on this phone. Its \"Open in app\" button pairs in one tap. Or paste the jarvis://pair link here, " +
        "or scan it as a QR code.",
      style = mobileCallout,
      color = mobileTextSecondary,
    )
    OutlinedTextField(
      value = link,
      onValueChange = {
        link = it
        error = null
      },
      label = { Text("jarvis://pair?door=…") },
      modifier = Modifier.fillMaxWidth(),
      minLines = 2,
      maxLines = 5,
    )
    error?.let { Text(it, style = mobileCallout, color = mobileDanger) }
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
      Button(onClick = { pair(link) }) { Text("Pair with Jarvis") }
      OutlinedButton(onClick = {
        scanner
          .startScan()
          .addOnSuccessListener { barcode ->
            val contents = barcode.rawValue?.trim().orEmpty()
            if (contents.isNotEmpty()) pair(contents)
          }.addOnFailureListener {
            error = "The QR scanner could not start. Update Google Play services or paste the link."
          }
      }) { Text("Scan QR") }
    }
    TextButton(onClick = onClassicSetup) { Text("Use the classic OpenClaw setup instead") }
  }
}

/** A jarvis://pair link that came from outside the app waits for one explicit tap. */
@Composable
fun JarvisPairConfirmDialog(viewModel: MainViewModel) {
  val pending by viewModel.pendingJarvisPair.collectAsState()
  val link = pending ?: return
  val door = jarvisDoorHostPort(link.doorOrigin)?.let { (host, port) -> "$host:$port" } ?: link.doorOrigin
  val current = remember(link) { viewModel.currentJarvisDoor() }
  val currentLabel = current?.let { origin -> jarvisDoorHostPort(origin)?.let { (host, port) -> "$host:$port" } ?: origin }
  AlertDialog(
    onDismissRequest = { viewModel.dismissJarvisPair() },
    title = { Text(if (current != null) "Replace the Jarvis pairing?" else "Pair with Jarvis?") },
    text = {
      val replaces =
        if (currentLabel != null) {
          "This phone is paired with the door at $currentLabel. Accepting replaces that pairing and its tokens. "
        } else {
          ""
        }
      Text(
        replaces +
          "This phone will open Jarvis through the door at $door and connect its node (notifications, " +
          "location, camera…) to that gateway. Only accept a link you just opened yourself.",
      )
    },
    confirmButton = {
      TextButton(onClick = { viewModel.confirmJarvisPair() }) { Text(if (current != null) "Replace" else "Pair") }
    },
    dismissButton = { TextButton(onClick = { viewModel.dismissJarvisPair() }) { Text("Cancel") } },
  )
}
