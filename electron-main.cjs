/**
 * Uv Link — Windows PC app (Electron).
 *
 * Runs the Uv Link server inside the app (so TVs on the Wi-Fi can connect to this PC),
 * opens the sender UI in a window, and answers the page's screen-capture request with
 * the screen you pick plus Windows system audio ("loopback").
 *
 * Build:  npm run build:pc      -> release/UvLink-PC-Setup.exe
 * Try it: npm run electron      (no installer)
 */
const { app, BrowserWindow, desktopCapturer, dialog, session, shell, Menu, screen } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PREFERRED_PORT = 3000;
const INSTALLER_NAME = 'UvLink-PC-Setup.exe';
/** Display names of virtual (driver-made) screens: a second screen just for the TV. */
const VIRTUAL_SCREEN = /virtual|vdd|mtt|idd|parsec|spacedesk|usbmmidd|dummy/i;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let mainWindow = null;
  let server = null;
  let updater = null;
  /** What the page picked in its screen/window picker, used by the next getDisplayMedia. */
  let pendingChoice = null;
  /** Window handle whose program's sound to capture ("this app only"), or null. */
  let appAudioWindow = null;

  /** Screens and windows with thumbnails, for the page's picker. */
  async function listCaptureSources() {
    const displays = screen.getAllDisplays();
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
    const screens = [];
    const windows = [];
    for (const source of sources) {
      const thumbnail = source.thumbnail.isEmpty() ? '' : source.thumbnail.toDataURL();
      if (source.id.startsWith('screen:')) {
        const display = displays.find((d) => String(d.id) === source.display_id);
        const label = (display && display.label) || '';
        screens.push({
          id: source.id,
          kind: 'screen',
          name: label || source.name,
          thumbnail,
          width: display ? Math.round(display.size.width * display.scaleFactor) : undefined,
          height: display ? Math.round(display.size.height * display.scaleFactor) : undefined,
          virtual: VIRTUAL_SCREEN.test(label)
        });
      } else if (source.name && !source.name.startsWith('Uv Link')) {
        windows.push({ id: source.id, kind: 'window', name: source.name, thumbnail });
      }
    }
    return [...screens, ...windows];
  }

  /** The bundled helper that captures one program's sound (build/native in development). */
  function appAudioHelperPath() {
    const file = app.isPackaged
      ? path.join(process.resourcesPath, 'native', 'UvLinkAppAudio.exe')
      : path.join(app.getAppPath(), 'build', 'native', 'UvLinkAppAudio.exe');
    return fs.existsSync(file) ? file : null;
  }

  /** Starts capturing the chosen window's program sound; the server streams it to the page. */
  function openAppAudio() {
    const helper = appAudioHelperPath();
    const hwnd = appAudioWindow;
    if (!helper || !hwnd) return null;
    const child = spawn(helper, ['--hwnd', hwnd], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child.on('error', (err) => console.error('Uv Link: app audio helper failed to start', err));
    child.stderr.on('data', (d) => console.error(`Uv Link app audio: ${String(d).trim()}`));
    return {
      stream: child.stdout,
      stop: () => {
        // Closing its input tells the helper to stop; make sure it does.
        child.stdin.end();
        setTimeout(() => child.kill(), 1500).unref();
      }
    };
  }

  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  /** One button per screen when there is more than one; null when the user cancels. */
  async function pickScreen(sources) {
    if (sources.length <= 1) return sources[0] ?? null;
    const buttons = sources.map((s, i) => (s.name && s.name !== 'Entire screen' ? s.name : `Screen ${i + 1}`));
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: 'Uv Link',
      message: 'Which screen do you want to cast to the TV?',
      buttons: [...buttons, 'Cancel'],
      cancelId: buttons.length,
      defaultId: 0,
      noLink: true
    });
    return response < sources.length ? sources[response] : null;
  }

  async function start() {
    const appRoot = app.getAppPath();
    // Bundled by `npm run build:server`; contains express, ws, bonjour-service and the updater.
    const { startUvLinkServer, createPcUpdater, githubRepoFromUrl } = require(
      path.join(appRoot, 'dist-server', 'uvlinkServer.cjs')
    );

    // Updates come from GitHub Releases of the repository in package.json. Only the installed
    // app updates itself; `npm run electron` (not packaged) leaves your files alone.
    const pkg = require(path.join(appRoot, 'package.json'));
    const repo = githubRepoFromUrl((pkg.repository && pkg.repository.url) || '');
    if (app.isPackaged && repo) {
      updater = createPcUpdater({
        currentVersion: app.getVersion(),
        repo,
        assetName: INSTALLER_NAME,
        downloadDir: path.join(app.getPath('userData'), 'updates'),
        // The installer's own switches: /S silent, --updated keeps settings and shortcuts,
        // --force-run starts the new version when it's done.
        install: (installer, relaunch) => {
          const args = ['--updated', '/S'];
          if (relaunch) args.push('--force-run');
          const child = spawn(installer, args, { detached: true, stdio: 'ignore' });
          child.on('error', (err) => console.error('Uv Link updater: could not start the installer', err));
          child.unref();
          if (relaunch) app.quit();
        },
        log: (message) => console.log(`Uv Link updater: ${message}`)
      });
    }

    try {
      server = await startUvLinkServer({
        port: PREFERRED_PORT,
        portFallback: true,
        dev: false,
        staticDir: path.join(appRoot, 'dist'),
        // The installer ships UvLink-TV.apk here so TVs can download it from this PC.
        downloadsDir: app.isPackaged
          ? path.join(process.resourcesPath, 'downloads')
          : path.join(appRoot, 'release'),
        printBanner: !app.isPackaged,
        updater: updater || undefined,
        appVersion: app.getVersion(),
        capture: {
          sources: listCaptureSources,
          choose: (choice) => {
            pendingChoice = { ...choice, at: Date.now() };
          },
          openAppAudio
        }
      });
      if (updater) updater.start();
    } catch (err) {
      dialog.showErrorBox('Uv Link could not start', String(err && err.message ? err.message : err));
      app.quit();
      return;
    }

    session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
      try {
        // The page's own picker chose a screen or window just before (see /api/capture/choice).
        const choice = pendingChoice && Date.now() - pendingChoice.at < 30_000 ? pendingChoice : null;
        pendingChoice = null;
        appAudioWindow = null;
        if (choice) {
          const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
          const source = sources.find((s) => s.id === choice.id);
          if (!source) {
            callback(null);
            return;
          }
          // "This app only": the page streams the program's sound from the helper instead.
          if (choice.audio === 'app' && source.id.startsWith('window:')) appAudioWindow = source.id.split(':')[1];
          const systemSound = request.audioRequested && choice.audio === 'system';
          callback(systemSound ? { video: source, audio: 'loopback' } : { video: source });
          return;
        }
        const sources = await desktopCapturer.getSources({ types: ['screen'] });
        const source = await pickScreen(sources);
        if (!source) {
          callback(null);
          return;
        }
        // 'loopback' = everything you hear on this PC (Windows only).
        callback(request.audioRequested ? { video: source, audio: 'loopback' } : { video: source });
      } catch (err) {
        console.error('Uv Link: screen capture failed', err);
        callback(null);
      }
    });

    Menu.setApplicationMenu(null);

    mainWindow = new BrowserWindow({
      width: 1380,
      height: 900,
      minWidth: 900,
      minHeight: 640,
      title: 'Uv Link',
      backgroundColor: '#020617',
      autoHideMenuBar: true,
      icon: path.join(appRoot, 'build', 'icon.png'),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Keep stats and the test pattern running while the window is minimized.
        backgroundThrottling: false
      }
    });

    // Links (e.g. download buttons that open new windows) go to the normal browser.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });

    mainWindow.on('closed', () => {
      mainWindow = null;
    });

    await mainWindow.loadURL(`http://localhost:${server.port}`);
  }

  app.whenReady().then(start);

  app.on('window-all-closed', async () => {
    if (updater) {
      updater.stop();
      // A downloaded update installs now, silently; the next start is the new version.
      updater.installOnQuit();
    }
    if (server) {
      await server.close().catch(() => {});
      server = null;
    }
    app.quit();
  });
}
