import com.android.build.api.variant.impl.VariantOutputImpl
import java.time.Instant
import java.util.Properties
import groovy.json.JsonSlurper

val dnsjavaInetAddressResolverService = "META-INF/services/java.net.spi.InetAddressResolverProvider"

val androidStoreFile = providers.gradleProperty("OPENCLAW_ANDROID_STORE_FILE").orNull?.takeIf { it.isNotBlank() }
val androidStorePassword = providers.gradleProperty("OPENCLAW_ANDROID_STORE_PASSWORD").orNull?.takeIf { it.isNotBlank() }
val androidKeyAlias = providers.gradleProperty("OPENCLAW_ANDROID_KEY_ALIAS").orNull?.takeIf { it.isNotBlank() }
val androidKeyPassword = providers.gradleProperty("OPENCLAW_ANDROID_KEY_PASSWORD").orNull?.takeIf { it.isNotBlank() }
val resolvedAndroidStoreFile =
  androidStoreFile?.let { storeFilePath ->
    if (storeFilePath.startsWith("~/")) {
      "${System.getProperty("user.home")}/${storeFilePath.removePrefix("~/")}"
    } else {
      storeFilePath
    }
  }

val hasAndroidReleaseSigning =
  listOf(resolvedAndroidStoreFile, androidStorePassword, androidKeyAlias, androidKeyPassword).all { it != null }

// FORK 2026-10-19 (the architect: phone app) — the Jarvis (thirdParty) build signs every variant with one
// local key so a newer APK installs over an older one whichever machine built it. The key and its
// passwords stay outside the repo; without the file the build falls back to stock signing.
val jarvisSigningFile =
  file(
    providers.environmentVariable("JARVIS_SIGNING_PROPERTIES").orNull?.takeIf { it.isNotBlank() }
      ?: "${System.getProperty("user.home")}/.config/jarvis/android-signing.properties",
  )
val jarvisSigning: Properties? =
  jarvisSigningFile.takeIf { it.isFile }?.let { f ->
    Properties().apply { f.inputStream().use { load(it) } }.takeIf { props ->
      listOf("storeFile", "storePassword", "keyAlias", "keyPassword").all { !props.getProperty(it).isNullOrBlank() }
    }
  }
val jarvisStoreFile =
  jarvisSigning?.getProperty("storeFile")?.let { path ->
    when {
      path.startsWith("~/") -> File(System.getProperty("user.home"), path.removePrefix("~/"))
      File(path).isAbsolute -> File(path)
      else -> File(jarvisSigningFile.parentFile, path)
    }
  }

// FORK 2026-10-19 (the architect: phone app) — versionCode must always grow so the self-updater can install
// over the previous build: JARVIS_VERSION_CODE when set, else minutes since 2026-01-01T00:00Z.
val jarvisEpochMillis = Instant.parse("2026-01-01T00:00:00Z").toEpochMilli()
val jarvisVersionCode =
  providers
    .environmentVariable("JARVIS_VERSION_CODE")
    .orNull
    ?.takeIf { it.isNotBlank() }
    ?.toInt()
    ?: ((System.currentTimeMillis() - jarvisEpochMillis) / 60_000L).toInt()

// FORK 2026-10-19 (the architect: phone app) — JARVIS_DEV=1 makes a test build: loopback doors (emulator +
// adb reverse) and WebView remote debugging. Off by default, so the APK that goes on the phone has
// neither. JARVIS_TAILNET_SUFFIX (e.g. "tailXXXX.ts.net") lets pair links name doors on our own
// tailnet by MagicDNS; it stays out of the repo.
val jarvisDev = providers.environmentVariable("JARVIS_DEV").orNull == "1"

// FORK 2026-10-22 (the architect: wake the sleeping phone app) — Firebase push for the Jarvis build. The
// project file stays out of the repo: JARVIS_GOOGLE_SERVICES or ~/.config/jarvis-fcm/google-services.json.
// Without it the app builds as before and simply never registers for push.
val jarvisFirebase: Map<String, String> =
  file(
    providers.environmentVariable("JARVIS_GOOGLE_SERVICES").orNull?.takeIf { it.isNotBlank() }
      ?: "${System.getProperty("user.home")}/.config/jarvis-fcm/google-services.json",
  ).takeIf { it.isFile }?.let { f ->
    @Suppress("UNCHECKED_CAST")
    val j = JsonSlurper().parse(f) as Map<String, Any?>
    val project = j["project_info"] as Map<String, Any?>
    val client =
      (j["client"] as List<Map<String, Any?>>).firstOrNull { c ->
        ((c["client_info"] as Map<String, Any?>)["android_client_info"] as Map<String, Any?>)["package_name"] ==
          "ai.tinkerclaw.jarvis"
      } ?: return@let null
    mapOf(
      "google_app_id" to ((client["client_info"] as Map<String, Any?>)["mobilesdk_app_id"] as String),
      "google_api_key" to (((client["api_key"] as List<Map<String, Any?>>).first())["current_key"] as String),
      "gcm_defaultSenderId" to (project["project_number"] as String),
      "project_id" to (project["project_id"] as String),
    )
  } ?: emptyMap()
