package ai.openclaw.app.jarvis

import ai.openclaw.app.NodeApp
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Environment
import android.os.PowerManager
import android.provider.Settings
import android.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

// FORK 2026-10-22: the agent finds and fetches a file downloaded on the phone.
// jarvis.files.list / jarvis.files.get read the public Download folder. Android only shows other
// apps' downloads with "All files access", a switch the owner turns on once; without it we open that
// settings page on his screen and report NEEDS_PERMISSION.
object JarvisFiles {
  private const val MAX_BYTES = 20L * 1024 * 1024

  class NeedsPermission : Exception("NEEDS_PERMISSION: turn on All files access for Jarvis (settings page opened)")

  private fun downloads(context: Context): File {
    if (!Environment.isExternalStorageManager()) {
      runCatching {
        context.startActivity(
          Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:${context.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
      }
      throw NeedsPermission()
    }
    return Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
  }

  fun listJson(context: Context, limit: Int): String {
    val files =
      (downloads(context).listFiles() ?: emptyArray())
        .filter { it.isFile }
        .sortedByDescending { it.lastModified() }
        .take(limit.coerceIn(1, 100))
    val arr = JSONArray()
    for (f in files) {
      arr.put(JSONObject().put("name", f.name).put("size", f.length()).put("modifiedMs", f.lastModified()))
    }
    return JSONObject().put("files", arr).toString()
  }

  /**
   * 2026-11-11: jarvis.files.fetch. The Pi puts a file on the phone with the screen locked: this runs
   * in the app's service, fetches <door><path> with the device header and saves it in Download under
   * [nameArg] (default: the last part of the path). A file of that name is replaced. The first way,
   * through the page and Android's download manager, only worked while the app was on screen.
   */
  suspend fun fetchJson(context: Context, path: String, nameArg: String): String =
    withContext(Dispatchers.IO) {
      require(path.startsWith("/") && !path.startsWith("//")) { "a path on the door is required, starting with /" }
      val name = nameArg.ifBlank { Uri.decode(path.substringBefore('?').substringAfterLast('/')) }
      require(name.isNotBlank() && !name.contains('/') && name != "." && name != "..") { "plain file name required" }
      val app = context.applicationContext
      val prefs = (app as NodeApp).prefs
      val token = prefs.loadJarvisDeviceToken() ?: error("not paired with a door")
      val dir = downloads(app)
      val wake =
        (app.getSystemService(Context.POWER_SERVICE) as PowerManager)
          .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "jarvis:files-fetch")
      wake.acquire(10 * 60 * 1000L)
      val part = File(dir, ".$name.part")
      try {
        val origin =
          JarvisDoor.origin.value?.takeIf { JarvisDoor.probe(it) }
            ?: JarvisDoor.resolve(prefs.jarvisDoorCandidates.value)
            ?: error("door not reachable")
        val request = Request.Builder().url("$origin$path").header(JARVIS_DEVICE_HEADER, token).get().build()
        JarvisDoor.http.newCall(request).await().use { response ->
          if (!response.isSuccessful) error("the door answered ${response.code}")
          part.outputStream().use { out -> response.body.byteStream().copyTo(out) }
        }
        val file = File(dir, name)
        if (file.exists() && !file.delete()) error("cannot replace $name")
        if (!part.renameTo(file)) error("cannot save $name")
        JSONObject().put("name", file.name).put("size", file.length()).toString()
      } finally {
        part.delete()
        if (wake.isHeld) wake.release()
      }
    }

  fun getJson(context: Context, name: String): String {
    require(name.isNotBlank() && !name.contains('/') && name != "." && name != "..") { "plain file name required" }
    val f = File(downloads(context), name)
    require(f.isFile) { "not found: $name" }
    require(f.length() <= MAX_BYTES) { "too large: ${f.length()} bytes (max $MAX_BYTES)" }
    return JSONObject()
      .put("name", f.name)
      .put("size", f.length())
      .put("modifiedMs", f.lastModified())
      .put("base64", Base64.encodeToString(f.readBytes(), Base64.NO_WRAP))
      .toString()
  }
}
