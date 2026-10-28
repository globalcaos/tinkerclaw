package ai.openclaw.app.jarvis

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Environment
import android.provider.Settings
import android.util.Base64
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
