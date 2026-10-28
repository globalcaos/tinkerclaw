package ai.openclaw.app.jarvis

import ai.openclaw.app.MainActivity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * FORK 2026-10-28: the app icon badge must match the number of unread chat results. The launcher badge counts this app's notifications, so every alert that piled
 * up in the shade added one. Now only this notification sits on a badging channel, and its number is
 * the count of Tinker chats with a result he has not read; the Pi works the count out with the page's
 * own rule (scripts/phone-door/phone-badge.mjs) and sends it as jarvis.badge {count, titles}. Zero
 * removes it. Every other channel has badges off (JarvisNotifications.retireBadgingChannels).
 */
object JarvisBadge {
  private const val CHANNEL_ID = "jarvis.unread"
  private const val NOTIFICATION_ID = 0x4A42

  fun set(
    context: Context,
    count: Int,
    titles: List<String>,
  ): JsonObject {
    val app = context.applicationContext
    val nm = NotificationManagerCompat.from(app)
    // The first update after the install also clears the alerts that had piled up on the old badging channels.
    JarvisNotifications.retireBadgingChannels(app.getSystemService(NotificationManager::class.java))
    if (count <= 0) {
      nm.cancel(NOTIFICATION_ID)
      return result(0, true)
    }
    if (!JarvisNotifications.canPost(app)) return result(count, false)
    val manager = app.getSystemService(NotificationManager::class.java)
    if (manager.getNotificationChannel(CHANNEL_ID) == null) {
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "Unread chats", NotificationManager.IMPORTANCE_LOW).apply {
          setShowBadge(true)
          setSound(null, null)
          enableVibration(false)
        },
      )
    }
    val title = if (count == 1) "1 chat has a new answer" else "$count chats have a new answer"
    val text = titles.map { it.trim() }.filter { it.isNotEmpty() }.take(6).joinToString(" · ").ifEmpty { "Open Jarvis to read it" }
    val open =
      PendingIntent.getActivity(
        app,
        NOTIFICATION_ID,
        Intent(app, MainActivity::class.java)
          .setAction(Intent.ACTION_MAIN)
          .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    val notification =
      NotificationCompat
        .Builder(app, CHANNEL_ID)
        .setSmallIcon(android.R.drawable.ic_dialog_info)
        .setContentTitle(title)
        .setContentText(text)
        .setStyle(NotificationCompat.BigTextStyle().bigText(text))
        .setNumber(count)
        .setBadgeIconType(NotificationCompat.BADGE_ICON_SMALL)
        .setCategory(NotificationCompat.CATEGORY_MESSAGE)
        .setOnlyAlertOnce(true)
        .setSilent(true)
        .setAutoCancel(true)
        .setContentIntent(open)
        .build()
    return try {
      nm.notify(NOTIFICATION_ID, notification)
      result(count, true)
    } catch (_: SecurityException) {
      result(count, false) // permission revoked between the check and the post
    }
  }

  private fun result(
    count: Int,
    posted: Boolean,
  ) = JsonObject(mapOf("count" to JsonPrimitive(count), "posted" to JsonPrimitive(posted)))
}
