package ai.openclaw.app.jarvis

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.ByteArrayInputStream
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.Base64
import java.util.Locale
import java.util.zip.ZipInputStream

// FORK 2026-10-23 (plan "phone app self-update", layer 2; the architect 17:45 "Build it"). The content pack:
// a zip the Pi signs (ed25519) and the phone door publishes next to the APK. This file is the part
// with no Android in it, so the JVM unit tests cover it: check the pointer, the size, the sha256 and
// the signature against the key baked into the APK, unpack under strict limits, switch atomically,
// keep the previous pack, and roll back when the new pack's start script throws.
// Layout under root (filesDir/pack): <version>/ per pack, .staging-<version>/ while unpacking,
// state.json {current, previous, bad} replaced by an atomic rename.

/** <door>/door/app/pack.json, as scripts/phone-door/pack.mjs writes it. */
@Serializable
data class PackPointer(
  val version: Long,
  val file: String,
  val sha256: String,
  val size: Long,
  val sig: String,
)

/** manifest.json inside the zip (signed, unlike the pointer). */
@Serializable
data class PackManifest(
  val format: Int,
  val version: Long,
  val minAppVersionCode: Long = 0,
  val main: String = "main.js",
)

@Serializable
data class PackState(
  val current: Long? = null,
  val previous: Long? = null,
  val bad: List<Long> = emptyList(),
)

sealed interface PackOutcome {
  /** Nothing to do (not newer, known bad, needs a newer app). */
  data class Skipped(
    val reason: String,
  ) : PackOutcome

  /** Refused before unpacking or while checking it: size, hash, signature, zip contents, manifest. */
  data class Rejected(
    val reason: String,
  ) : PackOutcome

  /** Unpacked, but its start script threw: the previous pack stays active. */
  data class RolledBack(
    val version: Long,
    val error: String,
  ) : PackOutcome

  data class Activated(
    val version: Long,
    val previous: Long?,
  ) : PackOutcome
}

private val packJson = Json { ignoreUnknownKeys = true }
private val packFileRegex = Regex("^pack-[0-9]{1,12}\\.zip$")
private val hexRegex = Regex("^[0-9a-fA-F]{64}$")
private val entryPartRegex = Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$")

internal fun parsePackPointer(raw: String): PackPointer? =
  runCatching { packJson.decodeFromString(PackPointer.serializer(), raw) }
    .getOrNull()
    ?.takeIf { it.version > 0 && it.file.matches(packFileRegex) && it.sha256.matches(hexRegex) && it.size > 0 }

/** A zip entry name we unpack: up to 4 plain path parts, no "..", no absolute path, no backslash. */
internal fun packEntryOk(name: String): Boolean {
  val parts = name.split('/')
  return parts.size in 1..4 && parts.all { it.matches(entryPartRegex) && it != ".." && it != "." }
}

/** ed25519 over the zip bytes; publicKey = the raw 32-byte key. */
internal fun verifyPackSignature(
  zip: ByteArray,
  sigBase64: String,
  publicKey: ByteArray,
): Boolean =
  runCatching {
    val sig = Base64.getDecoder().decode(sigBase64.trim())
    if (sig.size != 64 || publicKey.size != 32) return false
    val verifier = org.bouncycastle.crypto.signers.Ed25519Signer()
    verifier.init(false, org.bouncycastle.crypto.params.Ed25519PublicKeyParameters(publicKey, 0))
    verifier.update(zip, 0, zip.size)
    verifier.verifySignature(sig)
  }.getOrDefault(false)

internal fun packSha256Hex(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(Locale.US, it) }

