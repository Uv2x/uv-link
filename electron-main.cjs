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
const { app, BrowserWindow, desktopCapturer, dialog, session, shell, Menu } = require('electron');
const path = require('path');

const PREFERRED_PORT = 3000;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let mainWindow = null;
  let server = null;

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
    // Bundled by `npm run build:server`; contains express, ws and bonjour-service.
    const { startUvLinkServer } = require(path.join(appRoot, 'dist-server', 'uvlinkServer.cjs'));

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
        printBanner: !app.isPackaged
      });
    } catch (err) {
      dialog.showErrorBox('Uv Link could not start', String(err && err.message ? err.message : err));
      app.quit();
      return;
    }

    session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
      try {
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
    if (server) {
      await server.close().catch(() => {});
      server = null;
    }
    app.quit();
  });
}