// FORK 2026-10-23 (plan "phone app self-update", layer 2) — the ed25519 key content packs must be
// signed with (raw 32 bytes, base64). Only the PUBLIC key: JARVIS_PACK_PUBLIC_KEY or
// ~/.config/jarvis-pack/public.b64 (scripts/phone-door/pack.mjs keygen). Without it the app never
// takes a pack and keeps the factory one in src/thirdParty/assets/pack.
val jarvisPackKey: String =
  (
    providers.environmentVariable("JARVIS_PACK_PUBLIC_KEY").orNull?.takeIf { it.isNotBlank() }
      ?: file("${System.getProperty("user.home")}/.config/jarvis-pack/public.b64").takeIf { it.isFile }?.readText()
  )?.trim()?.filter { it.isLetterOrDigit() || it == '+' || it == '/' || it == '=' }.orEmpty()
val jarvisTailnetSuffix =
  providers
    .environmentVariable("JARVIS_TAILNET_SUFFIX")
    .orNull
    ?.trim()
    ?.filter { it.isLetterOrDigit() || it == '.' || it == '-' }
    .orEmpty()

val wantsAndroidReleaseBuild =
  gradle.startParameter.taskNames.any { taskName ->
    taskName.contains("Release", ignoreCase = true) ||
      Regex("""(^|:)(bundle|assemble)$""").containsMatchIn(taskName)
  }

// FORK 2026-10-19 (the architect: phone app) — a thirdParty-only release build is fine with the Jarvis key alone.
val wantsOnlyThirdPartyRelease =
  gradle.startParameter.taskNames
    .filter { it.contains("Release", ignoreCase = true) || Regex("""(^|:)(bundle|assemble)$""").containsMatchIn(it) }
    .all { it.contains("ThirdParty", ignoreCase = true) }

if (wantsAndroidReleaseBuild && !hasAndroidReleaseSigning && !(jarvisSigning != null && wantsOnlyThirdPartyRelease)) {
  error(
    "Missing Android release signing properties. Set OPENCLAW_ANDROID_STORE_FILE, " +
      "OPENCLAW_ANDROID_STORE_PASSWORD, OPENCLAW_ANDROID_KEY_ALIAS, and " +
      "OPENCLAW_ANDROID_KEY_PASSWORD in ~/.gradle/gradle.properties. " +
      // FORK 2026-10-19 (the architect: phone app)
      "For a thirdParty (Jarvis) release alone, scripts/jarvis-signing-init.sh is enough.",
  )
}

plugins {
  alias(libs.plugins.android.application)
  alias(libs.plugins.ktlint)
  alias(libs.plugins.kotlin.compose)
  alias(libs.plugins.kotlin.serialization)
}

