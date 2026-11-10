plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// One version for the whole project: "version" in the repository's package.json (the PC app
// uses the same one). Updates come from GitHub Releases of its "repository".
val packageJson = rootProject.file("../package.json").readText()
val (versionMajor, versionMinor, versionPatch) =
    (Regex("\"version\"\\s*:\\s*\"(\\d+)\\.(\\d+)\\.(\\d+)\"").find(packageJson)
        ?: error("package.json needs a version like \"1.2.3\"")).destructured
val updateRepo = Regex("github\\.com[/:]([A-Za-z0-9_-]+/[A-Za-z0-9_-]+)").find(packageJson)?.groupValues?.get(1) ?: ""

android {
    namespace = "com.uvlink.tv"
    compileSdk = 35
    buildToolsVersion = "35.0.0"

    defaultConfig {
        applicationId = "com.uvlink.tv"
        minSdk = 23
        targetSdk = 35
        // 1.2.3 -> 10203, so every release has a higher code than the one before.
        versionCode = versionMajor.toInt() * 10000 + versionMinor.toInt() * 100 + versionPatch.toInt()
        versionName = "$versionMajor.$versionMinor.$versionPatch"
        buildConfigField("String", "UPDATE_REPO", "\"$updateRepo\"")
    }

    buildFeatures {
        buildConfig = true
    }

    // Your own release key, if provided (GitHub Actions passes it from repository secrets):
    //   UVLINK_KEYSTORE_FILE, UVLINK_KEYSTORE_PASSWORD, UVLINK_KEY_ALIAS, UVLINK_KEY_PASSWORD
    // Without it, the APK is signed with this machine's debug key so it still installs.
    val releaseKeystore = System.getenv("UVLINK_KEYSTORE_FILE")?.takeIf { it.isNotBlank() }
    signingConfigs {
        if (releaseKeystore != null) {
            create("release") {
                storeFile = file(releaseKeystore)
                storePassword = System.getenv("UVLINK_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("UVLINK_KEY_ALIAS")
                keyPassword = System.getenv("UVLINK_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName(if (releaseKeystore != null) "release" else "debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // Tests only (run on the JVM): the AirPlay receiver against the JDK's Ed25519/X25519,
    // a real iPhone capture, and a fake iPhone over sockets. The app itself has no dependencies.
    testImplementation("junit:junit:4.13.2")
    testImplementation("com.googlecode.plist:dd-plist:1.28")
    // Android's own org.json is only a stub on the JVM; the updater's tests need the real thing.
    testImplementation("org.json:json:20240303")
}
