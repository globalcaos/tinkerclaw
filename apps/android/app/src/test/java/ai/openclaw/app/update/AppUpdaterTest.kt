package ai.openclaw.app.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

// FORK 2026-10-19 (the architect: phone app)
class AppUpdaterTest {
  private val sha = "a".repeat(64)

  @Test
  fun parsesLatestJson() {
    val release =
      parseAppRelease(
        """{"versionCode":420500,"versionName":"2026.4.27-jarvis","file":"jarvis-420500.apk","sha256":"$sha","notes":"x","extra":1}""",
      )
    assertEquals(420500L, release?.versionCode)
    assertEquals("jarvis-420500.apk", release?.file)
  }

  @Test
  fun rejectsUnsafeFileNamesAndBadHashes() {
    assertNull(parseAppRelease("""{"versionCode":1,"file":"../x.apk","sha256":"$sha"}"""))
    assertNull(parseAppRelease("""{"versionCode":1,"file":"x.apk","sha256":"abc"}"""))
    assertNull(parseAppRelease("""{"versionCode":1,"file":"x.zip","sha256":"$sha"}"""))
    assertNull(parseAppRelease("not json"))
  }

  @Test
  fun onlyAStrictlyNewerVersionCodeIsAnUpdate() {
    val release = parseAppRelease("""{"versionCode":10,"file":"j.apk","sha256":"$sha"}""")!!
    assertTrue(isNewerRelease(release, 9))
    assertFalse(isNewerRelease(release, 10))
    assertFalse(isNewerRelease(release, 11))
  }

  @Test
  fun sha256MatchesTheKnownDigest() {
    val file = File.createTempFile("jarvis-update", ".bin")
    try {
      file.writeText("abc")
      assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", sha256Hex(file))
    } finally {
      file.delete()
    }
  }
}