android {
  namespace = "ai.openclaw.app"
  compileSdk = 36

  // Release signing is local-only; keep the keystore path and passwords out of the repo.
  signingConfigs {
    if (hasAndroidReleaseSigning) {
      create("release") {
        storeFile = project.file(checkNotNull(resolvedAndroidStoreFile))
        storePassword = checkNotNull(androidStorePassword)
        keyAlias = checkNotNull(androidKeyAlias)
        keyPassword = checkNotNull(androidKeyPassword)
      }
    }
    // FORK 2026-10-19 (the architect: phone app) — see jarvisSigning above.
    if (jarvisSigning != null) {
      create("jarvis") {
        storeFile = checkNotNull(jarvisStoreFile)
        storePassword = jarvisSigning.getProperty("storePassword")
        keyAlias = jarvisSigning.getProperty("keyAlias")
        keyPassword = jarvisSigning.getProperty("keyPassword")
      }
    }
  }

  sourceSets {
    getByName("main") {
      assets.directories.add("../../shared/OpenClawKit/Sources/OpenClawKit/Resources")
    }
  }

  defaultConfig {
    applicationId = "ai.openclaw.app"
    minSdk = 31
    targetSdk = 36
    versionCode = 2026042700
    versionName = "2026.4.27"
    ndk {
      // Support all major ABIs — native libs are tiny (~47 KB per ABI)
      abiFilters += listOf("armeabi-v7a", "arm64-v8a", "x86", "x86_64")
    }
  }

  flavorDimensions += "store"

  productFlavors {
    create("play") {
      dimension = "store"
      // FORK 2026-10-19 (the architect: phone app) — false keeps the stock OpenClaw screens.
      buildConfigField("boolean", "JARVIS_APP", "false")
      buildConfigField("boolean", "JARVIS_DEV", "false")
      buildConfigField("String", "JARVIS_TAILNET_SUFFIX", "\"\"")
      buildConfigField("String", "JARVIS_PACK_KEY", "\"\"")
    }
    create("thirdParty") {
      dimension = "store"
      // FORK 2026-10-19 (the architect: phone app) — ships as "Jarvis" (name + icon in src/thirdParty/res);
      // the code namespace stays ai.openclaw.app.
      applicationId = "ai.tinkerclaw.jarvis"
      versionCode = jarvisVersionCode
      versionNameSuffix = "-jarvis"
      // FORK 2026-10-19 (the architect: phone app) — true turns on the Tinker home, the door pairing and the updater.
      buildConfigField("boolean", "JARVIS_APP", "true")
      buildConfigField("boolean", "JARVIS_DEV", jarvisDev.toString())
      buildConfigField("String", "JARVIS_TAILNET_SUFFIX", "\"$jarvisTailnetSuffix\"")
      buildConfigField("String", "JARVIS_PACK_KEY", "\"$jarvisPackKey\"")
      jarvisFirebase.forEach { (k, v) -> resValue("string", k, v) }
      // Loopback cleartext (127.0.0.1, localhost) only in a JARVIS_DEV build.
      manifestPlaceholders["jarvisNetworkSecurityConfig"] =
        if (jarvisDev) "@xml/network_security_config_dev" else "@xml/network_security_config"
    }
  }

  buildTypes {
    release {
      if (hasAndroidReleaseSigning) {
        signingConfig = signingConfigs.getByName("release")
      }
      // 2026-10-22 (speed up the next build): R8 shrinking is the slowest step on the Pi;
      // quick test builds pass -PjarvisQuick to skip it (jarvis-pi-publish does only with JARVIS_QUICK=1).
      val full = !project.hasProperty("jarvisQuick")
      isMinifyEnabled = full
      isShrinkResources = full
      ndk {
        debugSymbolLevel = "SYMBOL_TABLE"
      }
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
    }
    debug {
      isMinifyEnabled = false
    }
  }

  buildFeatures {
    compose = true
    buildConfig = true
    // FORK 2026-10-22: the Firebase settings arrive as resource values (jarvisFirebase above).
    resValues = true
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  packaging {
    resources {
      excludes +=
        setOf(
          "/META-INF/{AL2.0,LGPL2.1}",
          "/META-INF/*.version",
          "/META-INF/LICENSE*.txt",
          "DebugProbesKt.bin",
          "kotlin-tooling-metadata.json",
          "org/bouncycastle/pqc/crypto/picnic/lowmcL1.bin.properties",
          "org/bouncycastle/pqc/crypto/picnic/lowmcL3.bin.properties",
          "org/bouncycastle/pqc/crypto/picnic/lowmcL5.bin.properties",
          "org/bouncycastle/x509/CertPathReviewerMessages*.properties",
        )
    }
  }

  lint {
    lintConfig = file("lint.xml")
    warningsAsErrors = true
  }

  testOptions {
    unitTests.isIncludeAndroidResources = true
  }
}

androidComponents {
  // FORK 2026-10-19 (the architect: phone app) — a build type's signingConfig outranks the flavor's (debug
  // always carries the debug key), so pin the Jarvis key on every thirdParty variant here.
  if (jarvisSigning != null) {
    onVariants(selector().withFlavor("store" to "thirdParty")) { variant ->
      variant.signingConfig.setConfig(android.signingConfigs.getByName("jarvis"))
    }
  }
  onVariants { variant ->
    variant.outputs
      .filterIsInstance<VariantOutputImpl>()
      .forEach { output ->
        val versionName = output.versionName.orNull ?: "0"
        val buildType = variant.buildType
        val flavorName = variant.flavorName?.takeIf { it.isNotBlank() }
        val outputFileName =
          if (flavorName == null) {
            "openclaw-$versionName-$buildType.apk"
          } else {
            "openclaw-$versionName-$flavorName-$buildType.apk"
          }
        output.outputFileName = outputFileName
      }
  }
}
kotlin {
  compilerOptions {
    jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    allWarningsAsErrors.set(true)
  }
}

ktlint {
  android.set(true)
  ignoreFailures.set(false)
  filter {
    exclude("**/build/**")
  }
}

dependencies {
  val composeBom = platform(libs.androidx.compose.bom)
  implementation(composeBom)
  androidTestImplementation(composeBom)

  implementation(libs.androidx.core.ktx)
  implementation(libs.androidx.lifecycle.runtime.ktx)
  implementation(libs.androidx.activity.compose)
  implementation(libs.androidx.webkit)
  // FORK 2026-10-23: content-pack scripts run in the WebView's JS sandbox (jarvis/JarvisScript.kt).
  implementation(libs.androidx.javascriptengine)

  implementation(libs.androidx.compose.ui)
  implementation(libs.androidx.compose.ui.tooling.preview)
  implementation(libs.androidx.compose.material3)
  // material-icons-extended pulled in full icon set (~20 MB DEX). Only ~18 icons used.
  // R8 will tree-shake unused icons when minify is enabled on release builds.
  implementation(libs.androidx.compose.material.icons.extended)

  debugImplementation(libs.androidx.compose.ui.tooling)

  // Material Components (XML theme + resources)
  implementation(libs.material)

  implementation(libs.kotlinx.coroutines.android)
  implementation(libs.kotlinx.serialization.json)

  implementation(libs.androidx.security.crypto)
  implementation(libs.androidx.exifinterface)
  implementation(libs.okhttp)
  implementation(libs.firebase.messaging)
  implementation(libs.bcprov)
  implementation(libs.commonmark)
  implementation(libs.commonmark.ext.autolink)
  implementation(libs.commonmark.ext.gfm.strikethrough)
  implementation(libs.commonmark.ext.gfm.tables)
  implementation(libs.commonmark.ext.task.list.items)

  // CameraX (for node.invoke camera.* parity)
  implementation(libs.androidx.camera.core)
  implementation(libs.androidx.camera.camera2)
  implementation(libs.androidx.camera.lifecycle)
  implementation(libs.androidx.camera.video)
  implementation(libs.play.services.code.scanner)

  // Unicast DNS-SD (Wide-Area Bonjour) for tailnet discovery domains.
  implementation(libs.dnsjava)

  testImplementation(libs.junit)
  testImplementation(libs.kotlinx.coroutines.test)
  testImplementation(libs.kotest.runner.junit5)
  testImplementation(libs.kotest.assertions.core)
  testImplementation(libs.mockwebserver)
  testImplementation(libs.robolectric)
  testRuntimeOnly(libs.junit.vintage.engine)
}

tasks.withType<Test>().configureEach {
  useJUnitPlatform()
}

androidComponents {
  onVariants(selector().withBuildType("release")) { variant ->
    val variantName = variant.name
    val variantNameCapitalized = variantName.replaceFirstChar(Char::titlecase)
    val stripTaskName = "strip${variantNameCapitalized}DnsjavaServiceDescriptor"
    val mergeTaskName = "merge${variantNameCapitalized}JavaResource"
    val minifyTaskName = "minify${variantNameCapitalized}WithR8"
    val mergedJar =
      layout.buildDirectory.file(
        "intermediates/merged_java_res/$variantName/$mergeTaskName/base.jar",
      )

    val stripTask =
      tasks.register(stripTaskName) {
        inputs.file(mergedJar)
        outputs.file(mergedJar)

        doLast {
          val jarFile = mergedJar.get().asFile
          if (!jarFile.exists()) {
            return@doLast
          }

          val unpackDir = temporaryDir.resolve("merged-java-res")
          delete(unpackDir)
          copy {
            from(zipTree(jarFile))
            into(unpackDir)
            exclude(dnsjavaInetAddressResolverService)
          }
          delete(jarFile)
          ant.invokeMethod(
            "zip",
            mapOf(
              "destfile" to jarFile.absolutePath,
              "basedir" to unpackDir.absolutePath,
            ),
          )
        }
      }

    tasks.matching { it.name == mergeTaskName }.configureEach {
      finalizedBy(stripTask)
    }
    tasks.matching { it.name == minifyTaskName }.configureEach {
      dependsOn(stripTask)
    }
    // Quick builds (-PjarvisQuick, no R8) package the merged jar directly: order them after the strip too.
    tasks.matching { it.name == "package$variantNameCapitalized" }.configureEach {
      dependsOn(stripTask)
    }
  }
}
