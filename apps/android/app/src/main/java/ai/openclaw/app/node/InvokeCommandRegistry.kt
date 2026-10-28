package ai.openclaw.app.node

import ai.openclaw.app.protocol.OpenClawCalendarCommand
import ai.openclaw.app.protocol.OpenClawCallLogCommand
import ai.openclaw.app.protocol.OpenClawCameraCommand
import ai.openclaw.app.protocol.OpenClawCanvasA2UICommand
import ai.openclaw.app.protocol.OpenClawCanvasCommand
import ai.openclaw.app.protocol.OpenClawCapability
import ai.openclaw.app.protocol.OpenClawContactsCommand
import ai.openclaw.app.protocol.OpenClawDeviceCommand
import ai.openclaw.app.protocol.OpenClawLocationCommand
import ai.openclaw.app.protocol.OpenClawMotionCommand
import ai.openclaw.app.protocol.OpenClawNotificationsCommand
import ai.openclaw.app.protocol.OpenClawPhotosCommand
import ai.openclaw.app.protocol.OpenClawSmsCommand
import ai.openclaw.app.protocol.OpenClawSystemCommand

data class NodeRuntimeFlags(
  val cameraEnabled: Boolean,
  val locationEnabled: Boolean,
  val sendSmsAvailable: Boolean,
  val readSmsAvailable: Boolean,
  val smsSearchPossible: Boolean,
  val callLogAvailable: Boolean,
  val voiceWakeEnabled: Boolean,
  val motionActivityAvailable: Boolean,
  val motionPedometerAvailable: Boolean,
  val debugBuild: Boolean,
)

enum class InvokeCommandAvailability {
  Always,
  CameraEnabled,
  LocationEnabled,
  SendSmsAvailable,
  ReadSmsAvailable,
  RequestableSmsSearchAvailable,
  CallLogAvailable,
  MotionActivityAvailable,
  MotionPedometerAvailable,
  DebugBuild,
}

enum class NodeCapabilityAvailability {
  Always,
  CameraEnabled,
  LocationEnabled,
  SmsAvailable,
  CallLogAvailable,
  VoiceWakeEnabled,
  MotionAvailable,
}

data class NodeCapabilitySpec(
  val name: String,
  val availability: NodeCapabilityAvailability = NodeCapabilityAvailability.Always,
)

data class InvokeCommandSpec(
  val name: String,
  val requiresForeground: Boolean = false,
  val availability: InvokeCommandAvailability = InvokeCommandAvailability.Always,
)

object InvokeCommandRegistry {
  val capabilityManifest: List<NodeCapabilitySpec> =
    listOf(
      NodeCapabilitySpec(name = OpenClawCapability.Canvas.rawValue),
      NodeCapabilitySpec(name = OpenClawCapability.Device.rawValue),
      NodeCapabilitySpec(name = OpenClawCapability.Notifications.rawValue),
      NodeCapabilitySpec(name = OpenClawCapability.System.rawValue),
      NodeCapabilitySpec(
        name = OpenClawCapability.Camera.rawValue,
        availability = NodeCapabilityAvailability.CameraEnabled,
      ),
      NodeCapabilitySpec(
        name = OpenClawCapability.Sms.rawValue,
        availability = NodeCapabilityAvailability.SmsAvailable,
      ),
      NodeCapabilitySpec(
        name = OpenClawCapability.VoiceWake.rawValue,
        availability = NodeCapabilityAvailability.VoiceWakeEnabled,
      ),
      NodeCapabilitySpec(
        name = OpenClawCapability.Location.rawValue,
        availability = NodeCapabilityAvailability.LocationEnabled,
      ),
      NodeCapabilitySpec(name = OpenClawCapability.Photos.rawValue),
      NodeCapabilitySpec(name = OpenClawCapability.Contacts.rawValue),
      NodeCapabilitySpec(name = OpenClawCapability.Calendar.rawValue),
      NodeCapabilitySpec(
        name = OpenClawCapability.Motion.rawValue,
        availability = NodeCapabilityAvailability.MotionAvailable,
      ),
      NodeCapabilitySpec(
        name = OpenClawCapability.CallLog.rawValue,
        availability = NodeCapabilityAvailability.CallLogAvailable,
      ),
    )

