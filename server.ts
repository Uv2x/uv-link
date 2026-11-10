/**
 * Runs Uv Link from source: `npm run dev` (Vite hot reload) or `npm start` (NODE_ENV=production
 * serves the built `dist/`). The PC desktop app runs the same server from electron-main.cjs.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { startUvLinkServer } from './server/uvlinkServer.ts';

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8')) as { version: string };

startUvLinkServer({
  port: Number(process.env.PORT) || 3000,
  dev: process.env.NODE_ENV !== 'production',
  staticDir: path.join(projectDir, 'dist'),
  // `npm run release` puts UvLink-TV.apk and UvLink-PC-Setup.exe here.
  downloadsDir: path.join(projectDir, 'release'),
  // Running from source: no self-updating (that's the installed PC app's job).
  appVersion: version
}).catch((err) => {
  console.error('Uv Link could not start:', err);
  process.exit(1);
});
