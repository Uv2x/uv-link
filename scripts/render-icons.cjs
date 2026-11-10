/**
 * Renders the Uv Link icon and Android TV banner to PNG using Electron's offscreen renderer.
 * Run: npx electron scripts/render-icons.cjs
 *
 * Writes:
 *   build/icon.png                                  512x512  (Windows app / installer icon)
 *   android-tv/app/src/main/res/mipmap-*dpi/ic_launcher.png   48..192
 *   android-tv/app/src/main/res/drawable-xhdpi/banner.png     320x180 (Android TV home row)
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();

const root = path.resolve(__dirname, '..');
const androidRes = path.join(root, 'android-tv', 'app', 'src', 'main', 'res');

const glyph = (size) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${size}" height="${size}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#13213a"/>
      <stop offset="1" stop-color="#020617"/>
    </linearGradient>
    <linearGradient id="beam" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="#34d399"/>
      <stop offset="1" stop-color="#38bdf8"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#bg)"/>
  <rect x="88" y="112" width="336" height="228" rx="30" fill="none" stroke="#38bdf8" stroke-width="28"/>
  <path d="M196 400h120" stroke="#38bdf8" stroke-width="28" stroke-linecap="round"/>
  <circle cx="150" cy="292" r="16" fill="#34d399"/>
  <path d="M150 240a52 52 0 0 1 52 52" fill="none" stroke="url(#beam)" stroke-width="24" stroke-linecap="round"/>
  <path d="M150 190a102 102 0 0 1 102 102" fill="none" stroke="url(#beam)" stroke-width="24" stroke-linecap="round"/>
</svg>`;

const page = (body, width, height) => `<!doctype html><html><head><style>
  html, body { margin: 0; width: ${width}px; height: ${height}px; background: transparent; overflow: hidden; }
  body { font-family: "Segoe UI", system-ui, sans-serif; }
</style></head><body>${body}</body></html>`;

const iconHtml = page(glyph(512), 512, 512);

const bannerHtml = page(
  `<div style="width:320px;height:180px;box-sizing:border-box;padding:0 22px;display:flex;align-items:center;gap:16px;
     background:linear-gradient(135deg,#13213a,#020617);">
     <div style="flex:none;width:92px;height:92px">${glyph(92)}</div>
     <div>
       <div style="color:#fff;font-size:40px;font-weight:700;letter-spacing:-0.5px;line-height:1">Uv Link</div>
       <div style="color:#7dd3fc;font-size:17px;font-weight:600;margin-top:8px">Cast receiver</div>
     </div>
   </div>`,
  320,
  180
);

// One 512x512 offscreen window renders everything; smaller images are cropped from its top-left.
// (A second offscreen window fails to load on some Windows setups.)
let renderWindow = null;

async function render(html, width, height) {
  if (!renderWindow) {
    renderWindow = new BrowserWindow({
      width: 512,
      height: 512,
      useContentSize: true,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      webPreferences: { offscreen: true }
    });
  }
  const htmlFile = path.join(os.tmpdir(), `uvlink-render-${width}x${height}-${process.pid}.html`);
  fs.writeFileSync(htmlFile, html);
  try {
    await renderWindow.loadFile(htmlFile);
  } finally {
    fs.rmSync(htmlFile, { force: true });
  }
  await new Promise((resolve) => setTimeout(resolve, 400));
  const image = await renderWindow.webContents.capturePage({ x: 0, y: 0, width, height });
  const size = image.getSize();
  if (size.width !== width || size.height !== height) {
    throw new Error(`Rendered ${size.width}x${size.height}, expected ${width}x${height}`);
  }
  return image;
}

function write(file, image) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, image.toPNG());
  console.log(`  wrote ${path.relative(root, file)} (${image.getSize().width}x${image.getSize().height})`);
}

app.whenReady().then(async () => {
  try {
    const icon = await render(iconHtml, 512, 512);
    write(path.join(root, 'build', 'icon.png'), icon);

    const densities = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
    for (const [density, size] of Object.entries(densities)) {
      write(
        path.join(androidRes, `mipmap-${density}`, 'ic_launcher.png'),
        icon.resize({ width: size, height: size, quality: 'best' })
      );
    }

    const banner = await render(bannerHtml, 320, 180);
    write(path.join(androidRes, 'drawable-xhdpi', 'banner.png'), banner);
    app.exit(0);
  } catch (err) {
    console.error(err);
    app.exit(1);
  }
});
