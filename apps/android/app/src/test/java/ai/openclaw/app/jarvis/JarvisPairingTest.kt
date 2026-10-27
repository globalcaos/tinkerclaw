package ai.openclaw.app.jarvis

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// FORK 2026-10-19 (the architect: phone app)
class JarvisPairingTest {
  @Test
  fun parsesTheLinkTheDoorPairPageBuilds() {
    // door.mjs pairDeepLink(): URLSearchParams, then '+' -> %20.
    val parsed =
      parseJarvisPairLink(
        "jarvis://pair?door=http%3A%2F%2F100.64.0.20%3A18794&device=dev%2Btok%2Fen%3D&gw=gw-token",
      )

    assertNotNull(parsed.link)
    assertNull(parsed.error)
    val link = parsed.link!!
    assertEquals("http://100.64.0.20:18794", link.doorOrigin)
    assertEquals("dev+tok/en=", link.deviceToken)
    assertEquals("gw-token", link.gatewayToken)
    assertFalse(link.toString().contains("dev+tok"))
    assertFalse(link.toString().contains("gw-token"))
  }

  @Test
  fun allowsAnEmptyGatewayToken() {
    val parsed = parseJarvisPairLink("jarvis://pair?door=http%3A%2F%2F100.64.0.10%3A18794&device=jd_abcdefgh&gw=")
    assertEquals("", parsed.link?.gatewayToken)
  }

  @Test
  fun rejectsLinksThatAreNotPairLinks() {
    assertNull(parseJarvisPairLink("https://100.64.0.20:18794/door/pair?code=1").link)
    assertNull(parseJarvisPairLink("jarvis://other?door=100.64.0.20&device=a").link)
    assertNull(parseJarvisPairLink("").link)
    assertNull(parseJarvisPairLink("jarvis://pair?door=http%3A%2F%2F100.64.0.11%3A18794").link)
  }

  @Test
  fun rejectsDoorsOutsideTheTailnet() {
    val parsed = parseJarvisPairLink("jarvis://pair?door=http%3A%2F%2Fevil.example%3A18794&device=a&gw=b")
    assertNull(parsed.link)
    assertTrue(parsed.error!!.contains("Tailscale"))
    assertNull(parseJarvisPairLink("jarvis://pair?door=http%3A%2F%2F192.168.1.5%3A18794&device=a").link)
  }

  @Test
  fun pairLinksOnlyNameKnownDoorsOrOurTailnet() {
    fun link(door: String) = "jarvis://pair?door=${java.net.URLEncoder.encode(door, "UTF-8")}&device=jd_abcdefgh&gw=g"

    // Any *.ts.net name is not ours (Funnel hosts are public) unless it is our suffix or a known door.
    assertNull(parseJarvisPairLink(link("http://evil.tail9999.ts.net:18794"), tailnetSuffix = "").link)
    assertNull(parseJarvisPairLink(link("http://evil.tail9999.ts.net:18794"), tailnetSuffix = "tail1234.ts.net").link)
    assertNotNull(parseJarvisPairLink(link("http://pi.tail1234.ts.net:18794"), tailnetSuffix = "tail1234.ts.net").link)
    assertNotNull(
      parseJarvisPairLink(
        link("http://pi.tail9999.ts.net:18794"),
        knownDoors = listOf("http://pi.tail9999.ts.net:18794"),
        tailnetSuffix = "",
      ).link,
    )
    // Loopback (another app's server on the phone) only in a dev build.
    assertNull(parseJarvisPairLink(link("http://127.0.0.1:18851"), allowLoopback = false).link)
    assertNull(parseJarvisPairLink(link("http://localhost:18851"), allowLoopback = false).link)
    assertNotNull(parseJarvisPairLink(link("http://127.0.0.1:18851"), allowLoopback = true).link)
    assertNotNull(parseJarvisPairLink(link("http://100.70.1.2:18794"), allowLoopback = false, tailnetSuffix = "").link)
    assertFalse(isAllowedJarvisDoorHost("127.0.0.1", allowLoopback = false))
    assertTrue(isAllowedJarvisDoorHost("pi.tail9999.ts.net", allowLoopback = false))
  }

