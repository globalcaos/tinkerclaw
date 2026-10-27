package ai.openclaw.app.jarvis

import ai.openclaw.app.BuildConfig
import ai.openclaw.app.gateway.isLoopbackGatewayHost
import java.net.URI
import java.net.URLDecoder
import java.util.Locale

// FORK 2026-10-19 (the architect: phone app) — the Jarvis build is a shell around the Tinker page that the
// phone door (scripts/phone-door/door.mjs) serves on the tailnet. This file holds the pure parts:
// the door addresses, the jarvis://pair link the door's pair page hands over, and the host rules.

/** Port the phone door listens on (PHONE_DOOR_PORT). */
const val JARVIS_DOOR_PORT = 18794

/** Header and cookie the door accepts a device token in. */
const val JARVIS_DEVICE_HEADER = "X-Jarvis-Device"
const val JARVIS_DEVICE_COOKIE = "jarvis_device"

/** Tried in order through GET /door/health: the Raspberry Pi first, then the laptop. */
val defaultJarvisDoorCandidates: List<String> =
  listOf(
    "http://100.64.0.10:$JARVIS_DOOR_PORT",
    "http://100.64.0.20:$JARVIS_DOOR_PORT",
  )

/** What a jarvis://pair?door=&device=&gw= link carries. toString never prints the tokens. */
class JarvisPairLink(
  val doorOrigin: String,
  val deviceToken: String,
  val gatewayToken: String,
) {
  override fun toString(): String = "JarvisPairLink(door=$doorOrigin)"
}

data class JarvisPairParse(
  val link: JarvisPairLink? = null,
  val error: String? = null,
)

/**
 * A link from outside the app (browser, QR, another app) is only taken for a door this phone already
 * knows, a 100.64.0.0/10 address, a name on our own tailnet ([tailnetSuffix], set at build time) or,
 * in a dev build only, loopback. Any *.ts.net name is not enough: Funnel hosts are public.
 */
fun parseJarvisPairLink(
  raw: String?,
  knownDoors: List<String> = defaultJarvisDoorCandidates,
  allowLoopback: Boolean = BuildConfig.JARVIS_DEV,
  tailnetSuffix: String = BuildConfig.JARVIS_TAILNET_SUFFIX,
): JarvisPairParse {
  val trimmed = raw?.trim().orEmpty()
  if (trimmed.isEmpty()) return JarvisPairParse(error = "Paste the jarvis://pair link first.")
  val uri =
    runCatching { URI(trimmed) }.getOrNull()
      ?: return JarvisPairParse(error = "That is not a jarvis://pair link.")
  if (!uri.scheme.equals("jarvis", ignoreCase = true) || !uri.host.equals("pair", ignoreCase = true)) {
    return JarvisPairParse(error = "That is not a jarvis://pair link.")
  }
  val query = parseQuery(uri.rawQuery)
  val door =
    normalizeJarvisDoorOrigin(query["door"])
      ?: return JarvisPairParse(error = "The link has no valid door address.")
  if (!isAllowedPairLinkDoor(door, knownDoors, allowLoopback, tailnetSuffix)) {
    val host = jarvisDoorHostPort(door)?.first.orEmpty()
    return JarvisPairParse(error = "The door must be a known door or a Tailscale 100.x address, not $host.")
  }
  val device = query["device"]?.trim().orEmpty()
  if (device.isEmpty()) return JarvisPairParse(error = "The link has no device token.")
  // Both tokens end up in a request (header / connect frame): a bad character would make every
  // reconnect throw, with the value in the error text.
  if (!deviceTokenPattern.matches(device)) return JarvisPairParse(error = "The device token in the link is malformed.")
  val gateway = query["gw"]?.trim().orEmpty()
  if (!gatewayTokenPattern.matches(gateway)) return JarvisPairParse(error = "The gateway token in the link is malformed.")
  return JarvisPairParse(link = JarvisPairLink(doorOrigin = door, deviceToken = device, gatewayToken = gateway))
}

/**
 * "100.64.0.10", "http://100.64.0.10:18794/tinker/" -> "http://100.64.0.10:18794".
 * A plain http origin without a port means the door port, not 80.
 */
fun normalizeJarvisDoorOrigin(raw: String?): String? {
  val trimmed = raw?.trim().orEmpty()
  if (trimmed.isEmpty()) return null
  val withScheme = if (trimmed.contains("://")) trimmed else "http://$trimmed"
  val uri = runCatching { URI(withScheme) }.getOrNull() ?: return null
  val scheme = uri.scheme?.lowercase(Locale.US) ?: return null
  if (scheme != "http" && scheme != "https") return null
  val host =
    uri.host
      ?.trim()
      ?.trim('[', ']')
      ?.takeIf { it.isNotEmpty() } ?: return null
  val port =
    when {
      uri.port in 1..65535 -> uri.port
      scheme == "https" -> 443
      else -> JARVIS_DOOR_PORT
    }
  val hostPart = if (host.contains(':')) "[$host]" else host.lowercase(Locale.US)
  return if (scheme == "https" && port == 443) "$scheme://$hostPart" else "$scheme://$hostPart:$port"
}

