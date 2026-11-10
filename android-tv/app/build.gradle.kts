plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.uvlink.tv"
    compileSdk = 35
    buildToolsVersion = "35.0.0"

    defaultConfig {
        applicationId = "com.uvlink.tv"
        minSdk = 23
        targetSdk = 35
        versionCode = 2
        versionName = "1.1.0"
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
}