  @Test
  fun rejectsMalformedTokens() {
    val door = "door=http%3A%2F%2F100.64.0.10%3A18794"
    assertNull(parseJarvisPairLink("jarvis://pair?$door&device=short&gw=").link)
    assertNull(parseJarvisPairLink("jarvis://pair?$door&device=jd_abc%0Adefgh&gw=").link)
    assertNull(parseJarvisPairLink("jarvis://pair?$door&device=jd_abc%C3%A9defgh&gw=").link)
    assertNull(parseJarvisPairLink("jarvis://pair?$door&device=jd_abcdefgh&gw=a%20b").link)
    assertNotNull(parseJarvisPairLink("jarvis://pair?$door&device=jd_Ab-_xyz0123&gw=a.b~c").link)
  }

  @Test
  fun parsesBridgeCalls() {
    assertEquals(JarvisBridgeCall("copyText", listOf("hi")), parseJarvisBridgeCall("""{"m":"copyText","a":["hi"]}"""))
    assertEquals(JarvisBridgeCall("vibrate", listOf("40")), parseJarvisBridgeCall("""{"m":"vibrate","a":[40]}"""))
    assertEquals(JarvisBridgeCall("notify", listOf("t", null)), parseJarvisBridgeCall("""{"m":"notify","a":["t",null]}"""))
    assertNull(parseJarvisBridgeCall("not json"))
    assertNull(parseJarvisBridgeCall("""{"a":["x"]}"""))
    assertNull(parseJarvisBridgeCall("""{"m":"copyText","a":"x"}"""))
    assertNull(parseJarvisBridgeCall(null))
  }

  @Test
  fun normalizesDoorOrigins() {
    assertEquals("http://100.64.0.10:18794", normalizeJarvisDoorOrigin("100.64.0.10"))
    assertEquals("http://100.64.0.10:18794", normalizeJarvisDoorOrigin(" http://100.64.0.10:18794/tinker/ "))
    assertEquals("http://pi.tail1234.ts.net:18794", normalizeJarvisDoorOrigin("http://PI.tail1234.ts.net"))
    assertEquals("https://pi.tail1234.ts.net", normalizeJarvisDoorOrigin("https://pi.tail1234.ts.net/"))
    assertNull(normalizeJarvisDoorOrigin("ftp://100.64.0.10"))
    assertNull(normalizeJarvisDoorOrigin(""))
  }

  @Test
  fun tailnetHostsAreTheCgnatRangeAndMagicDns() {
    assertTrue(isTailnetHost("100.64.0.1"))
    assertTrue(isTailnetHost("100.127.255.254"))
    assertTrue(isTailnetHost("100.64.0.10"))
    assertTrue(isTailnetHost("jarvis-pi.tail1234.ts.net"))
    assertFalse(isTailnetHost("100.128.0.1"))
    assertFalse(isTailnetHost("100.63.255.255"))
    assertFalse(isTailnetHost("10.0.0.1"))
    assertFalse(isTailnetHost("example.com"))
    assertFalse(isTailnetHost(null))
  }

  @Test
  fun sameOriginComparesSchemeHostAndPort() {
    assertTrue(isSameJarvisOrigin("http://100.64.0.20:18794/tinker/#x", "http://100.64.0.20:18794"))
    assertFalse(isSameJarvisOrigin("http://100.64.0.20:18793/tinker/", "http://100.64.0.20:18794"))
    assertFalse(isSameJarvisOrigin("https://100.64.0.20:18794/", "http://100.64.0.20:18794"))
    assertFalse(isSameJarvisOrigin("about:blank", "http://100.64.0.20:18794"))
    assertFalse(isSameJarvisOrigin("http://100.64.0.20:18794/", null))
  }

  @Test
  fun pairedDoorGoesFirstWithoutDuplicates() {
    assertEquals(
      listOf("http://100.64.0.20:18794", "http://100.64.0.10:18794"),
      withDoorFirst("http://100.64.0.20:18794", defaultJarvisDoorCandidates),
    )
  }

  @Test
  fun documentStartScriptMarksTheAppAndQuotesTheVersion() {
    val script = jarvisDocumentStartScript("2026.4.27-jarvis\"x", 420011)
    assertTrue(script.contains("classList.add(\"jarvis-app\")"))
    assertTrue(script.contains("\"2026.4.27-jarvis\\\"x\""))
    assertTrue(script.contains("versionCode: 420011"))
    assertTrue(script.contains("!window.isSecureContext"))
    // window.JarvisNative is built in the top frame only, on the message port.
    assertTrue(script.contains("if (window.top !== window) return;"))
    assertTrue(script.contains("window.${JarvisNativeBridge.PORT_NAME}"))
  }
}