/** host (without brackets) and port of a normalized origin. */
fun jarvisDoorHostPort(origin: String): Pair<String, Int>? {
  val uri = runCatching { URI(origin) }.getOrNull() ?: return null
  val host =
    uri.host
      ?.trim('[', ']')
      ?.takeIf { it.isNotEmpty() } ?: return null
  val port =
    when {
      uri.port in 1..65535 -> uri.port
      uri.scheme.equals("https", ignoreCase = true) -> 443
      else -> 80
    }
  return host to port
}

/** Same origin, comparing normalized forms ("http://h:p"). */
fun isSameJarvisOrigin(
  url: String?,
  origin: String?,
): Boolean {
  if (url.isNullOrBlank() || origin.isNullOrBlank()) return false
  val a = normalizeOriginOf(url) ?: return false
  val b = normalizeOriginOf(origin) ?: return false
  return a == b
}

private fun normalizeOriginOf(url: String): String? {
  val uri = runCatching { URI(url.trim()) }.getOrNull() ?: return null
  val scheme = uri.scheme?.lowercase(Locale.US) ?: return null
  if (scheme != "http" && scheme != "https") return null
  val host = uri.host?.lowercase(Locale.US)?.trim('[', ']') ?: return null
  val port =
    if (uri.port in 1..65535) {
      uri.port
    } else if (scheme == "https") {
      443
    } else {
      80
    }
  return "$scheme://$host:$port"
}

/** Tailscale CGNAT range 100.64.0.0/10, or a MagicDNS name. */
fun isTailnetHost(rawHost: String?): Boolean {
  val host =
    rawHost
      ?.trim()
      ?.lowercase(Locale.US)
      ?.trim('[', ']')
      ?.trimEnd('.')
      .orEmpty()
  if (host.isEmpty()) return false
  if (host.endsWith(".ts.net")) return true
  val parts = host.split('.')
  if (parts.size != 4) return false
  val octets = parts.map { it.toIntOrNull() ?: return false }
  if (octets.any { it !in 0..255 }) return false
  return octets[0] == 100 && octets[1] in 64..127
}

/** door.mjs mints "jd_" + base64url and accepts 8..300 characters. */
private val deviceTokenPattern = Regex("^[A-Za-z0-9._~+/=-]{8,300}$")

/** Printable ASCII without spaces; empty is allowed (a door without a gateway token). */
private val gatewayTokenPattern = Regex("^[\\x21-\\x7E]{0,1024}$")

/** 100.64.0.0/10 only, no names. */
fun isTailnetIp(rawHost: String?): Boolean = isTailnetHost(rawHost) && !rawHost.orEmpty().trimEnd('.').endsWith(".ts.net", ignoreCase = true)

/** Door addresses typed in Settings: any tailnet address; loopback only in a dev build. */
fun isAllowedJarvisDoorHost(
  host: String?,
  allowLoopback: Boolean = BuildConfig.JARVIS_DEV,
): Boolean = isTailnetHost(host) || (allowLoopback && isLoopbackGatewayHost(host, allowEmulatorBridgeAlias = false))

/** See [parseJarvisPairLink]. */
fun isAllowedPairLinkDoor(
  origin: String,
  knownDoors: List<String>,
  allowLoopback: Boolean,
  tailnetSuffix: String,
): Boolean {
  if (knownDoors.mapNotNull(::normalizeJarvisDoorOrigin).contains(origin)) return true
  val host =
    jarvisDoorHostPort(origin)
      ?.first
      ?.lowercase(Locale.US)
      ?.trimEnd('.') ?: return false
  if (isTailnetIp(host)) return true
  val suffix = tailnetSuffix.trim().trim('.').lowercase(Locale.US)
  if (suffix.isNotEmpty() && host.endsWith(".$suffix")) return true
  return allowLoopback && isLoopbackGatewayHost(host, allowEmulatorBridgeAlias = false)
}

/** Candidate list with [origin] first, no duplicates. */
fun withDoorFirst(
  origin: String,
  candidates: List<String>,
): List<String> = (listOf(origin) + candidates).mapNotNull(::normalizeJarvisDoorOrigin).distinct()

private fun parseQuery(raw: String?): Map<String, String> {
  if (raw.isNullOrEmpty()) return emptyMap()
  val out = linkedMapOf<String, String>()
  for (part in raw.split('&')) {
    if (part.isEmpty()) continue
    val eq = part.indexOf('=')
    val key = decode(if (eq < 0) part else part.substring(0, eq)) ?: continue
    val value = if (eq < 0) "" else decode(part.substring(eq + 1)) ?: continue
    if (key !in out) out[key] = value
  }
  return out
}

private fun decode(value: String): String? = runCatching { URLDecoder.decode(value, Charsets.UTF_8.name()) }.getOrNull()
