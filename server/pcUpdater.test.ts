import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { createPcUpdater } from './pcUpdater';

/** A local stand-in for api.github.com and the release download, serving `installer`. */
async function fakeGitHub(options: { tag: string; installer: Buffer; digest?: string | null; status?: number }) {
  let downloads = 0;
  const server = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    if (req.url === '/repos/Uv2x/uv-link/releases/latest') {
      if (options.status) {
        res.writeHead(options.status).end();
        return;
      }
      const digest =
        options.digest === undefined
          ? `sha256:${crypto.createHash('sha256').update(options.installer).digest('hex')}`
          : options.digest;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          tag_name: options.tag,
          html_url: `https://github.com/Uv2x/uv-link/releases/tag/${options.tag}`,
          assets: [
            { name: 'UvLink-TV.apk', browser_download_url: `${base}/tv`, size: 3, digest: null },
            { name: 'UvLink-PC-Setup.exe', browser_download_url: `${base}/redirect`, size: options.installer.length, digest }
          ]
        })
      );
    } else if (req.url === '/redirect') {
      // Release downloads redirect to a storage host, like GitHub's do.
      res.writeHead(302, { Location: `${base}/file` }).end();
    } else if (req.url === '/file') {
      downloads++;
      res.writeHead(200, { 'Content-Length': options.installer.length });
      res.end(options.installer);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    apiBase: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    downloads: () => downloads,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

function setup(apiBase: string, currentVersion = '1.1.0') {
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uvlink-updates-'));
  const installs: Array<{ file: string; relaunch: boolean }> = [];
  const updater = createPcUpdater({
    currentVersion,
    repo: 'Uv2x/uv-link',
    assetName: 'UvLink-PC-Setup.exe',
    downloadDir,
    apiBase,
    install: (file, relaunch) => installs.push({ file, relaunch })
  });
  return { updater, downloadDir, installs };
}

test('downloads a newer release, verifies it, and installs on request', async () => {
  const installer = crypto.randomBytes(300_000);
  const github = await fakeGitHub({ tag: 'v1.2.0', installer });
  const { updater, downloadDir, installs } = setup(github.apiBase);
  try {
    await updater.check();
    assert.match(updater.status().state, /downloading|ready/);
    await updater.settled();
    const status = updater.status();
    assert.equal(status.state, 'ready');
    assert.equal(status.latestVersion, '1.2.0');
    assert.equal(status.progress, 1);
    const file = path.join(downloadDir, 'UvLink-PC-Setup-1.2.0.exe');
    assert.deepEqual(fs.readFileSync(file), installer);

    assert.equal(updater.installNow(), true);
    assert.deepEqual(installs, [{ file, relaunch: true }]);
    assert.equal(updater.installNow(), false, 'installs only once');

    // A second check reuses the verified file instead of downloading again.
    const again = setup(github.apiBase);
    fs.copyFileSync(file, path.join(again.downloadDir, 'UvLink-PC-Setup-1.2.0.exe'));
    await again.updater.check();
    await again.updater.settled();
    assert.equal(again.updater.status().state, 'ready');
    assert.equal(github.downloads(), 1);
  } finally {
    await github.close();
  }
});

test('deletes a download that does not match the checksum, and never installs it', async () => {
  const github = await fakeGitHub({ tag: 'v1.2.0', installer: Buffer.from('tampered'), digest: `sha256:${'0'.repeat(64)}` });
  const { updater, downloadDir, installs } = setup(github.apiBase);
  try {
    await updater.check();
    await updater.settled();
    const status = updater.status();
    assert.equal(status.state, 'error');
    assert.match(status.error ?? '', /checksum/);
    assert.deepEqual(fs.readdirSync(downloadDir), []);
    assert.equal(updater.installNow(), false);
    assert.equal(updater.installOnQuit(), false);
    assert.deepEqual(installs, []);
  } finally {
    await github.close();
  }
});

test('refuses a release without a checksum', async () => {
  const github = await fakeGitHub({ tag: 'v1.2.0', installer: Buffer.from('x'), digest: null });
  const { updater } = setup(github.apiBase);
  try {
    await updater.check();
    assert.equal(updater.status().state, 'error');
    assert.match(updater.status().error ?? '', /no checksum/);
    assert.equal(github.downloads(), 0);
  } finally {
    await github.close();
  }
});

test('reports up to date when the latest release is not newer', async () => {
  const github = await fakeGitHub({ tag: 'v1.1.0', installer: Buffer.from('x') });
  const { updater } = setup(github.apiBase, '1.1.0');
  try {
    await updater.check();
    assert.equal(updater.status().state, 'up-to-date');
    assert.equal(updater.status().latestVersion, '1.1.0');
    assert.ok(updater.status().checkedAt);
    assert.equal(github.downloads(), 0);
  } finally {
    await github.close();
  }
});

test('explains GitHub rate limits and installs on quit only when ready', async () => {
  const github = await fakeGitHub({ tag: 'v1.2.0', installer: Buffer.from('x'), status: 403 });
  const { updater, installs } = setup(github.apiBase);
  try {
    await updater.check();
    assert.equal(updater.status().state, 'error');
    assert.match(updater.status().error ?? '', /limiting/);
    assert.equal(updater.installOnQuit(), false);
    assert.deepEqual(installs, []);
  } finally {
    await github.close();
  }
});
