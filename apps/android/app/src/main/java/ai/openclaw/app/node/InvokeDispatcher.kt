package ai.openclaw.app.node

import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.protocol.OpenClawCalendarCommand
import ai.openclaw.app.protocol.OpenClawCallLogCommand
import ai.openclaw.app.protocol.OpenClawCameraCommand
import ai.openclaw.app.protocol.OpenClawCanvasA2UICommand
import ai.openclaw.app.protocol.OpenClawCanvasCommand
import ai.openclaw.app.protocol.OpenClawContactsCommand
import ai.openclaw.app.protocol.OpenClawDeviceCommand
import ai.openclaw.app.protocol.OpenClawLocationCommand
import ai.openclaw.app.protocol.OpenClawMotionCommand
import ai.openclaw.app.protocol.OpenClawNotificationsCommand
import ai.openclaw.app.protocol.OpenClawSmsCommand
import ai.openclaw.app.protocol.OpenClawSystemCommand

internal enum class SmsSearchAvailabilityReason {
  Available,
  PermissionRequired,
  Unavailable,
}

internal fun classifySmsSearchAvailability(
  readSmsAvailable: Boolean,
  smsFeatureEnabled: Boolean,
  smsTelephonyAvailable: Boolean,
): SmsSearchAvailabilityReason {
  if (readSmsAvailable) return SmsSearchAvailabilityReason.Available
  if (!smsFeatureEnabled || !smsTelephonyAvailable) return SmsSearchAvailabilityReason.Unavailable
  return SmsSearchAvailabilityReason.PermissionRequired
}

internal fun smsSearchAvailabilityError(
  readSmsAvailable: Boolean,
  smsFeatureEnabled: Boolean,
  smsTelephonyAvailable: Boolean,
): GatewaySession.InvokeResult? =
  when (
    classifySmsSearchAvailability(
      readSmsAvailable = readSmsAvailable,
      smsFeatureEnabled = smsFeatureEnabled,
      smsTelephonyAvailable = smsTelephonyAvailable,
    )
  ) {
    SmsSearchAvailabilityReason.Available,
    SmsSearchAvailabilityReason.PermissionRequired,
    -> null
    SmsSearchAvailabilityReason.Unavailable ->
      GatewaySession.InvokeResult.error(
        code = "SMS_UNAVAILABLE",
        message = "SMS_UNAVAILABLE: SMS not available on this device",
      )
  }

