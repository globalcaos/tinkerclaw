package ai.openclaw.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

class NodeForegroundService : Service() {
  private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
  private var notificationJob: Job? = null
  private var didStartForeground = false
  private var voiceCaptureMode = VoiceCaptureMode.Off

  override fun onCreate() {
    super.onCreate()
    ensureChannel()
    val initial = buildNotification(title = "OpenClaw Node", text = "Starting…")
    if (!startForegroundWithTypes(notification = initial)) return

    val runtime = (application as NodeApp).peekRuntime()
    if (runtime == null) {
      stopSelf()
      return
    }
    // FORK 2026-10-21 (the architect: phone picture backup) — nightly/weekly upload to the Pi (PhotoBackup.kt).
    if (BuildConfig.JARVIS_APP) ai.openclaw.app.jarvis.PhotoBackup.start(applicationContext)
    // 2026-10-23 (plan "phone app self-update"): the content pack's start script, then a pack check.
    if (BuildConfig.JARVIS_APP) ai.openclaw.app.jarvis.JarvisPack.onAppStart(applicationContext)
    // 2026-10-22 (the architect: "a message sent to you after every new installation"): the first start of
    // each build tells the Pi's door which versionCode is running; retried until the door has it.
    if (BuildConfig.JARVIS_APP) {
      scope.launch {
        val vc = BuildConfig.VERSION_CODE
        val sp = getSharedPreferences("jarvis-update", MODE_PRIVATE)
        while (sp.getInt("reportedVersionCode", 0) != vc) {
          kotlinx.coroutines.delay(10_000L)
          val prefs = (applicationContext as NodeApp).prefs
          val token = prefs.loadJarvisDeviceToken() ?: continue
          val origin =
            ai.openclaw.app.jarvis.JarvisDoor.origin.value
              ?: ai.openclaw.app.jarvis.JarvisDoor.resolve(prefs.jarvisDoorCandidates.value)
              ?: continue
          // 2026-10-23: who Android lists as installer and update owner. A silent self-update needs this
          // app to be both; anything else and Android asks for the tap every time.
          val src = runCatching { packageManager.getInstallSourceInfo(packageName) }.getOrNull()
          val installer = java.net.URLEncoder.encode(src?.installingPackageName ?: "", "UTF-8")
          val owner =
            java.net.URLEncoder.encode(
              if (android.os.Build.VERSION.SDK_INT >= 34) src?.updateOwnerPackageName ?: "" else "",
              "UTF-8",
            )
          val ok =
            ai.openclaw.app.jarvis.JarvisDoor.fetchText(
              origin,
              "/door/app/installed?versionCode=$vc&installer=$installer&owner=$owner",
              token,
            )
          if (ok != null) sp.edit().putInt("reportedVersionCode", vc).apply() else kotlinx.coroutines.delay(50_000L)
        }
      }
    }
    notificationJob =
      scope.launch {
        combine(
          combine(
            runtime.statusText,
            runtime.serverName,
            runtime.isConnected,
            runtime.voiceCaptureMode,
          ) { status, server, connected, mode ->
            VoiceNotificationBase(
              status = status,
              server = server,
              connected = connected,
              mode = mode,
            )
          },
          combine(
            runtime.micEnabled,
            runtime.micIsListening,
            runtime.talkModeListening,
            runtime.talkModeSpeaking,
          ) { micEnabled, micListening, talkListening, talkSpeaking ->
            VoiceNotificationCapture(
              micEnabled = micEnabled,
              micListening = micListening,
              talkListening = talkListening,
              talkSpeaking = talkSpeaking,
            )
          },
        ) { base, capture ->
          VoiceNotificationState(base = base, capture = capture)
        }.collect { state ->
          voiceCaptureMode = state.mode
          val title =
            when {
              state.connected && state.mode == VoiceCaptureMode.TalkMode -> "OpenClaw Node · Talk"
              state.connected -> "OpenClaw Node · Connected"
              else -> "OpenClaw Node"
            }
          val text =
            (state.server?.let { "${state.status} · $it" } ?: state.status) +
              voiceNotificationSuffix(
                mode = state.mode,
                manualMicEnabled = state.capture.micEnabled,
                manualMicListening = state.capture.micListening,
                talkListening = state.capture.talkListening,
                talkSpeaking = state.capture.talkSpeaking,
              )

          startForegroundWithTypes(
            notification = buildNotification(title = title, text = text),
          )
        }
      }
  }

  override fun onStartCommand(
    intent: Intent?,
    flags: Int,
    startId: Int,
  ): Int {
    when (intent?.action) {
      ACTION_STOP -> {
        (application as NodeApp).peekRuntime()?.disconnect()
        stopSelf()
        return START_NOT_STICKY
      }
      ACTION_SET_VOICE_CAPTURE_MODE -> {
        voiceCaptureMode = intent.getStringExtra(EXTRA_VOICE_CAPTURE_MODE).toVoiceCaptureMode()
        startForegroundWithTypes(
          notification =
            buildNotification(
              title = "OpenClaw Node",
              text = if (voiceCaptureMode == VoiceCaptureMode.TalkMode) "Talk mode active" else "Connected",
            ),
        )
      }
    }
    // Keep running; connection is managed by NodeRuntime (auto-reconnect + manual).
    return START_STICKY
  }

  // 2026-10-27: Android 15 calls this when a time-limited type (dataSync, 6 h a day) runs out; not stopping
  // within seconds crashes the app.
  override fun onTimeout(
    startId: Int,
    fgsType: Int,
  ) {
    Log.w("NodeForegroundService", "foreground time limit reached (type $fgsType); stopping")
    stopSelf()
  }

