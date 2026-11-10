/**
 * Updates from GitHub Releases, shared by the PC app's updater (server/pcUpdater.ts), the
 * server's /api/update routes and the update bar in the UI. No Node or browser APIs here.
 */

/** A downloadable file of a release, with the SHA-256 GitHub computed when it was uploaded. */
export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
  /** Lowercase hex, or null when GitHub didn't provide one. */
  sha256: string | null;
}

export interface ReleaseInfo {
  /** "1.2.0" (tag without the leading "v"). */
  version: string;
  tag: string;
  pageUrl: string;
  notes: string;
  assets: ReleaseAsset[];
}

export type UpdateState =
  | 'disabled' // not the installed PC app (dev server, or a browser on another device)
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'downloading'
  | 'ready' // downloaded and verified; installs on restart
  | 'error';

export interface UpdateStatus {
  state: UpdateState;
  currentVersion: string;
  latestVersion: string | null;
  /** 0..1 while downloading. */
  progress: number | null;
  error: string | null;
  releaseUrl: string | null;
  /** ISO time of the last finished check. */
  checkedAt: string | null;
  /** Whether this viewer may trigger checks and installs (only the PC app's own window). */
  canControl: boolean;
}

/** "v1.2.3" or "1.2.3" -> [1, 2, 3]; null for anything else (including pre-releases like 1.2.3-beta). */
export function parseVersion(version: string): [number, number, number] | null {
  const match = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** True when `candidate` is a strictly newer version than `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/** "owner/repo" out of "https://github.com/owner/repo.git", "git+https://…", "github:owner/repo". */
export function githubRepoFromUrl(url: string): string | null {
  const match = /(?:github\.com[/:]|^github:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? match[1] : null;
}

/** Reads GitHub's "latest release" API response. Returns null if it isn't a usable release. */
export function parseRelease(json: unknown): ReleaseInfo | null {
  if (!json || typeof json !== 'object') return null;
  const release = json as Record<string, unknown>;
  if (release.draft === true || release.prerelease === true) return null;
  const tag = typeof release.tag_name === 'string' ? release.tag_name : '';
  const parsed = parseVersion(tag);
  if (!parsed) return null;
  const assets: ReleaseAsset[] = [];
  for (const raw of Array.isArray(release.assets) ? release.assets : []) {
    if (!raw || typeof raw !== 'object') continue;
    const asset = raw as Record<string, unknown>;
    if (typeof asset.name !== 'string' || typeof asset.browser_download_url !== 'string') continue;
    const digest = typeof asset.digest === 'string' ? asset.digest : '';
    const sha256 = /^sha256:([0-9a-fA-F]{64})$/.exec(digest)?.[1]?.toLowerCase() ?? null;
    assets.push({
      name: asset.name,
      url: asset.browser_download_url,
      size: typeof asset.size === 'number' ? asset.size : 0,
      sha256
    });
  }
  return {
    version: parsed.join('.'),
    tag,
    pageUrl: typeof release.html_url === 'string' ? release.html_url : '',
    notes: typeof release.body === 'string' ? release.body : '',
    assets
  };
}
