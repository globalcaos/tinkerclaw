package ai.openclaw.app.jarvis

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.widget.RemoteViews
import ai.openclaw.app.R

// FORK 2026-11-12: the TinkerClaw panel on the cover screen of a Galaxy Z Flip (need: control the
// read-aloud with the phone closed). It is an app widget that Samsung shows on the cover screen
// (res/xml/cover_reader_samsung.xml, display="sub_screen"; added by the owner under Settings >
// Cover screen > Widgets). It shows what is being read and five buttons: slower, previous paragraph,
// read or pause, next paragraph, faster. The buttons go to JarvisReader through JarvisReaderReceiver,
// so they work with the app closed; JarvisReader redraws the panel at every sentence.
class JarvisCoverWidget : AppWidgetProvider() {
  override fun onUpdate(
    context: Context,
    appWidgetManager: AppWidgetManager,
    appWidgetIds: IntArray,
  ) = refresh(context)

  companion object {
    fun refresh(context: Context) {
      val manager = AppWidgetManager.getInstance(context) ?: return
      val me = ComponentName(context, JarvisCoverWidget::class.java)
      if (manager.getAppWidgetIds(me).isEmpty()) return
      val s = JarvisReader.snapshot(context)
      val views = RemoteViews(context.packageName, R.layout.cover_reader)
      views.setTextViewText(R.id.cover_title, s.title.ifBlank { "Nothing to read yet" })
      views.setTextViewText(R.id.cover_line, s.line)
      views.setTextViewText(R.id.cover_text, s.text.ifBlank { "Start Read in the PDF reader once; after that this panel carries on from here." })
      views.setTextViewText(R.id.cover_speed, s.speed)
      views.setImageViewResource(R.id.cover_play, if (s.playing) R.drawable.ic_reader_pause else R.drawable.ic_reader_play)
      for ((id, cmd) in listOf(
        R.id.cover_slower to "slower",
        R.id.cover_prev to "prev",
        R.id.cover_play to "toggle",
        R.id.cover_next to "next",
        R.id.cover_faster to "faster",
      )) {
        views.setOnClickPendingIntent(id, JarvisReader.pending(context, cmd))
      }
      manager.updateAppWidget(me, views)
    }
  }
}