  val all: List<InvokeCommandSpec> =
    listOf(
      InvokeCommandSpec(
        name = OpenClawCanvasCommand.Present.rawValue,
        requiresForeground = true,
      ),
      InvokeCommandSpec(
        name = OpenClawCanvasCommand.Hide.rawValue,
        requiresForeground = true,
      ),
      InvokeCommandSpec(
        name = OpenClawCanvasCommand.Navigate.rawValue,
        requiresForeground = true,
      ),
      InvokeCommandSpec(
        name = OpenClawCanvasCommand.Eval.rawValue,
        requiresForeground = true,
      ),
      InvokeCommandSpec(
        name = OpenClawCanvasCommand.Snapshot.rawValue,
        requiresForeground = true,
      ),
      InvokeCommandSpec(
        name = "jarvis.screenshot",
        requiresForeground = true,
      ),
      InvokeCommandSpec(
        name = "jarvis.tinker.eval",
        requiresForeground = true,
      ),
      InvokeCommandSpec(
        name = "jarvis.update",
        requiresForeground = false,
      ),
      InvokeCommandSpec(name = "jarvis.backup.run"),
      InvokeCommandSpec(name = "jarvis.backup.status"),
      InvokeCommandSpec(
        name = "jarvis.ring",
        requiresForeground = false,
      ),
      // 2026-10-22: Jarvis speaks a (discreet) line on the phone, app open or closed (JarvisSay.kt).
      InvokeCommandSpec(
        name = "jarvis.say",
        requiresForeground = false,
      ),
      InvokeCommandSpec(
        name = "jarvis.ring.stop",
        requiresForeground = false,
      ),
      // 2026-10-23 (plan "phone app self-update"): the layer-1 verbs and the content pack (JarvisVerbs.kt,
      // JarvisPack.kt). Each also needs gateway.nodes.allowCommands, or the gateway refuses it.
      InvokeCommandSpec(name = "jarvis.buzz"),
      InvokeCommandSpec(name = "jarvis.play"),
      InvokeCommandSpec(name = "jarvis.notify"),
      InvokeCommandSpec(name = "jarvis.open"),
      InvokeCommandSpec(name = "jarvis.keepAwake"),
      // 2026-10-28: the icon's number, sent by the Pi while the app sleeps (JarvisBadge.kt).
      InvokeCommandSpec(name = "jarvis.badge", requiresForeground = false),
      InvokeCommandSpec(name = "jarvis.pack.status"),
      InvokeCommandSpec(name = "jarvis.pack.update"),
      InvokeCommandSpec(name = "jarvis.pack.run"),
      InvokeCommandSpec(
        name = "jarvis.files.list",
        requiresForeground = false,
      ),
      InvokeCommandSpec(
        name = "jarvis.files.get",
        requiresForeground = false,
      ),
      InvokeCommandSpec(
        name = OpenClawCanvasA2UICommand.Push.rawValue,
        requiresForeground = true,
      ),
      InvokeCommandSpec(
        name = OpenClawCanvasA2UICommand.PushJSONL.rawValue,
        requiresForeground = true,
      ),
      InvokeCommandSpec(
        name = OpenClawCanvasA2UICommand.Reset.rawValue,
        requiresForeground = true,
      ),
      InvokeCommandSpec(
        name = OpenClawSystemCommand.Notify.rawValue,
      ),
      InvokeCommandSpec(
        name = OpenClawCameraCommand.List.rawValue,
        requiresForeground = true,
        availability = InvokeCommandAvailability.CameraEnabled,
      ),
      InvokeCommandSpec(
        name = OpenClawCameraCommand.Snap.rawValue,
        requiresForeground = true,
        availability = InvokeCommandAvailability.CameraEnabled,
      ),
      InvokeCommandSpec(
        name = OpenClawCameraCommand.Clip.rawValue,
        requiresForeground = true,
        availability = InvokeCommandAvailability.CameraEnabled,
      ),
      InvokeCommandSpec(
        name = OpenClawLocationCommand.Get.rawValue,
        availability = InvokeCommandAvailability.LocationEnabled,
      ),
      InvokeCommandSpec(
        name = OpenClawDeviceCommand.Status.rawValue,
      ),
      InvokeCommandSpec(
        name = OpenClawDeviceCommand.Info.rawValue,
      ),
      InvokeCommandSpec(
        name = OpenClawDeviceCommand.Permissions.rawValue,
      ),
      InvokeCommandSpec(
        name = OpenClawDeviceCommand.Health.rawValue,
      ),
      InvokeCommandSpec(
        name = OpenClawNotificationsCommand.List.rawValue,
      ),
      InvokeCommandSpec(
        name = OpenClawNotificationsCommand.Actions.rawValue,
      ),
      InvokeCommandSpec(
        name = OpenClawPhotosCommand.Latest.rawValue,
      ),
      InvokeCommandSpec(
        name = OpenClawContactsCommand.Search.rawValue,
      ),
      InvokeCommandSpec(
        name = OpenClawContactsCommand.Add.rawValue,
      ),
      InvokeCommandSpec(
        name = OpenClawCalendarCommand.Events.rawValue,
      ),
      InvokeCommandSpec(
        name = OpenClawCalendarCommand.Add.rawValue,
      ),
      InvokeCommandSpec(
        name = OpenClawMotionCommand.Activity.rawValue,
        availability = InvokeCommandAvailability.MotionActivityAvailable,
      ),
      InvokeCommandSpec(
        name = OpenClawMotionCommand.Pedometer.rawValue,
        availability = InvokeCommandAvailability.MotionPedometerAvailable,
      ),
      InvokeCommandSpec(
        name = OpenClawSmsCommand.Send.rawValue,
        availability = InvokeCommandAvailability.SendSmsAvailable,
      ),
      InvokeCommandSpec(
        name = OpenClawSmsCommand.Search.rawValue,
        availability = InvokeCommandAvailability.RequestableSmsSearchAvailable,
      ),
      InvokeCommandSpec(
        name = OpenClawCallLogCommand.Search.rawValue,
        availability = InvokeCommandAvailability.CallLogAvailable,
      ),
      InvokeCommandSpec(
        name = "debug.logs",
        availability = InvokeCommandAvailability.DebugBuild,
      ),
      InvokeCommandSpec(
        name = "debug.ed25519",
        availability = InvokeCommandAvailability.DebugBuild,
      ),
    )

