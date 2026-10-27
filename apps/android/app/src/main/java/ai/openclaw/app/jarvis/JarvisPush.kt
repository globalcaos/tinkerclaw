package ai.openclaw.app.jarvis

import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeForegroundService
import android.content.Context
import android.util.Log
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Lets the gateway wake this app when Android has put it to sleep (2026-10-22, the architect: "can you now
 * wake up the phone app when needed?"). The gateway sends a high-priority FCM data message
 * {type:"wake"} (src/infra/push-fcm.ts); Android delivers it even to a sleeping app, which then
 * restarts its node service and opens a fresh socket. The token reaches the gateway as node event
 * push.fcm.register on every connect. A build without google-services.json has no Firebase app,
 * and everything here is a no-op.
 */
object JarvisPush {
  private const val TAG = "JarvisPush"

  private fun enabled(context: Context): Boolean = FirebaseApp.getApps(context).isNotEmpty()

  /** The current FCM token, delivered asynchronously; nothing when Firebase is not set up. */
  // firebase-messaging 26 marks the token API deprecated; it still works and has no drop-in successor.
  @Suppress("DEPRECATION")
  fun withToken(
    context: Context,
    use: (String) -> Unit,
  ) {
    if (!enabled(context)) return
    runCatching {
      FirebaseMessaging.getInstance().token
        .addOnSuccessListener { token -> if (!token.isNullOrBlank()) use(token) }
        .addOnFailureListener { Log.w(TAG, "token: ${it.message}") }
    }.onFailure { Log.w(TAG, "token: ${it.message}") }
  }

  fun onWake(
    context: Context,
    reason: String?,
  ) {
    Log.i(TAG, "wake ($reason)")
    val app = context.applicationContext as NodeApp
    val runtime = app.ensureRuntime()
    // A high-priority FCM message is one of the cases Android allows a foreground service start from.
    runCatching { NodeForegroundService.start(app) }.onFailure { Log.w(TAG, "service: ${it.message}") }
    runtime.wakeFromPush()
    // 2026-10-23: a wake is also when a newly published content pack arrives (JarvisPack).
    JarvisPack.onWake(app, reason)
  }
}

class JarvisPushService : FirebaseMessagingService() {
  @Suppress("OVERRIDE_DEPRECATION")
  override fun onNewToken(token: String) {
    // The next connect registers it; a live connection gets it now through a reconnect.
    Log.i("JarvisPush", "new token")
    (applicationContext as NodeApp).peekRuntime()?.wakeFromPush()
  }

  override fun onMessageReceived(message: RemoteMessage) {
    if (message.data["type"] == "wake") JarvisPush.onWake(applicationContext, message.data["reason"])
  }
}
