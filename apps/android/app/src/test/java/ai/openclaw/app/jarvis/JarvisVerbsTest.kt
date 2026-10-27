package ai.openclaw.app.jarvis

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import kotlin.math.abs

// FORK 2026-10-23 (plan "phone app self-update"): verb argument checks, script results, voice-fx.json.
class JarvisVerbsTest {
  @Test
  fun buzzPatterns() {
    assertArrayEquals(longArrayOf(0, 180), buzzTimings(null))
    assertArrayEquals(longArrayOf(0, 250), buzzTimings(JsonPrimitive(250)))
    assertArrayEquals(longArrayOf(0, 100, 50, 100), buzzTimings(Json.parseToJsonElement("[100, 50, 100]")))
    assertArrayEquals(longArrayOf(0, 2000), buzzTimings(JsonPrimitive(99_999)))
    assertTrue(runCatching { buzzTimings(JsonPrimitive("x")) }.isFailure)
    assertTrue(runCatching { buzzTimings(JsonArray(List(21) { JsonPrimitive(10) })) }.isFailure)
    assertTrue(runCatching { buzzTimings(JsonArray(List(6) { JsonPrimitive(2000) })) }.isFailure)
  }

  @Test
  fun openTargets() {
    assertEquals(JarvisOpenTarget.Screen(JarvisScreen.Trip), parseOpenTarget("trip"))
    assertEquals(JarvisOpenTarget.Url("/tinker/#chat"), parseOpenTarget("/tinker/#chat"))
    assertEquals(JarvisOpenTarget.Url("https://example.com/x"), parseOpenTarget("https://example.com/x"))
    for (bad in listOf("", "//evil.com/x", "javascript:alert(1)", "file:///sdcard/x", "nowhere")) {
      assertTrue(bad, runCatching { parseOpenTarget(bad) }.isFailure)
    }
    assertEquals("http://100.64.0.10:18794/tinker/", resolveOnDoor("/tinker/", "http://100.64.0.10:18794/"))
    assertEquals(null, resolveOnDoor("/tinker/", null))
    assertEquals("https://a.b/c", resolveOnDoor("https://a.b/c", null))
  }

  @Test
  fun scriptResultsKeepOnlyLayerOneVerbs() {
    val r =
      JarvisScript.parseResult(
        """{"handled":true,"calls":[{"verb":"buzz","args":{"pattern":[180]}},{"verb":"exec","args":{}},{"verb":"say","args":{"text":"hi"}},"junk"]}""",
      )
    assertTrue(r.handled)
    assertEquals(listOf("buzz", "say"), r.calls.map { it.verb })
    assertEquals(2, r.dropped)
    assertFalse(JarvisScript.parseResult("""{"handled":false}""").handled)
    assertTrue(runCatching { JarvisScript.parseResult("[]") }.isFailure)
  }

  @Test
  fun programRunsTheEventLast() {
    val p = JarvisScript.program("var a=1;", "jarvis.on('x', f);", "answer", JsonObject(mapOf("text" to JsonPrimitive("hi \"there\""))))
    assertTrue(p.trimEnd().endsWith("""__jarvisRun("answer", {"text":"hi \"there\""});"""))
  }

  // The factory pack's voice-fx.json is the one file the page and the app share (step 4).
  private val factoryFx = File("src/thirdParty/assets/pack/voice-fx.json")

  @Test
  fun theFactoryVoiceFxParsesWithEveryField() {
    val fx = VoiceFx.parse(factoryFx.readText())
    assertEquals(1, fx.format)
    assertEquals(4, fx.fork.partials.size)
    assertEquals(3, fx.chain.comb.size)
    // A pack that drops a field is refused, so the app never guesses a number.
    val missing = factoryFx.readText().replace("\"barMix\": 1.5,", "")
    assertTrue(runCatching { VoiceFx.parse(missing) }.isFailure)
  }

  @Test
  fun theVoiceChainKeepsLengthAndStaysFinite() {
    val fx = VoiceFx.parse(factoryFx.readText())
    val sr = 24000
    var ph = 0.0
    val x =
      FloatArray(sr) { i ->
        ph += 2 * Math.PI * (110 + 60.0 * i / sr) / sr
        (0.4 * (kotlin.math.sin(ph) + 0.5 * kotlin.math.sin(2 * ph))).toFloat()
      }
    val y = JarvisVoiceFx.process(x, sr, fx)
    assertEquals(x.size, y.size)
    assertTrue(y.all { it.isFinite() })
    assertTrue(y.maxOf { abs(it) } > 0.01f)
  }
}
