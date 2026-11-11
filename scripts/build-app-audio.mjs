/**
 * Builds build/native/UvLinkAppAudio.exe (captures one program's sound for "this app only") with
 * the C# compiler that ships with Windows (.NET Framework 4.x). Nothing to install.
 * Run: npm run build:app-audio   (part of npm run build:pc)
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32') {
  console.log('App-only audio is Windows-only; skipping the helper.');
  process.exit(0);
}
const windir = process.env.WINDIR || 'C:\\Windows';
const csc = [
  path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')
].find((p) => fs.existsSync(p));
if (!csc) {
  console.error('The .NET Framework C# compiler (csc.exe) was not found; app-only audio will be unavailable.');
  process.exit(1);
}
const source = path.join(root, 'native', 'app-audio', 'UvLinkAppAudio.cs');
const outDir = path.join(root, 'build', 'native');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'UvLinkAppAudio.exe');
const result = spawnSync(csc, ['/nologo', '/optimize+', '/platform:x64', '/target:exe', `/out:${out}`, source], { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`App audio helper: ${path.relative(root, out)}`);
