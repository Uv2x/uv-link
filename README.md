# Uv Link

Cast your PC's screen and sound to a TV on the same Wi-Fi.

Video and audio go **peer-to-peer over WebRTC** (H.264, 60 fps). A small server inside the PC app
lets TVs find the PC and sets up the connection; nothing leaves your home network.

| Part | Where | What it is |
| --- | --- | --- |
| PC app (Windows) | `electron-main.cjs`, `server/` | Electron app: runs the server, shares a screen with system sound |
| TV app (Android TV / Google TV) | `android-tv/` | Kotlin app: finds the PC automatically and plays the cast fullscreen |
| Web app | `src/` | React sender UI, and the TV receiver page (`/?mode=tv`) that works in any browser |

## Use it

1. **PC:** install `UvLink-PC-Setup.exe` and open **Uv Link**. When Windows Firewall asks, allow it on
   **private networks** so the TV can reach it.
2. **Android TV:** install the free **Downloader** app, open `http://<your-PC-IP>:3000/tv.apk`
   (the PC app shows the exact address), install, then open **Uv Link** on the TV.
   It finds the PC by itself.
   **Any other TV, phone or laptop:** open `http://<your-PC-IP>:3000/?mode=tv` in its browser.
3. **PC:** pick the TV and press **Cast Screen to TV**.

Tips:
- *Lip Sync* keeps sound and picture together (best for videos). *Low Delay* gives the lowest
  picture delay (games, desktop). Turn on your TV's Game Mode for the lowest delay overall.
- PC and TV must be on the same network. Guest Wi-Fi and router "AP isolation" block the connection.

## Develop

```bash
npm install
npm run dev        # http://localhost:3000 (sender) and http://<PC-IP>:3000/?mode=tv (TV)
npm test
npm run lint       # type check
npm run electron   # try the PC app without installing it
```

## Build the installers

The TV app needs Java 17, the Android SDK and Gradle. On Windows this script downloads them
(about 1 GB) into `%USERPROFILE%\.uvlink-build` and **accepts the Android SDK license**:

```bash
powershell -ExecutionPolicy Bypass -File scripts/setup-android-toolchain.ps1
```

Then:

```bash
npm run release    # -> release/UvLink-TV.apk and release/UvLink-PC-Setup.exe
```

`npm run build:tv` and `npm run build:pc` build them separately. The PC installer bundles the TV app,
so the PC can hand it to TVs at `/tv.apk`.

### On GitHub

Every push to `main` builds both installers in GitHub Actions (download them from the run's
**Artifacts**). Pushing a version tag also publishes them as a GitHub Release:

```bash
git tag v1.0.0
git push origin v1.0.0
```

To sign the TV app with your own key (so TVs can update without uninstalling), create a keystore
once and add these repository secrets: `UVLINK_KEYSTORE_BASE64` (the keystore file, base64),
`UVLINK_KEYSTORE_PASSWORD`, `UVLINK_KEY_ALIAS`, `UVLINK_KEY_PASSWORD`.

```bash
keytool -genkeypair -v -keystore uvlink-release.jks -alias uvlink -keyalg RSA -keysize 2048 -validity 10000
```

Keep the keystore and its passwords safe and out of the repo; a lost key means users must uninstall to update.

Notes:
- The APK is signed with a local development key (kept in `%USERPROFILE%\.uvlink-build`). Before
  publishing to the Play Store, set up your own signing key in `android-tv/app/build.gradle.kts`.
- The Windows installer isn't code-signed, so SmartScreen shows "Windows protected your PC" the first
  time: choose **More info → Run anyway**.