class PackStore(
  private val root: File,
  private val publicKey: ByteArray,
) {
  companion object {
    const val MAX_ZIP_BYTES = 10L * 1024 * 1024
    const val MAX_UNPACKED_BYTES = 20L * 1024 * 1024
    const val MAX_ENTRIES = 200
    private const val STATE = "state.json"
  }

  fun state(): PackState =
    runCatching { packJson.decodeFromString(PackState.serializer(), File(root, STATE).readText()) }
      .getOrDefault(PackState())

  /** The active pack's folder, or null for the factory pack bundled in the APK. */
  fun currentDir(): File? = state().current?.let { File(root, it.toString()) }?.takeIf { it.isDirectory }

  private fun save(s: PackState) {
    root.mkdirs()
    val tmp = File(root, "$STATE.tmp")
    tmp.writeText(packJson.encodeToString(PackState.serializer(), s))
    Files.move(tmp.toPath(), File(root, STATE).toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
  }

  /**
   * Checks, unpacks and switches to the pack in `zip`. `start` runs the new pack's start script on
   * its folder before the switch; if it throws, the pack is dropped, marked bad and the old one stays.
   */
  suspend fun install(
    pointer: PackPointer,
    zip: ByteArray,
    appVersionCode: Long,
    start: suspend (File) -> Unit,
  ): PackOutcome {
    val before = state()
    if (pointer.version <= (before.current ?: 0L)) return PackOutcome.Skipped("version ${pointer.version} is not newer than ${before.current}")
    if (pointer.version in before.bad) return PackOutcome.Skipped("version ${pointer.version} failed before")
    if (zip.size.toLong() != pointer.size || zip.size > MAX_ZIP_BYTES) return PackOutcome.Rejected("size ${zip.size}, pointer says ${pointer.size}")
    if (!packSha256Hex(zip).equals(pointer.sha256, ignoreCase = true)) return PackOutcome.Rejected("sha256 mismatch")
    if (!verifyPackSignature(zip, pointer.sig, publicKey)) return PackOutcome.Rejected("bad signature")

    val staging = File(root, ".staging-${pointer.version}")
    staging.deleteRecursively()
    val manifest =
      try {
        unzip(zip, staging)
        val m = packJson.decodeFromString(PackManifest.serializer(), File(staging, "manifest.json").readText())
        require(m.version == pointer.version) { "manifest version ${m.version}, pointer ${pointer.version}" }
        require(packEntryOk(m.main) && File(staging, m.main).isFile) { "main script ${m.main} missing" }
        m
      } catch (err: Exception) {
        staging.deleteRecursively()
        return PackOutcome.Rejected(err.message ?: err.javaClass.simpleName)
      }
    if (manifest.minAppVersionCode > appVersionCode) {
      staging.deleteRecursively()
      return PackOutcome.Skipped("needs app versionCode ${manifest.minAppVersionCode}")
    }
    val dir = File(root, pointer.version.toString())
    dir.deleteRecursively()
    if (!staging.renameTo(dir)) {
      staging.deleteRecursively()
      return PackOutcome.Rejected("could not move the pack into place")
    }
    try {
      start(dir)
    } catch (err: Throwable) {
      dir.deleteRecursively()
      save(before.copy(bad = (before.bad + pointer.version).takeLast(20)))
      return PackOutcome.RolledBack(pointer.version, err.message ?: err.javaClass.simpleName)
    }
    save(PackState(current = pointer.version, previous = before.current, bad = before.bad))
    prune()
    return PackOutcome.Activated(pointer.version, before.current)
  }

  /**
   * At app start: runs the active pack's start script; if it throws, that pack is marked bad and the
   * previous one (or the factory pack) takes over. Returns the version that ended up active (null =
   * factory) and the error that caused a roll back, if any.
   */
  suspend fun startCurrent(start: suspend (File?) -> Unit): Pair<Long?, String?> {
    val s = state()
    val dir = currentDir()
    try {
      start(dir)
      return s.current to null
    } catch (err: Throwable) {
      if (s.current == null) return null to (err.message ?: err.javaClass.simpleName)
      val back = s.previous?.takeIf { File(root, it.toString()).isDirectory }
      save(PackState(current = back, previous = null, bad = (s.bad + s.current).takeLast(20)))
      File(root, s.current.toString()).deleteRecursively()
      runCatching { start(back?.let { File(root, it.toString()) }) }
      return back to (err.message ?: err.javaClass.simpleName)
    }
  }

  /** Keeps only the current and previous packs (and state.json). */
  private fun prune() {
    val s = state()
    val keep = setOfNotNull(s.current?.toString(), s.previous?.toString(), STATE)
    root.listFiles()?.filter { it.name !in keep }?.forEach { it.deleteRecursively() }
  }

  private fun unzip(
    zip: ByteArray,
    into: File,
  ) {
    into.mkdirs()
    val base = into.canonicalFile
    var entries = 0
    var total = 0L
    ZipInputStream(ByteArrayInputStream(zip)).use { z ->
      while (true) {
        val e = z.nextEntry ?: break
        require(++entries <= MAX_ENTRIES) { "more than $MAX_ENTRIES files" }
        val name = e.name.removeSuffix("/")
        require(packEntryOk(name)) { "bad file name in pack: ${name.take(80)}" }
        val out = File(base, name).canonicalFile
        require(out.path.startsWith(base.path + File.separator)) { "file outside the pack: ${name.take(80)}" }
        if (e.isDirectory) {
          out.mkdirs()
          continue
        }
        out.parentFile?.mkdirs()
        out.outputStream().use { o ->
          val buf = ByteArray(16 * 1024)
          while (true) {
            val n = z.read(buf)
            if (n < 0) break
            total += n
            require(total <= MAX_UNPACKED_BYTES) { "pack unpacks to more than $MAX_UNPACKED_BYTES bytes" }
            o.write(buf, 0, n)
          }
        }
      }
    }
    require(entries > 0) { "empty pack" }
  }
}