  private val byNameInternal: Map<String, InvokeCommandSpec> = all.associateBy { it.name }

  fun find(command: String): InvokeCommandSpec? = byNameInternal[command]

  fun advertisedCapabilities(flags: NodeRuntimeFlags): List<String> =
    capabilityManifest
      .filter { spec ->
        when (spec.availability) {
          NodeCapabilityAvailability.Always -> true
          NodeCapabilityAvailability.CameraEnabled -> flags.cameraEnabled
          NodeCapabilityAvailability.LocationEnabled -> flags.locationEnabled
          NodeCapabilityAvailability.SmsAvailable -> flags.sendSmsAvailable || flags.readSmsAvailable
          NodeCapabilityAvailability.CallLogAvailable -> flags.callLogAvailable
          NodeCapabilityAvailability.VoiceWakeEnabled -> flags.voiceWakeEnabled
          NodeCapabilityAvailability.MotionAvailable -> flags.motionActivityAvailable || flags.motionPedometerAvailable
        }
      }.map { it.name }

  fun advertisedCommands(flags: NodeRuntimeFlags): List<String> =
    all
      .filter { spec ->
        when (spec.availability) {
          InvokeCommandAvailability.Always -> true
          InvokeCommandAvailability.CameraEnabled -> flags.cameraEnabled
          InvokeCommandAvailability.LocationEnabled -> flags.locationEnabled
          InvokeCommandAvailability.SendSmsAvailable -> flags.sendSmsAvailable
          InvokeCommandAvailability.ReadSmsAvailable -> flags.readSmsAvailable
          InvokeCommandAvailability.RequestableSmsSearchAvailable -> flags.smsSearchPossible
          InvokeCommandAvailability.CallLogAvailable -> flags.callLogAvailable
          InvokeCommandAvailability.MotionActivityAvailable -> flags.motionActivityAvailable
          InvokeCommandAvailability.MotionPedometerAvailable -> flags.motionPedometerAvailable
          InvokeCommandAvailability.DebugBuild -> flags.debugBuild
        }
      }.map { it.name }
}
