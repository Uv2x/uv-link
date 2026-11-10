/**
 * Builds the Android TV app and copies it to release/UvLink-TV.apk.
 * Run: npm run build:tv
 *
 * Uses JAVA_HOME / ANDROID_HOME when set, otherwise the toolchain that
 * scripts/setup-android-toolchain.ps1 downloads into ~/.uvlink-build.
 * Gradle caches and the signing key also live there, not in your user profile.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const androidDir = path.join(root, 'android-tv');
const toolchain = path.join(os.homedir(), '.uvlink-build');
const isWindows = process.platform === 'win32';
const GRADLE_VERSION = '8.11.1';

function fail(message) {
  console.error(`\nUv Link TV build: ${message}`);
  if (isWindows) {
    console.error('Install the build tools with:\n  powershell -ExecutionPolicy Bypass -File scripts\\setup-android-toolchain.ps1\n');
  }
  process.exit(1);
}

const javaHome = process.env.JAVA_HOME || path.join(toolchain, 'jdk-17');
const sdkDir = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(toolchain, 'android-sdk');
if (!fs.existsSync(path.join(javaHome, 'bin', isWindows ? 'java.exe' : 'java'))) fail(`No JDK found at ${javaHome}.`);
if (!fs.existsSync(sdkDir)) fail(`No Android SDK found at ${sdkDir}.`);
if (!fs.existsSync(path.join(sdkDir, 'platforms', 'android-35'))) {
  // Gradle installs missing SDK packages itself when the SDK license has been accepted.
  console.warn(`Android SDK platform 35 not found in ${sdkDir}; Gradle will try to install it.`);
}

// Prefer the downloaded Gradle (no second download); fall back to the project's wrapper.
const toolchainGradle = path.join(toolchain, `gradle-${GRADLE_VERSION}`, 'bin', isWindows ? 'gradle.bat' : 'gradle');
const wrapper = path.join(androidDir, isWindows ? 'gradlew.bat' : 'gradlew');
const gradle = fs.existsSync(toolchainGradle) ? toolchainGradle : wrapper;
if (!fs.existsSync(gradle)) fail('Gradle not found.');

const env = {
  ...process.env,
  JAVA_HOME: javaHome,
  ANDROID_HOME: sdkDir,
  ANDROID_SDK_ROOT: sdkDir,
  GRADLE_USER_HOME: process.env.GRADLE_USER_HOME || path.join(toolchain, 'gradle-home'),
  // Holds the debug signing key. Keep this folder: a new key means the TV must uninstall before updating.
  ANDROID_USER_HOME: process.env.ANDROID_USER_HOME || path.join(toolchain, 'android-user-home')
};
// The release signing key. TVs only accept an update signed with the same key as the installed
// app, so local builds use the same key as GitHub Actions (which gets it from repository secrets).
// Kept outside the repo; back it up. Without it, builds are signed with a throwaway debug key.
const signingDir = path.join(toolchain, 'signing');
const keystore = path.join(signingDir, 'uvlink-release.jks');
const keystoreProps = path.join(signingDir, 'keystore.properties');
if (!env.UVLINK_KEYSTORE_FILE && fs.existsSync(keystore) && fs.existsSync(keystoreProps)) {
  const props = Object.fromEntries(
    fs
      .readFileSync(keystoreProps, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.includes('=') && !line.startsWith('#'))
      .map((line) => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()])
  );
  env.UVLINK_KEYSTORE_FILE = keystore;
  env.UVLINK_KEYSTORE_PASSWORD = props.storePassword;
  env.UVLINK_KEY_ALIAS = props.keyAlias;
  env.UVLINK_KEY_PASSWORD = props.keyPassword;
  console.log('Signing with the Uv Link release key.');
} else if (!env.UVLINK_KEYSTORE_FILE) {
  console.warn('No release key found: signing with a debug key (TVs must uninstall before installing a differently signed build).');
}
if (isWindows && !env.JAVA_TOOL_OPTIONS) {
  // Trust the same certificates as Windows. Antivirus HTTPS scanning installs its own root
  // certificate there, and without this Java can't download Gradle plugins ("PKIX path building failed").
  env.JAVA_TOOL_OPTIONS = '-Djavax.net.ssl.trustStoreType=Windows-ROOT';
}

console.log(`Testing and building the Android TV app with ${path.basename(gradle)} …`);
// Unit tests first (AirPlay receiver: crypto, plists, a real iPhone capture, a fake iPhone session).
// Windows needs a shell to run .bat files, and then the path (with its spaces) must be quoted.
const tasks = ['testReleaseUnitTest', 'assembleRelease', '--no-daemon', '--console=plain'];
const result = spawnSync(isWindows ? `"${gradle}"` : gradle, tasks, {
  cwd: androidDir,
  env,
  stdio: 'inherit',
  shell: isWindows
});
if (result.status !== 0) fail(`Gradle failed (exit ${result.status}).`);

const apk = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
if (!fs.existsSync(apk)) fail(`Expected ${apk} but it was not produced.`);
const outDir = path.join(root, 'release');
fs.mkdirSync(outDir, { recursive: true });
const target = path.join(outDir, 'UvLink-TV.apk');
fs.copyFileSync(apk, target);
console.log(`\nAndroid TV app: ${path.relative(root, target)} (${(fs.statSync(target).size / 1024 / 1024).toFixed(1)} MB)`);
