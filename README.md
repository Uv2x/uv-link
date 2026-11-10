# Uv Link

Cast your PC's screen and sound to a TV on the same Wi-Fi.

Video and audio go **peer-to-peer over WebRTC** (H.264, 60 fps). A small server inside the PC app
lets TVs find the PC and sets up the connection; nothing leaves your home network.

| Part | Where | What it is |
| --- | --- | --- |
| PC app (Windows) | `electron-main.cjs`, `server/` | Electron app: runs the server, shares a screen with system sound |
| TV app (Android TV / Google TV) | `android-tv/` | Kotlin app: finds the PC automatically and plays the cast fullscreen; also an AirPlay target for iPhone and iPad |
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

### iPhone and iPad (AirPlay)

While the Uv Link app is open on an Android TV, it is also an AirPlay screen-mirroring target. No
PC needed and nothing to install on the iPhone:

1. Open **Uv Link** on the TV. Its start screen shows the name it uses, e.g. *Uv Link (Living Room TV)*.
2. On the iPhone or iPad (same Wi-Fi): **Control Center → Screen Mirroring →** that name.
3. Press **Back** on the TV remote, or *Stop Mirroring* on the phone, to end it.

The screen and its sound are mirrored (H.264 video, AAC-ELD audio). Not supported yet: playing to the
TV as an AirPlay *speaker* only (e.g. from the Music app's AirPlay button), and AirPlay while the
app is closed. The bottom line of the TV's start screen shows the latest AirPlay event, and
`http://<TV-IP>:7000/uvlink/log` lists recent ones, for troubleshooting.

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
**Artifacts**). To publish a release, set the new `"version"` in `package.json` (both apps use it),
commit, and push a matching tag:

```bash
git tag v1.2.0
git push origin v1.2.0
```

The workflow refuses a tag that doesn't match `package.json`, then publishes `UvLink-PC-Setup.exe`
and `UvLink-TV.apk` as a GitHub Release.

## Automatic updates

Installed apps update themselves from this repository's latest GitHub Release (the `repository`
in `package.json`), and only install files whose SHA-256 matches the checksum GitHub lists:

- **PC app:** checks when it starts and every 6 hours, downloads the new installer in the
  background, and shows **Restart to update** at the bottom of the window. If you just close Uv Link,
  the update installs then. The installer runs silently and keeps your settings.
- **TV app:** checks when it opens (at most once an hour) and shows **Update to Uv Link x.y.z** on its
  start screen. Android asks you to confirm; the first time it also asks you to allow Uv Link to
  install apps.

TV updates only install when every APK is signed with the same key. That key lives in
`%USERPROFILE%\.uvlink-build\signing` (local builds use it automatically) and in the repository
secrets `UVLINK_KEYSTORE_BASE64`, `UVLINK_KEYSTORE_PASSWORD`, `UVLINK_KEY_ALIAS` and
`UVLINK_KEY_PASSWORD` (GitHub builds). **Back up that folder.** If the key is lost, every TV has to
uninstall Uv Link before it can install a new version.

Notes:
- The TV app (`android-tv/`) is licensed under the GPL-3.0 because its AirPlay receiver includes
  GPL-derived FairPlay code; see [android-tv/NOTICE.md](android-tv/NOTICE.md) for credits.
- Without the signing folder (e.g. on another PC), `npm run build:tv` signs with a throwaway debug
  key, and TVs can't update from that build to a release.
- The Windows installer isn't code-signed, so SmartScreen shows "Windows protected your PC" the first
  time: choose **More info → Run anyway**. Automatic updates don't show that warning.