  override fun onDestroy() {
    notificationJob?.cancel()
    scope.cancel()
    super.onDestroy()
  }

  override fun onBind(intent: Intent?) = null

  private fun ensureChannel() {
    val mgr = getSystemService(NotificationManager::class.java)
    val channel =
      NotificationChannel(
        CHANNEL_ID,
        "Connection",
        NotificationManager.IMPORTANCE_LOW,
      ).apply {
        description = "OpenClaw node connection status"
        setShowBadge(false)
      }
    mgr.createNotificationChannel(channel)
  }

  private fun buildNotification(
    title: String,
    text: String,
  ): Notification {
    val launchIntent =
      Intent(this, MainActivity::class.java).apply {
        flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
      }
    val launchPending =
      PendingIntent.getActivity(
        this,
        1,
        launchIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )

    val stopIntent = Intent(this, NodeForegroundService::class.java).setAction(ACTION_STOP)
    val stopPending =
      PendingIntent.getService(
        this,
        2,
        stopIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )

    return NotificationCompat
      .Builder(this, CHANNEL_ID)
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle(title)
      .setContentText(text)
      .setContentIntent(launchPending)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .addAction(0, "Disconnect", stopPending)
      .build()
  }

  // 2026-10-27 (the architect: "the Jarvis app keeps stopping"): 102 crashes in one day were Android refusing the start
  // ("Time limit already exhausted for foreground service type dataSync"). A refusal now stops the service quietly;
  // the app process stays up and reconnects on the next wake. Returns false when refused.
  private fun startForegroundWithTypes(notification: Notification): Boolean {
    val serviceTypes = foregroundServiceTypesForVoiceMode(voiceCaptureMode)
    try {
      ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, serviceTypes)
    } catch (e: IllegalStateException) {
      // ForegroundServiceStartNotAllowedException (API 31+) extends IllegalStateException.
      Log.w("NodeForegroundService", "foreground start refused: ${e.message}")
      stopSelf()
      return false
    }
    didStartForeground = true
    return true
  }

  companion object {
    private const val CHANNEL_ID = "connection"
    private const val NOTIFICATION_ID = 1

    private const val ACTION_STOP = "ai.openclaw.app.action.STOP"
    private const val ACTION_SET_VOICE_CAPTURE_MODE = "ai.openclaw.app.action.SET_VOICE_CAPTURE_MODE"
    private const val EXTRA_VOICE_CAPTURE_MODE = "ai.openclaw.app.extra.VOICE_CAPTURE_MODE"

    fun start(context: Context) {
      val intent = Intent(context, NodeForegroundService::class.java)
      context.startForegroundService(intent)
    }

    fun stop(context: Context) {
      val intent = Intent(context, NodeForegroundService::class.java).setAction(ACTION_STOP)
      context.startService(intent)
    }

    fun setVoiceCaptureMode(
      context: Context,
      mode: VoiceCaptureMode,
    ) {
      val intent =
        Intent(context, NodeForegroundService::class.java)
          .setAction(ACTION_SET_VOICE_CAPTURE_MODE)
          .putExtra(EXTRA_VOICE_CAPTURE_MODE, mode.name)
      if (mode == VoiceCaptureMode.TalkMode) {
        ContextCompat.startForegroundService(context, intent)
      } else {
        context.startService(intent)
      }
    }
  }
}

internal fun foregroundServiceTypesForVoiceMode(
  mode: VoiceCaptureMode,
  jarvisApp: Boolean = BuildConfig.JARVIS_APP,
): Int {
  // 2026-10-27: Android 15 caps dataSync at 6 h per 24 h and the Jarvis build stays connected all day, so it runs as
  // specialUse (no cap; declared in src/thirdParty/AndroidManifest.xml). The Play build keeps dataSync.
  val base =
    if (jarvisApp) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
  return if (mode == VoiceCaptureMode.TalkMode) {
    base or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
  } else {
    base
  }
}

internal fun voiceNotificationSuffix(
  mode: VoiceCaptureMode,
  manualMicEnabled: Boolean,
  manualMicListening: Boolean,
  talkListening: Boolean,
  talkSpeaking: Boolean,
): String =
  when (mode) {
    VoiceCaptureMode.TalkMode ->
      when {
        talkSpeaking -> " · Talk: Speaking"
        talkListening -> " · Talk: Listening"
        else -> " · Talk: On"
      }
    VoiceCaptureMode.ManualMic ->
      if (manualMicEnabled) {
        if (manualMicListening) " · Mic: Listening" else " · Mic: Pending"
      } else {
        ""
      }
    VoiceCaptureMode.Off -> ""
  }

private fun String?.toVoiceCaptureMode(): VoiceCaptureMode =
  VoiceCaptureMode.entries.firstOrNull {
    it.name == this
  } ?: VoiceCaptureMode.Off

private data class VoiceNotificationBase(
  val status: String,
  val server: String?,
  val connected: Boolean,
  val mode: VoiceCaptureMode,
)

private data class VoiceNotificationCapture(
  val micEnabled: Boolean,
  val micListening: Boolean,
  val talkListening: Boolean,
  val talkSpeaking: Boolean,
)

private data class VoiceNotificationState(
  val base: VoiceNotificationBase,
  val capture: VoiceNotificationCapture,
) {
  val status: String
    get() = base.status
  val server: String?
    get() = base.server
  val connected: Boolean
    get() = base.connected
  val mode: VoiceCaptureMode
    get() = base.mode
}
