package ai.openclaw.app.jarvis

import kotlinx.coroutines.runBlocking
import org.bouncycastle.crypto.generators.Ed25519KeyPairGenerator
import org.bouncycastle.crypto.params.Ed25519KeyGenerationParameters
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import java.security.SecureRandom
import java.util.Base64
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

// FORK 2026-10-23 (plan "phone app self-update", layer 2): verify, unpack, switch, keep previous, roll back.
class JarvisPackStoreTest {
  private val root: File = Files.createTempDirectory("jarvis-pack").toFile()
  private val keys =
    Ed25519KeyPairGenerator().apply { init(Ed25519KeyGenerationParameters(SecureRandom())) }.generateKeyPair()
  private val priv = keys.private as Ed25519PrivateKeyParameters
  private val pub = (keys.public as Ed25519PublicKeyParameters).encoded
  private val store = PackStore(root, pub)

  @After fun cleanup() {
    root.deleteRecursively()
  }

  private fun zip(files: Map<String, String>): ByteArray {
    val out = ByteArrayOutputStream()
    ZipOutputStream(out).use { z ->
      for ((name, body) in files) {
        z.putNextEntry(ZipEntry(name))
        z.write(body.toByteArray())
        z.closeEntry()
      }
    }
    return out.toByteArray()
  }

  private fun pack(
    version: Long,
    extra: Map<String, String> = emptyMap(),
    manifestVersion: Long = version,
  ): ByteArray =
    zip(
      mapOf(
        "manifest.json" to """{"format":1,"version":$manifestVersion,"minAppVersionCode":0,"main":"main.js"}""",
        "main.js" to "jarvis.on('start', function () {});",
        "voice-fx.json" to "{}",
      ) + extra,
    )

  private fun sign(bytes: ByteArray): String {
    val s = Ed25519Signer()
    s.init(true, priv)
    s.update(bytes, 0, bytes.size)
    return Base64.getEncoder().encodeToString(s.generateSignature())
  }

  private fun pointer(
    version: Long,
    bytes: ByteArray,
    sig: String = sign(bytes),
  ) = PackPointer(version, "pack-$version.zip", packSha256Hex(bytes), bytes.size.toLong(), sig)

  private fun install(
    version: Long,
    bytes: ByteArray = pack(version),
    p: PackPointer = pointer(version, bytes),
    start: suspend (File) -> Unit = {},
  ) = runBlocking { store.install(p, bytes, appVersionCode = 1000, start = start) }

  @Test
  fun aSignedPackInstallsAndBecomesCurrent() {
    val out = install(5)
    assertEquals(PackOutcome.Activated(5, null), out)
    assertEquals(5L, store.state().current)
    assertTrue(File(root, "5/main.js").isFile)
    assertEquals(File(root, "5"), store.currentDir())
  }

  @Test
  fun theSecondInstallKeepsThePreviousAndPrunesOlder() {
    install(5)
    install(6)
    assertEquals(PackOutcome.Activated(7, 6), install(7))
    assertEquals(PackState(current = 7, previous = 6), store.state())
    assertFalse(File(root, "5").exists())
    assertTrue(File(root, "6").isDirectory)
  }

  @Test
  fun aStartScriptThatThrowsRollsBackAndIsNotRetried() {
    install(5)
    val out = install(6, start = { throw IllegalStateException("boom") })
    assertEquals(PackOutcome.RolledBack(6, "boom"), out)
    assertEquals(5L, store.state().current)
    assertEquals(listOf(6L), store.state().bad)
    assertFalse(File(root, "6").exists())
    assertTrue(install(6) is PackOutcome.Skipped)
  }

  @Test
  fun badSignatureHashSizeAndManifestAreRejected() {
    val bytes = pack(5)
    val other = pack(5, mapOf("x.txt" to "y"))
    assertTrue(install(5, bytes, pointer(5, bytes, sig = sign(other))) is PackOutcome.Rejected)
    assertTrue(install(5, bytes, pointer(5, bytes).copy(sha256 = "0".repeat(64))) is PackOutcome.Rejected)
    assertTrue(install(5, bytes, pointer(5, bytes).copy(size = 1)) is PackOutcome.Rejected)
    val lying = pack(5, manifestVersion = 9)
    assertTrue(install(5, lying) is PackOutcome.Rejected)
    assertNull(store.state().current)
    assertEquals(emptyList<String>(), (root.listFiles() ?: emptyArray()).map { it.name })
  }

  @Test
  fun aPackSignedByAnotherKeyIsRejected() {
    val other = Ed25519KeyPairGenerator().apply { init(Ed25519KeyGenerationParameters(SecureRandom())) }.generateKeyPair()
    val bytes = pack(5)
    val s = Ed25519Signer().apply { init(true, other.private) }
    s.update(bytes, 0, bytes.size)
    val sig = Base64.getEncoder().encodeToString(s.generateSignature())
    assertEquals(PackOutcome.Rejected("bad signature"), install(5, bytes, pointer(5, bytes, sig)))
  }

  @Test
  fun pathTraversalInsideTheZipIsRejected() {
    for (evil in listOf("../evil.js", "/abs.js", "a/../../b.js", "a\\b.js", ".hidden")) {
      val bytes = pack(5, mapOf(evil to "x"))
      val out = install(5, bytes)
      assertTrue("$evil -> $out", out is PackOutcome.Rejected)
    }
    assertFalse(File(root.parentFile, "evil.js").exists())
  }

  @Test
  fun olderOrEqualVersionsAreSkipped() {
    install(5)
    assertTrue(install(5) is PackOutcome.Skipped)
    assertTrue(install(4) is PackOutcome.Skipped)
  }

  @Test
  fun aPackForANewerAppIsSkipped() {
    val bytes = zip(mapOf("manifest.json" to """{"format":1,"version":5,"minAppVersionCode":2000}""", "main.js" to ""))
    assertTrue(install(5, bytes) is PackOutcome.Skipped)
    assertNull(store.state().current)
  }

  @Test
  fun startCurrentRollsBackToThePreviousWhenTheActivePackThrows() {
    install(5)
    install(6)
    val seen = mutableListOf<String?>()
    val (active, error) =
      runBlocking {
        store.startCurrent { dir ->
          seen.add(dir?.name)
          if (dir?.name == "6") throw IllegalStateException("broken start")
        }
      }
    assertEquals(5L, active)
    assertEquals("broken start", error)
    assertEquals(listOf("6", "5"), seen)
    assertEquals(PackState(current = 5, previous = null, bad = listOf(6)), store.state())
  }

  @Test
  fun pointerParsingIsStrict() {
    val sha = "a".repeat(64)
    assertEquals(7L, parsePackPointer("""{"version":7,"file":"pack-7.zip","sha256":"$sha","size":10,"sig":"x","extra":1}""")?.version)
    assertNull(parsePackPointer("""{"version":7,"file":"../pack-7.zip","sha256":"$sha","size":10,"sig":"x"}"""))
    assertNull(parsePackPointer("""{"version":7,"file":"pack-7.apk","sha256":"$sha","size":10,"sig":"x"}"""))
    assertNull(parsePackPointer("""{"version":0,"file":"pack-0.zip","sha256":"$sha","size":10,"sig":"x"}"""))
    assertNull(parsePackPointer("nope"))
  }

  @Test
  fun entryNames() {
    assertTrue(packEntryOk("main.js"))
    assertTrue(packEntryOk("www/assets/app.js"))
    assertFalse(packEntryOk("../x"))
    assertFalse(packEntryOk("a//b"))
    assertFalse(packEntryOk(".env"))
    assertFalse(packEntryOk("a/b/c/d/e"))
  }
}
