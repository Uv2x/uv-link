# Uv Link

Cast your PC's screen and sound to a TV on the same Wi-Fi, and mirror your iPhone to it too.

**Download:** [Windows PC app (`UvLink-PC-Setup.exe`)](https://github.com/Uv2x/uv-link/releases/latest/download/UvLink-PC-Setup.exe) ·
[Android TV app (`UvLink-TV.apk`)](https://github.com/Uv2x/uv-link/releases/latest/download/UvLink-TV.apk) ·
[all releases](https://github.com/Uv2x/uv-link/releases)

Video and sound go **straight from the PC to the TV** (WebRTC, peer-to-peer). A small server inside
the PC app only helps the two find each other; nothing leaves your home network.

## What it does

- **Cast a screen or a single window** to any TV on your network, with all PC sound, only that
  window's sound, or none.
- **Use the TV as a second screen**, with a virtual display or a spare monitor.
- **Sized for the TV:** the picture is never bigger than the TV can show (an ultrawide 3440x1440
  screen goes out as 1920x804), and it shrinks by itself when the TV can't keep up.
- **Recovers from freezes:** if the TV can't play a video format, Uv Link switches to another one
  within seconds and remembers what works for that TV.
- **Hardware encoding:** H.264 is encoded on the graphics card (NVIDIA, AMD or Intel).
- **iPhone and iPad:** mirror the screen with AirPlay, or use the TV as an AirPlay speaker for Music.
  An iPhone can share the screen with the PC cast, side by side or picture in picture.
- **Updates itself** from GitHub, on the PC and on the TV.

## What you need

| Device | Requirement |
| --- | --- |
| PC | Windows 10 (version 2004 or later) or Windows 11, 64-bit |
| Android TV / Google TV | Android 6.0 or later, for the TV app (finds the PC by itself, AirPlay) |
| Any other TV, phone or laptop | A web browser: it can show the PC's cast at `http://<PC-IP>:3000/?mode=tv` |

PC and TV must be on the same network. Guest Wi-Fi and the router setting "AP isolation" block the
connection.

## Get started

1. **PC:** install `UvLink-PC-Setup.exe` and open **Uv Link**. When Windows Firewall (or your antivirus
   firewall) asks, allow Uv Link on **private networks**, so the TV can reach it. The installer isn't
   code-signed, so the first time Windows says "Windows protected your PC": choose
   **More info → Run anyway**.
2. **Android TV:** install the free **Downloader** app from the Play Store, then open either
   `https://github.com/Uv2x/uv-link/releases/latest/download/UvLink-TV.apk` or
   `http://<your-PC-IP>:3000/tv.apk` (the PC app shows its exact address). Install it and open
   **Uv Link** on the TV. It finds the PC by itself.
   **Samsung, LG or another TV:** open `http://<your-PC-IP>:3000/?mode=tv` in the TV's browser instead.
3. **PC:** pick the TV and press **Cast Screen to TV**.

## Casting

**Cast Screen to TV** opens a picker with every screen and window:

- **Screens** or a single **window** (a game, a browser, a video player).
- **Sound:** *All PC sound*, *Only this app* (just the chosen window's program, so notifications and
  Discord stay off the TV), or *No sound*.

The **Settings** panel (remembered between sessions):

| Setting | Choices |
| --- | --- |
| Video format | H.264 (default, encoded on the graphics card), VP8, VP9, AV1, H.265. If the TV can't play it, Uv Link switches format by itself. |
| Frame rate | 30, 60 or 120 fps. 120 fps needs a 120 Hz TV running the Uv Link TV app; the TV switches to 120 Hz while casting. |
| Quality cap | Max (60 Mbps), High (35 Mbps), Medium (12 Mbps), Low (5 Mbps). Lower helps on busy or 2.4 GHz Wi-Fi. |
| When the network is busy | Keep it smooth (games, video), keep it sharp (text), or balance both. |

Next to the sound meter, **Lip Sync** keeps sound and picture together (best for videos), and
**Low Delay** gives the lowest picture delay (games, desktop). Turn on your TV's Game Mode for the
lowest delay overall.

The **Connection** panel and the stats under the cast show live measurements only: bitrate,
round-trip time, the encoder (and whether it's hardware), what the TV decodes, frames decoded and
received, and freezes.

### Use the TV as a second screen

Install the free, open-source [Virtual Display Driver](https://github.com/VirtualDrivers/Virtual-Display-Driver/releases/latest),
add a 1920x1080 display in it, and choose *Extend these displays* in Windows display settings. The new
screen appears in Uv Link's picker marked *second screen for the TV*: cast it and drag windows onto
the TV like a real monitor. A spare physical monitor works the same way.

## iPhone and iPad (AirPlay)

While the Uv Link app is open on an Android TV, it's also an AirPlay receiver. No PC is needed and
there's nothing to install on the iPhone:

- **Mirror the screen:** on the iPhone (same Wi-Fi) open **Control Center → Screen Mirroring** and pick
  the TV's name, e.g. *Uv Link (Living Room TV)*; the TV's start screen shows it.
- **Use the TV as a speaker:** tap the AirPlay button in Music or another audio app and pick the TV.
- **Together with the PC:** if the PC is casting when the iPhone starts mirroring, both share the
  screen. **◀ ▶** on the remote switch between side by side, picture in picture and iPhone full screen.
- **Back** on the remote, or *Stop Mirroring* on the iPhone, ends it.

AirPlay only works while the Uv Link app is open on the TV.

## Updates

Both apps update themselves from this repository's latest GitHub Release, and only install files
whose SHA-256 matches the checksum GitHub lists:

- **PC app:** checks at start and every 6 hours, downloads the new version in the background, and
  shows **Restart to update** at the bottom of the window (or installs it when you close Uv Link).
- **TV app:** checks when it opens and shows **Update to Uv Link x.y.z** on its start screen. Android
  asks you to confirm; the first time it also asks you to allow Uv Link to install apps.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| The TV doesn't see the PC, or Downloader can't reach it | Allow Uv Link through Windows Firewall *and* your antivirus firewall (e.g. AVG: Enhanced Firewall → allow `Uv Link.exe`, or mark the network as private). Check the TV's IP address starts like the PC's (e.g. both `192.168.8.x`). |
| The picture freezes | Uv Link should switch format within seconds and show a note. The stats show frames decoded vs received; the **Connection log** shows `DECODE STALLED` when it happens. |
| The TV lags behind | It's probably decoding in software. Uv Link shrinks the picture and, if needed, drops to 30 fps; you can also pick a lower quality cap or 30 fps. |
| "App not installed" on the TV | An older Uv Link signed with a different key is installed. Uninstall it once, then install again. |
| iPhone can't find the TV | The Uv Link app must be open on the TV, on the same Wi-Fi. The bottom line of the TV's start screen shows the latest AirPlay event; `http://<TV-IP>:7000/uvlink/log` lists recent ones. |

## Limits

- No HDR and no 5.1 or 7.1 surround: the capture, WebRTC and TV-browser parts are 8-bit picture and
  stereo sound.
- A TV without the app (Samsung, LG...) can watch the PC's cast in its browser but can't receive
  AirPlay or update itself.
- Phones can't send their screen through Uv Link's web page. iPhones use AirPlay to the TV app;
  Android phones can use the TV's own Cast.

## How it works

| Part | Where | What it is |
| --- | --- | --- |
| PC app (Windows) | `electron-main.cjs`, `server/` | Electron app: runs the server (signaling, mDNS discovery, TV app download, updater), the screen/window picker and screen capture |
| App-sound helper | `native/app-audio/` | Small Windows program that captures one program's sound (process loopback) for *Only this app* |
| Web app | `src/` | React sender page, and the TV receiver page (`/?mode=tv`) that runs in the TV app or any browser |
| TV app (Android TV / Google TV) | `android-tv/` | Kotlin app: finds the PC (mDNS), shows the receiver page fullscreen, AirPlay receiver (mirroring, Apple Lossless audio), self-updater |

The PC and TV talk over a WebSocket on port 3000 (another port if that one is busy) to set up a
WebRTC connection; the video and sound then flow directly between them. The TV app's AirPlay receiver
listens on port 7000.

## Develop

```bash
npm install
npm run dev        # http://localhost:3000 (sender) and http://<PC-IP>:3000/?mode=tv (TV)
npm test           # web and server tests
npm run lint       # type check
npm run electron   # try the PC app without installing it
```

The TV app's tests run with its build (`npm run build:tv`).

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

`npm run build:tv` and `npm run build:pc` build them separately. The PC build also compiles the
app-sound helper with the C# compiler that ships with Windows (nothing to install), and the PC
installer bundles the TV app so the PC can hand it to TVs at `/tv.apk`.

### Releases on GitHub

Every push to `main` builds both installers in GitHub Actions (download them from the run's
**Artifacts**). To publish a release, set the new `"version"` in `package.json` (both apps use it),
commit, and push a matching tag:

```bash
git tag v1.2.1
git push origin v1.2.1
```

The workflow refuses a tag that doesn't match `package.json`, runs the tests, and publishes
`UvLink-PC-Setup.exe` and `UvLink-TV.apk` as a GitHub Release. Installed apps then update themselves.

### TV signing key

TVs only install an update signed with the same key as the installed app. The key lives in
`%USERPROFILE%\.uvlink-build\signing` (local builds use it automatically) and in the repository
secrets `UVLINK_KEYSTORE_BASE64`, `UVLINK_KEYSTORE_PASSWORD`, `UVLINK_KEY_ALIAS` and
`UVLINK_KEY_PASSWORD` (GitHub builds). **Back up that folder:** if the key is lost, every TV has to
uninstall Uv Link before it can install a new version. Without it (e.g. on another PC),
`npm run build:tv` signs with a throwaway debug key.

## Licenses and credits

- The TV app (`android-tv/`) is licensed under the **GPL-3.0**, because its AirPlay receiver includes
  GPL-derived FairPlay code. It builds on [java-airplay](https://github.com/serezhka/java-airplay)
  (MIT), [PlayFair](https://github.com/EstebanKubata/playfair) (GPL),
  [UxPlay](https://github.com/FDH2/UxPlay) (GPL-3.0) as a protocol reference, and Apple's
  [ALAC decoder](https://github.com/macosforge/alac) (Apache 2.0). See
  [android-tv/NOTICE.md](android-tv/NOTICE.md).
- The rest of the repository (PC app, web app) has no license file yet.
- AirPlay, iPhone and iPad are trademarks of Apple Inc. Uv Link is not affiliated with Apple.
