/**
 * Updates the installed Windows PC app from GitHub Releases.
 *
 * Checks the repository's latest release, downloads the new installer in the background, checks
 * it against the SHA-256 GitHub published for it, and hands it to `install` (electron-main.cjs
 * runs it silently and restarts the app). A download that doesn't match is deleted, never run.
 */
import crypto from 'crypto';
import { once } from 'events';
import fs from 'fs';
import path from 'path';
import { isNewerVersion, parseRelease, type ReleaseAsset, type UpdateStatus } from '../src/shared/updates';

export interface PcUpdaterOptions {
  currentVersion: string;
  /** "owner/repo" on GitHub. */
  repo: string;
  /** Installer file name in each release, e.g. "UvLink-PC-Setup.exe". */
  assetName: string;
  /** Folder for downloaded installers (created when needed). */
  downloadDir: string;
  /** Runs a verified installer. `relaunch`: start the app again after installing. */
  install: (installerPath: string, relaunch: boolean) => void;
  /** GitHub API base; tests point it at a local server. */
  apiBase?: string;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}

export type PcUpdaterStatus = Omit<UpdateStatus, 'canControl'>;

export interface PcUpdater {
  status(): PcUpdaterStatus;
  /** Checks GitHub now. Resolves after the check; a download, if needed, continues in the background. */
  check(): Promise<void>;
  /** Resolves when the current download (if any) has finished. */
  settled(): Promise<void>;
  /** Installs a downloaded update and restarts the app. False when none is ready. */
  installNow(): boolean;
  /** When the app is closing: installs a downloaded update without restarting. */
  installOnQuit(): boolean;
  /** Checks after `firstDelayMs`, then every `intervalMs`. */
  start(intervalMs?: number, firstDelayMs?: number): void;
  stop(): void;
}

const SIX_HOURS = 6 * 60 * 60 * 1000;

type VerifiedAsset = ReleaseAsset & { sha256: string };