class InvokeDispatcher(
  private val canvas: CanvasController,
  private val cameraHandler: CameraHandler,
  private val locationHandler: LocationHandler,
  private val deviceHandler: DeviceHandler,
  private val notificationsHandler: NotificationsHandler,
  private val systemHandler: SystemHandler,
  private val photosHandler: PhotosHandler,
  private val contactsHandler: ContactsHandler,
  private val calendarHandler: CalendarHandler,
  private val motionHandler: MotionHandler,
  private val smsHandler: SmsHandler,
  private val a2uiHandler: A2UIHandler,
  private val debugHandler: DebugHandler,
  private val callLogHandler: CallLogHandler,
  private val isForeground: () -> Boolean,
  private val cameraEnabled: () -> Boolean,
  private val locationEnabled: () -> Boolean,
  private val sendSmsAvailable: () -> Boolean,
  private val readSmsAvailable: () -> Boolean,
  private val smsFeatureEnabled: () -> Boolean,
  private val smsTelephonyAvailable: () -> Boolean,
  private val callLogAvailable: () -> Boolean,
  private val debugBuild: () -> Boolean,
  private val refreshNodeCanvasCapability: suspend () -> Boolean,
  private val onCanvasA2uiPush: () -> Unit,
  private val onCanvasA2uiReset: () -> Unit,
  private val motionActivityAvailable: () -> Boolean,
  private val motionPedometerAvailable: () -> Boolean,
) {
  suspend fun handleInvoke(
    command: String,
    paramsJson: String?,
  ): GatewaySession.InvokeResult {
    val spec =
      InvokeCommandRegistry.find(command)
        ?: return GatewaySession.InvokeResult.error(
          code = "INVALID_REQUEST",
          message = "INVALID_REQUEST: unknown command",
        )
    if (spec.requiresForeground && !isForeground()) {
      return GatewaySession.InvokeResult.error(
        code = "NODE_BACKGROUND_UNAVAILABLE",
        message = "NODE_BACKGROUND_UNAVAILABLE: canvas/camera/screen commands require foreground",
      )
    }
    availabilityError(spec.availability)?.let { return it }

    return when (command) {
      // Canvas commands
      OpenClawCanvasCommand.Present.rawValue -> {
        val url = CanvasController.parseNavigateUrl(paramsJson)
        canvas.navigate(url)
        GatewaySession.InvokeResult.ok(null)
      }
      OpenClawCanvasCommand.Hide.rawValue -> GatewaySession.InvokeResult.ok(null)
      OpenClawCanvasCommand.Navigate.rawValue -> {
        val url = CanvasController.parseNavigateUrl(paramsJson)
        canvas.navigate(url)
        GatewaySession.InvokeResult.ok(null)
      }
      OpenClawCanvasCommand.Eval.rawValue -> {
        val js =
          CanvasController.parseEvalJs(paramsJson)
            ?: return GatewaySession.InvokeResult.error(
              code = "INVALID_REQUEST",
              message = "INVALID_REQUEST: javaScript required",
            )
        withCanvasAvailable {
          val result = canvas.eval(js)
          GatewaySession.InvokeResult.ok("""{"result":${result.toJsonString()}}""")
        }
      }
      OpenClawCanvasCommand.Snapshot.rawValue -> {
        val snapshotParams = CanvasController.parseSnapshotParams(paramsJson)
        withCanvasAvailable {
          val base64 =
            canvas.snapshotBase64(
              format = snapshotParams.format,
              quality = snapshotParams.quality,
              maxWidth = snapshotParams.maxWidth,
            )
          GatewaySession.InvokeResult.ok("""{"format":"${snapshotParams.format.rawValue}","base64":"$base64"}""")
        }
      }

      // Jarvis: let the agent see what the owner sees (JarvisLook.kt).
      "jarvis.screenshot" -> {
        val o = runCatching { org.json.JSONObject(paramsJson ?: "{}") }.getOrElse { org.json.JSONObject() }
        runCatching {
          ai.openclaw.app.jarvis.JarvisLook.screenshotJson(
            maxWidth = o.optInt("maxWidth", 720),
            quality = o.optInt("quality", 70),
          )
        }.fold(
          onSuccess = { GatewaySession.InvokeResult.ok(it) },
          onFailure = { GatewaySession.InvokeResult.error(code = "UNAVAILABLE", message = "UNAVAILABLE: ${it.message}") },
        )
      }
      // Jarvis pushes an app update itself: the same download + silent install the banner runs.
      "jarvis.update" -> {
        runCatching { ai.openclaw.app.update.AppUpdater.downloadAndInstall(ai.openclaw.app.jarvis.JarvisLook.appContext()) }.fold(
          onSuccess = { GatewaySession.InvokeResult.ok("""{"started":true}""") },
          onFailure = { GatewaySession.InvokeResult.error(code = "UNAVAILABLE", message = "UNAVAILABLE: ${it.message}") },
        )
      }
      // Jarvis: phone pictures -> the Pi's disk (PhotoBackup.kt). run starts one now, status reports.
      "jarvis.backup.run" -> {
        val o = runCatching { org.json.JSONObject(paramsJson ?: "{}") }.getOrElse { org.json.JSONObject() }
        val minutes = o.optInt("minutes", 10).coerceIn(1, 120)
        runCatching {
          ai.openclaw.app.jarvis.PhotoBackup.runNow(
            ai.openclaw.app.jarvis.JarvisLook.appContext(),
            budgetMs = minutes * 60_000L,
            force = o.optBoolean("force", false),
            reason = o.optString("reason", "manual"),
          )
        }.fold(
          onSuccess = { GatewaySession.InvokeResult.ok("""{"started":$it,"minutes":$minutes}""") },
          onFailure = { GatewaySession.InvokeResult.error(code = "UNAVAILABLE", message = "UNAVAILABLE: ${it.message}") },
        )
      }
      "jarvis.backup.status" ->
        runCatching {
          ai.openclaw.app.jarvis.PhotoBackup.statusJson(ai.openclaw.app.jarvis.JarvisLook.appContext())
        }.fold(
          onSuccess = { GatewaySession.InvokeResult.ok(it) },
          onFailure = { GatewaySession.InvokeResult.error(code = "UNAVAILABLE", message = "UNAVAILABLE: ${it.message}") },
        )
      // Find my phone: ring at full alarm volume, ignoring silent mode (JarvisRing.kt).
      // Jarvis calls the architect by voice (JarvisSay.kt): {"text": "..."}; returns at once, speaks in the background.
      // 2026-10-23 (plan "phone app self-update", layer 1): the six phone verbs, the same code the page
      // and pack scripts use (JarvisVerbs.kt). jarvis.say {text, voice?, buzz?}: buzz = the old
      // locked-phone flag, kept so a Pi script written for the build before still works.
      "jarvis.say", "jarvis.buzz", "jarvis.play", "jarvis.notify", "jarvis.open", "jarvis.keepAwake", "jarvis.badge" ->
        jarvisVerb(command.removePrefix("jarvis."), paramsJson)
      // Layer 2: the content pack (JarvisPack.kt).
      "jarvis.pack.status" -> GatewaySession.InvokeResult.ok(ai.openclaw.app.jarvis.JarvisPack.status(ai.openclaw.app.jarvis.JarvisLook.appContext()).toString())
      "jarvis.pack.update" -> {
        val outcome = ai.openclaw.app.jarvis.JarvisPack.check(ai.openclaw.app.jarvis.JarvisLook.appContext(), "command")
        GatewaySession.InvokeResult.ok(kotlinx.serialization.json.JsonObject(mapOf("outcome" to kotlinx.serialization.json.JsonPrimitive(outcome))).toString())
      }
      "jarvis.pack.run" -> {
        val params = parseJsonObject(paramsJson)
        val event = (params["event"] as? kotlinx.serialization.json.JsonPrimitive)?.content?.trim().orEmpty()
        if (!event.matches(Regex("^[A-Za-z][A-Za-z0-9_-]{0,40}$"))) {
          GatewaySession.InvokeResult.error(code = "INVALID_REQUEST", message = "INVALID_REQUEST: event name required")
        } else {
          val data = params["data"] as? kotlinx.serialization.json.JsonObject ?: kotlinx.serialization.json.JsonObject(emptyMap())
          runCatching { ai.openclaw.app.jarvis.JarvisPack.runEvent(ai.openclaw.app.jarvis.JarvisLook.appContext(), event, data) }.fold(
            onSuccess = { GatewaySession.InvokeResult.ok(it.toString()) },
            onFailure = { GatewaySession.InvokeResult.error(code = "UNAVAILABLE", message = "UNAVAILABLE: script failed: ${it.message}") },
          )
        }
      }
      "jarvis.ring" -> {
        val secs = runCatching { org.json.JSONObject(paramsJson ?: "{}").optInt("seconds", 60) }.getOrDefault(60)
        runCatching { ai.openclaw.app.jarvis.JarvisRing.ring(ai.openclaw.app.jarvis.JarvisLook.appContext(), secs) }.fold(
          onSuccess = { GatewaySession.InvokeResult.ok(it) },
          onFailure = { GatewaySession.InvokeResult.error(code = "UNAVAILABLE", message = "UNAVAILABLE: ${it.message}") },
        )
      }
      "jarvis.ring.stop" -> {
        android.os.Handler(android.os.Looper.getMainLooper()).post { ai.openclaw.app.jarvis.JarvisRing.stop() }
        GatewaySession.InvokeResult.ok("""{"stopping":true}""")
      }
      // Downloads folder, read-only (JarvisFiles.kt).
      "jarvis.files.list" -> {
        val limit = runCatching { org.json.JSONObject(paramsJson ?: "{}").optInt("limit", 10) }.getOrDefault(10)
        runCatching { ai.openclaw.app.jarvis.JarvisFiles.listJson(ai.openclaw.app.jarvis.JarvisLook.appContext(), limit) }.fold(
          onSuccess = { GatewaySession.InvokeResult.ok(it) },
          onFailure = { GatewaySession.InvokeResult.error(code = "UNAVAILABLE", message = "UNAVAILABLE: ${it.message}") },
        )
      }
      "jarvis.files.get" -> {
        val name = runCatching { org.json.JSONObject(paramsJson ?: "{}").optString("name") }.getOrDefault("")
        runCatching { ai.openclaw.app.jarvis.JarvisFiles.getJson(ai.openclaw.app.jarvis.JarvisLook.appContext(), name) }.fold(
          onSuccess = { GatewaySession.InvokeResult.ok(it) },
          onFailure = { GatewaySession.InvokeResult.error(code = "UNAVAILABLE", message = "UNAVAILABLE: ${it.message}") },
        )
      }
      "jarvis.tinker.eval" -> {
        val js =
          runCatching { org.json.JSONObject(paramsJson ?: "{}").optString("javaScript") }.getOrNull()
            ?.takeIf { it.isNotBlank() }
            ?: return GatewaySession.InvokeResult.error(code = "INVALID_REQUEST", message = "INVALID_REQUEST: javaScript required")
        runCatching { ai.openclaw.app.jarvis.JarvisLook.tinkerEvalJson(js) }.fold(
          onSuccess = { GatewaySession.InvokeResult.ok(it) },
          onFailure = { GatewaySession.InvokeResult.error(code = "UNAVAILABLE", message = "UNAVAILABLE: ${it.message}") },
        )
      }

      // A2UI commands
      OpenClawCanvasA2UICommand.Reset.rawValue ->
        withReadyA2ui {
          withCanvasAvailable {
            val res = canvas.eval(A2UIHandler.a2uiResetJS)
            onCanvasA2uiReset()
            GatewaySession.InvokeResult.ok(res)
          }
        }
      OpenClawCanvasA2UICommand.Push.rawValue, OpenClawCanvasA2UICommand.PushJSONL.rawValue -> {
        val messages =
          try {
            a2uiHandler.decodeA2uiMessages(command, paramsJson)
          } catch (err: Throwable) {
            return GatewaySession.InvokeResult.error(
              code = "INVALID_REQUEST",
              message = err.message ?: "invalid A2UI payload",
            )
          }
        withReadyA2ui {
          withCanvasAvailable {
            val js = A2UIHandler.a2uiApplyMessagesJS(messages)
            val res = canvas.eval(js)
            onCanvasA2uiPush()
            GatewaySession.InvokeResult.ok(res)
          }
        }
      }

      // Camera commands
      OpenClawCameraCommand.List.rawValue -> cameraHandler.handleList(paramsJson)
      OpenClawCameraCommand.Snap.rawValue -> cameraHandler.handleSnap(paramsJson)
      OpenClawCameraCommand.Clip.rawValue -> cameraHandler.handleClip(paramsJson)

      // Location command
      OpenClawLocationCommand.Get.rawValue -> locationHandler.handleLocationGet(paramsJson)

      // Device commands
      OpenClawDeviceCommand.Status.rawValue -> deviceHandler.handleDeviceStatus(paramsJson)
      OpenClawDeviceCommand.Info.rawValue -> deviceHandler.handleDeviceInfo(paramsJson)
      OpenClawDeviceCommand.Permissions.rawValue -> deviceHandler.handleDevicePermissions(paramsJson)
      OpenClawDeviceCommand.Health.rawValue -> deviceHandler.handleDeviceHealth(paramsJson)

      // Notifications command
      OpenClawNotificationsCommand.List.rawValue -> notificationsHandler.handleNotificationsList(paramsJson)
      OpenClawNotificationsCommand.Actions.rawValue -> notificationsHandler.handleNotificationsActions(paramsJson)

      // System command
      OpenClawSystemCommand.Notify.rawValue -> systemHandler.handleSystemNotify(paramsJson)

      // Photos command
      ai.openclaw.app.protocol.OpenClawPhotosCommand.Latest.rawValue ->
        photosHandler.handlePhotosLatest(
          paramsJson,
        )

      // Contacts command
      OpenClawContactsCommand.Search.rawValue -> contactsHandler.handleContactsSearch(paramsJson)
      OpenClawContactsCommand.Add.rawValue -> contactsHandler.handleContactsAdd(paramsJson)

      // Calendar command
      OpenClawCalendarCommand.Events.rawValue -> calendarHandler.handleCalendarEvents(paramsJson)
      OpenClawCalendarCommand.Add.rawValue -> calendarHandler.handleCalendarAdd(paramsJson)

      // Motion command
      OpenClawMotionCommand.Activity.rawValue -> motionHandler.handleMotionActivity(paramsJson)
      OpenClawMotionCommand.Pedometer.rawValue -> motionHandler.handleMotionPedometer(paramsJson)

      // SMS command
      OpenClawSmsCommand.Send.rawValue -> smsHandler.handleSmsSend(paramsJson)
      OpenClawSmsCommand.Search.rawValue -> smsHandler.handleSmsSearch(paramsJson)

      // CallLog command
      OpenClawCallLogCommand.Search.rawValue -> callLogHandler.handleCallLogSearch(paramsJson)

      // Debug commands
      "debug.ed25519" -> debugHandler.handleEd25519()
      "debug.logs" -> debugHandler.handleLogs()
      else -> GatewaySession.InvokeResult.error(code = "INVALID_REQUEST", message = "INVALID_REQUEST: unknown command")
    }
  }

  private fun parseJsonObject(paramsJson: String?): kotlinx.serialization.json.JsonObject =
    paramsJson
      ?.takeIf { it.isNotBlank() }
      ?.let { runCatching { kotlinx.serialization.json.Json.parseToJsonElement(it) as? kotlinx.serialization.json.JsonObject }.getOrNull() }
      ?: kotlinx.serialization.json.JsonObject(emptyMap())

  private fun jarvisVerb(
    verb: String,
    paramsJson: String?,
  ): GatewaySession.InvokeResult =
    runCatching { ai.openclaw.app.jarvis.JarvisVerbs.run(ai.openclaw.app.jarvis.JarvisLook.appContext(), verb, parseJsonObject(paramsJson)) }.fold(
      onSuccess = { GatewaySession.InvokeResult.ok(it.toString()) },
      onFailure = {
        val code = if (it is IllegalArgumentException) "INVALID_REQUEST" else "UNAVAILABLE"
        GatewaySession.InvokeResult.error(code = code, message = "$code: ${it.message}")
      },
    )

  private suspend fun withReadyA2ui(block: suspend () -> GatewaySession.InvokeResult): GatewaySession.InvokeResult {
    var a2uiUrl =
      a2uiHandler.resolveA2uiHostUrl()
        ?: return GatewaySession.InvokeResult.error(
          code = "A2UI_HOST_NOT_CONFIGURED",
          message = "A2UI_HOST_NOT_CONFIGURED: gateway did not advertise canvas host",
        )
    val readyOnFirstCheck = a2uiHandler.ensureA2uiReady(a2uiUrl)
    if (!readyOnFirstCheck) {
      if (!refreshNodeCanvasCapability()) {
        return GatewaySession.InvokeResult.error(
          code = "A2UI_HOST_UNAVAILABLE",
          message = "A2UI_HOST_UNAVAILABLE: A2UI host not reachable",
        )
      }
      a2uiUrl = a2uiHandler.resolveA2uiHostUrl()
        ?: return GatewaySession.InvokeResult.error(
          code = "A2UI_HOST_NOT_CONFIGURED",
          message = "A2UI_HOST_NOT_CONFIGURED: gateway did not advertise canvas host",
        )
      if (!a2uiHandler.ensureA2uiReady(a2uiUrl)) {
        return GatewaySession.InvokeResult.error(
          code = "A2UI_HOST_UNAVAILABLE",
          message = "A2UI_HOST_UNAVAILABLE: A2UI host not reachable",
        )
      }
    }
    return block()
  }

  private suspend fun withCanvasAvailable(block: suspend () -> GatewaySession.InvokeResult): GatewaySession.InvokeResult =
    try {
      block()
    } catch (_: Throwable) {
      GatewaySession.InvokeResult.error(
        code = "NODE_BACKGROUND_UNAVAILABLE",
        message = "NODE_BACKGROUND_UNAVAILABLE: canvas unavailable",
      )
    }

  private fun availabilityError(availability: InvokeCommandAvailability): GatewaySession.InvokeResult? =
    when (availability) {
      InvokeCommandAvailability.Always -> null
      InvokeCommandAvailability.CameraEnabled ->
        if (cameraEnabled()) {
          null
        } else {
          GatewaySession.InvokeResult.error(
            code = "CAMERA_DISABLED",
            message = "CAMERA_DISABLED: enable Camera in Settings",
          )
        }
      InvokeCommandAvailability.LocationEnabled ->
        if (locationEnabled()) {
          null
        } else {
          GatewaySession.InvokeResult.error(
            code = "LOCATION_DISABLED",
            message = "LOCATION_DISABLED: enable Location in Settings",
          )
        }
      InvokeCommandAvailability.MotionActivityAvailable ->
        if (motionActivityAvailable()) {
          null
        } else {
          GatewaySession.InvokeResult.error(
            code = "MOTION_UNAVAILABLE",
            message = "MOTION_UNAVAILABLE: accelerometer not available",
          )
        }
      InvokeCommandAvailability.MotionPedometerAvailable ->
        if (motionPedometerAvailable()) {
          null
        } else {
          GatewaySession.InvokeResult.error(
            code = "PEDOMETER_UNAVAILABLE",
            message = "PEDOMETER_UNAVAILABLE: step counter not available",
          )
        }
      InvokeCommandAvailability.SendSmsAvailable ->
        if (sendSmsAvailable()) {
          null
        } else {
          GatewaySession.InvokeResult.error(
            code = "SMS_UNAVAILABLE",
            message = "SMS_UNAVAILABLE: SMS not available on this device",
          )
        }
      InvokeCommandAvailability.ReadSmsAvailable,
      InvokeCommandAvailability.RequestableSmsSearchAvailable,
      ->
        smsSearchAvailabilityError(
          readSmsAvailable = readSmsAvailable(),
          smsFeatureEnabled = smsFeatureEnabled(),
          smsTelephonyAvailable = smsTelephonyAvailable(),
        )
      InvokeCommandAvailability.CallLogAvailable ->
        if (callLogAvailable()) {
          null
        } else {
          GatewaySession.InvokeResult.error(
            code = "CALL_LOG_UNAVAILABLE",
            message = "CALL_LOG_UNAVAILABLE: call log not available on this build",
          )
        }
      InvokeCommandAvailability.DebugBuild ->
        if (debugBuild()) {
          null
        } else {
          GatewaySession.InvokeResult.error(
            code = "INVALID_REQUEST",
            message = "INVALID_REQUEST: unknown command",
          )
        }
    }
}
