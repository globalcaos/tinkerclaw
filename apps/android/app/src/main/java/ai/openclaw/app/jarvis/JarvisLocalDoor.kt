package ai.openclaw.app.jarvis

import android.util.Log
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URI
import kotlin.concurrent.thread

/**
 * 2026-11-10: the pages load from this phone's own address. A page on http://127.0.0.1 is a secure
 * origin, so the PDF viewer's service worker installs there and serves the reader with no network;
 * the https door needed for that before never answered on the real phone. This is a plain TCP relay
 * from 127.0.0.1:[PORT] to the http door that answered: no parsing, websockets pass as they are.
 * The door still asks for the device cookie, so another app on the phone gains nothing from the port.
 */
object JarvisLocalDoor {
  const val PORT = 18795
  const val ORIGIN = "http://127.0.0.1:$PORT"
  private const val TAG = "JarvisLocalDoor"

  @Volatile private var target: InetSocketAddress? = null
  private var server: ServerSocket? = null

  /** Points the relay at an http door and returns [ORIGIN]; null when it cannot serve (https door, port taken). */
  @Synchronized
  fun pointAt(doorOrigin: String): String? {
    if (!doorOrigin.startsWith("http://")) return null
    val uri = runCatching { URI(doorOrigin) }.getOrNull() ?: return null
    val host = uri.host ?: return null
    target = InetSocketAddress.createUnresolved(host, if (uri.port > 0) uri.port else 80)
    if (server == null) {
      val s =
        try {
          ServerSocket(PORT, 50, InetAddress.getByName("127.0.0.1"))
        } catch (err: Exception) {
          Log.e(TAG, "cannot listen on 127.0.0.1:$PORT", err)
          return null
        }
      server = s
      thread(isDaemon = true, name = "jarvis-local-door") {
        while (true) {
          val client =
            try {
              s.accept()
            } catch (err: Exception) {
              Log.e(TAG, "accept failed, relay stops", err)
              break
            }
          thread(isDaemon = true, name = "jarvis-local-door-conn") { relay(client) }
        }
        synchronized(this) { if (server === s) server = null }
        runCatching { s.close() }
      }
    }
    return ORIGIN
  }

  private fun relay(client: Socket) {
    val t = target
    val up = Socket()
    try {
      if (t == null) return
      up.connect(InetSocketAddress(t.hostString, t.port), 5000)
      client.tcpNoDelay = true
      up.tcpNoDelay = true
      val back =
        thread(isDaemon = true, name = "jarvis-local-door-up") {
          pipe(client.getInputStream(), up.getOutputStream())
          runCatching { up.shutdownOutput() }
        }
      pipe(up.getInputStream(), client.getOutputStream())
      runCatching { client.shutdownOutput() }
      back.join()
    } catch (_: Exception) {
      // The door is out of reach: the page sees a dropped connection, as with no network.
    } finally {
      runCatching { up.close() }
      runCatching { client.close() }
    }
  }

  private fun pipe(
    from: InputStream,
    to: OutputStream,
  ) {
    val buf = ByteArray(16 * 1024)
    try {
      while (true) {
        val n = from.read(buf)
        if (n < 0) break
        to.write(buf, 0, n)
        to.flush()
      }
    } catch (_: Exception) {
      // one side closed
    }
  }
}