export function createPcUpdater(options: PcUpdaterOptions): PcUpdater {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBase = (options.apiBase ?? 'https://api.github.com').replace(/\/$/, '');
  const log = options.log ?? (() => {});
  const userAgent = `UvLink-PC/${options.currentVersion}`;

  const state: PcUpdaterStatus = {
    state: 'idle',
    currentVersion: options.currentVersion,
    latestVersion: null,
    progress: null,
    error: null,
    releaseUrl: null,
    checkedAt: null
  };
  let readyInstaller: string | null = null;
  let downloadTask: Promise<void> = Promise.resolve();
  let busy = false;
  let installing = false;
  let abort: AbortController | null = null;
  let firstTimer: NodeJS.Timeout | null = null;
  let intervalTimer: NodeJS.Timeout | null = null;

  const fail = (err: unknown) => {
    state.state = 'error';
    state.error = err instanceof Error ? err.message : String(err);
    state.progress = null;
    log(`update failed: ${state.error}`);
  };

  /** The installer to download, or null when there is nothing newer. */
  async function checkRelease(signal: AbortSignal): Promise<{ asset: VerifiedAsset; version: string } | null> {
    state.state = 'checking';
    state.error = null;
    const res = await fetchImpl(`${apiBase}/repos/${options.repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': userAgent },
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)])
    });
    state.checkedAt = new Date().toISOString();
    if (res.status === 404) {
      state.state = 'up-to-date';
      log('no releases published yet');
      return null;
    }
    if (!res.ok) {
      throw new Error(
        res.status === 403 || res.status === 429
          ? 'GitHub is limiting requests; will try again later'
          : `GitHub answered HTTP ${res.status}`
      );
    }
    const release = parseRelease(await res.json());
    if (!release) throw new Error("the latest release isn't a version number like v1.2.3");
    state.latestVersion = release.version;
    state.releaseUrl = release.pageUrl || null;
    if (!isNewerVersion(release.version, options.currentVersion)) {
      state.state = 'up-to-date';
      log(`up to date (v${options.currentVersion}; latest release v${release.version})`);
      return null;
    }
    const asset = release.assets.find((a) => a.name === options.assetName);
    if (!asset) throw new Error(`release ${release.tag} has no ${options.assetName}`);
    if (!asset.sha256) throw new Error(`release ${release.tag} has no checksum for ${options.assetName}`);
    return { asset: { ...asset, sha256: asset.sha256 }, version: release.version };
  }

  async function download(asset: VerifiedAsset, version: string, signal: AbortSignal): Promise<string> {
    fs.mkdirSync(options.downloadDir, { recursive: true });
    const target = path.join(options.downloadDir, `UvLink-PC-Setup-${version}.exe`);
    if (fs.existsSync(target) && (await sha256OfFile(target)) === asset.sha256) {
      log(`v${version} was already downloaded`);
      return target;
    }
    const partial = `${target}.partial`;
    state.state = 'downloading';
    state.progress = 0;
    log(`downloading v${version} (${asset.size} bytes)`);
    const res = await fetchImpl(asset.url, { headers: { 'User-Agent': userAgent }, signal, redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`download failed (HTTP ${res.status})`);
    const total = asset.size || Number(res.headers.get('content-length')) || 0;
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(partial);
    let received = 0;
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        hash.update(chunk);
        received += chunk.length;
        if (total) state.progress = Math.min(1, received / total);
        if (!out.write(chunk)) await once(out, 'drain');
      }
      await new Promise<void>((resolve, reject) => {
        out.once('error', reject);
        out.end(() => resolve());
      });
    } catch (err) {
      out.destroy();
      fs.rmSync(partial, { force: true });
      throw err;
    }
    if ((asset.size && received !== asset.size) || hash.digest('hex') !== asset.sha256) {
      fs.rmSync(partial, { force: true });
      throw new Error("the download didn't match GitHub's checksum, so it was deleted");
    }
    fs.renameSync(partial, target);
    // Older downloaded installers are no longer needed.
    for (const name of fs.readdirSync(options.downloadDir)) {
      const full = path.join(options.downloadDir, name);
      if (full !== target && /^UvLink-PC-Setup-.*\.exe(\.partial)?$/.test(name)) fs.rmSync(full, { force: true });
    }
    return target;
  }

  const install = (relaunch: boolean): boolean => {
    if (installing || state.state !== 'ready' || !readyInstaller || !fs.existsSync(readyInstaller)) return false;
    installing = true;
    log(`installing ${path.basename(readyInstaller)}${relaunch ? ' and restarting' : ' on quit'}`);
    options.install(readyInstaller, relaunch);
    return true;
  };

  const updater: PcUpdater = {
    status: () => ({ ...state }),

    async check() {
      if (busy || installing) return;
      busy = true;
      abort = new AbortController();
      const signal = abort.signal;
      let pending: { asset: VerifiedAsset; version: string } | null = null;
      try {
        pending = await checkRelease(signal);
      } catch (err) {
        if (!signal.aborted) fail(err);
      }
      if (!pending) {
        busy = false;
        return;
      }
      const { asset, version } = pending;
      downloadTask = (async () => {
        try {
          readyInstaller = await download(asset, version, signal);
          state.state = 'ready';
          state.progress = 1;
          log(`v${version} is ready to install`);
        } catch (err) {
          if (!signal.aborted) fail(err);
        } finally {
          busy = false;
        }
      })();
    },

    settled: () => downloadTask,

    installNow: () => install(true),

    installOnQuit: () => install(false),

    start(intervalMs = SIX_HOURS, firstDelayMs = 10_000) {
      if (firstTimer) clearTimeout(firstTimer);
      if (intervalTimer) clearInterval(intervalTimer);
      firstTimer = setTimeout(() => void updater.check(), firstDelayMs);
      intervalTimer = setInterval(() => void updater.check(), intervalMs);
      firstTimer.unref?.();
      intervalTimer.unref?.();
    },

    stop() {
      if (firstTimer) clearTimeout(firstTimer);
      if (intervalTimer) clearInterval(intervalTimer);
      firstTimer = intervalTimer = null;
      abort?.abort();
    }
  };
  return updater;
}

async function sha256OfFile(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
