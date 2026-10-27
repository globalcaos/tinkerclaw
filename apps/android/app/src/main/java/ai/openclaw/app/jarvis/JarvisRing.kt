package ai.openclaw.app.jarvis

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager

/**
 * Find my phone: ring loud even when the phone is on silent or the volume is down.
 * Plays the alarm tone on the ALARM stream at full volume (alarms ignore the ringer
 * switch), vibrates, and restores the owner's alarm volume when it stops.
 */
object JarvisRing {
  private val main = Handler(Looper.getMainLooper())
  private var player: MediaPlayer? = null
  private var savedVolume: Int? = null
  private var vibrator: Vibrator? = null
  private val stopTask = Runnable { stop() }

  fun ring(context: Context, seconds: Int): String {
    val secs = seconds.coerceIn(5, 300)
    val done = java.util.concurrent.CountDownLatch(1)
    var error: Throwable? = null
    main.post {
      try {
        stop()
        val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        savedVolume = audio.getStreamVolume(AudioManager.STREAM_ALARM)
        runCatching {
          audio.setStreamVolume(AudioManager.STREAM_ALARM, audio.getStreamMaxVolume(AudioManager.STREAM_ALARM), 0)
        }
        val uri =
          RingtoneManager.getActualDefaultRingtoneUri(context, RingtoneManager.TYPE_ALARM)
            ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
        player =
          MediaPlayer().apply {
            setAudioAttributes(
              AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build(),
            )
            setDataSource(context, uri)
            isLooping = true
            prepare()
            start()
          }
        vibrator =
          (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator.also {
            it.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 800, 400), 0))
          }
        main.postDelayed(stopTask, secs * 1000L)
      } catch (t: Throwable) {
        error = t
        stop()
      } finally {
        done.countDown()
      }
    }
    done.await(5, java.util.concurrent.TimeUnit.SECONDS)
    error?.let { throw it }
    return """{"ringing":true,"seconds":$secs}"""
  }

  fun stop(): String {
    main.removeCallbacks(stopTask)
    val was = player != null
    runCatching { player?.stop() }
    runCatching { player?.release() }
    player = null
    runCatching { vibrator?.cancel() }
    vibrator = null
    savedVolume?.let { v ->
      runCatching {
        val audio = JarvisLook.appContext().getSystemService(Context.AUDIO_SERVICE) as AudioManager
        audio.setStreamVolume(AudioManager.STREAM_ALARM, v, 0)
      }
    }
    savedVolume = null
    return """{"stopped":$was}"""
  }
}
