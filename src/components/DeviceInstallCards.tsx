import React, { useState, useEffect } from 'react';
import {
  Tv,
  Laptop,
  Smartphone,
  Download,
  Maximize2,
  Copy,
  Check,
  RefreshCw,
  ArrowUpCircle
} from 'lucide-react';

interface AutoUpdateStatus {
  githubRepo: string;
  channel: string;
  autoCheckEnabled: boolean;
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  lastChecked: string;
  releaseNotes: string;
  assets: {
    tvApk: string;
    pcExe: string;
  };
}

interface DeviceInstallCardsProps {
  onEnterTvMode: () => void;
  /** http://<this PC's LAN IP>:3000/?mode=tv, or null when the PC has no network address. */
  tvUrl: string | null;
  receiverCount: number;
}

export const DeviceInstallCards: React.FC<DeviceInstallCardsProps> = ({
  onEnterTvMode,
  tvUrl,
  receiverCount
}) => {
  const [tvUrlCopied, setTvUrlCopied] = useState<boolean>(false);
  const [downloads, setDownloads] = useState<{ tvApk: boolean; pcExe: boolean }>({ tvApk: false, pcExe: false });
  const baseUrl = tvUrl ? tvUrl.replace(/\/\?mode=tv$/, '') : null;
  const isPcApp = typeof navigator !== 'undefined' && navigator.userAgent.includes('Electron');

  // Which installers this PC can hand out (built by `npm run release`).
  useEffect(() => {
    fetch('/api/info')
      .then((r) => (r.ok ? r.json() : null))
      .then((info: { downloads?: { tvApk?: boolean; pcExe?: boolean } } | null) => {
        if (info?.downloads) {
          setDownloads({ tvApk: Boolean(info.downloads.tvApk), pcExe: Boolean(info.downloads.pcExe) });
        }
      })
      .catch(() => {});
  }, []);

  const [otaStatus, setOtaStatus] = useState<AutoUpdateStatus>({
    githubRepo: 'youseffakhouri/uv-link',
    channel: 'stable',
    autoCheckEnabled: true,
    currentVersion: '2.4.0',
    latestVersion: '2.5.0',
    updateAvailable: true,
    lastChecked: 'Just now',
    releaseNotes: 'v2.5.0: Hardware ABR 60fps lock, 10ms Stereo AAudio lip-sync, and native Phone Mirroring tab discovery.',
    assets: {
      tvApk: 'UvLink-TV-Receiver-v2.5.0.apk',
      pcExe: 'UvLink-PC-Sender-Setup-2.5.0.exe'
    }
  });
  const [repoInput, setRepoInput] = useState<string>('youseffakhouri/uv-link');
  const [isCheckingOta, setIsCheckingOta] = useState<boolean>(false);
  const [isApplyingOta, setIsApplyingOta] = useState<boolean>(false);
  const [repoError, setRepoError] = useState<string>('');

  useEffect(() => {
    fetch('/api/autoupdate/status')
      .then((r) => r.json())
      .then((data: AutoUpdateStatus) => {
        if (data && data.currentVersion) {
          setOtaStatus(data);
          setRepoInput(data.githubRepo);
        }
      })
      .catch(() => {});
  }, []);

  const copyTvUrl = () => {
    if (!tvUrl) return;
    navigator.clipboard
      ?.writeText(tvUrl)
      .then(() => {
        setTvUrlCopied(true);
        setTimeout(() => setTvUrlCopied(false), 1800);
      })
      .catch(() => {});
  };

  const handleCheckGitHubUpdates = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = repoInput.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, '');
    if (!cleaned || !cleaned.includes('/')) {
      setRepoError('Enter a valid GitHub repo (e.g. username/uv-link)');
      return;
    }
    setRepoError('');
    setIsCheckingOta(true);
    try {
      const res = await fetch('/api/autoupdate/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ githubRepo: cleaned })
      });
      if (res.ok) {
        const data = await res.json();
        setOtaStatus(data);
      }
    } catch {
      // Ignore offline error
    } finally {
      setIsCheckingOta(false);
    }
  };

  const handleApplyOtaUpdate = async () => {
    setIsApplyingOta(true);
    try {
      const res = await fetch('/api/autoupdate/apply', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setOtaStatus(data);
      }
    } catch {
      // Ignore error
    } finally {
      setIsApplyingOta(false);
    }
  };

  return (
    <section
      aria-label="Download TV APK, PC EXE, Native Phone Mirroring, and GitHub Auto-Updater"
      className="space-y-4"
    >
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Card 1: Android TV Receiver (.APK + Instant TV Mode) */}
        <div className="border border-slate-800/90 bg-slate-900/50 rounded-lg p-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between gap-2 mb-2">
              <h2 className="text-sm font-semibold text-white flex items-center gap-2 whitespace-nowrap">
                <Tv className="w-4 h-4 text-emerald-400 shrink-0" />
                1. Open on your TV
              </h2>
              <span className="text-xs font-mono text-emerald-400 whitespace-nowrap" data-testid="receiver-count">
                {receiverCount} online
              </span>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed mb-2">
              Android TV: install the TV app (with the free <strong className="text-slate-200">Downloader</strong> app, open{' '}
              <code className="text-slate-200">{baseUrl ? `${baseUrl}/tv.apk` : '…/tv.apk'}</code>). Any other TV or device: open in its browser:
            </p>
            {tvUrl ? (
              <div className="flex items-center gap-2 mb-4">
                <code className="flex-1 min-w-0 truncate text-xs text-sky-300 bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5" title={tvUrl}>
                  {tvUrl}
                </code>
                <button
                  type="button"
                  onClick={copyTvUrl}
                  aria-label="Copy TV link"
                  className="p-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 shrink-0"
                >
                  {tvUrlCopied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
              </div>
            ) : (
              <p className="text-xs text-amber-300 mb-4">
                Waiting for the server&apos;s network address… (this PC must be on Wi-Fi or Ethernet)
              </p>
            )}
          </div>

          <div className="flex items-center gap-2 pt-3 border-t border-slate-800/80">
            <button
              type="button"
              onClick={onEnterTvMode}
              className="flex-1 px-3 py-2 text-xs font-semibold bg-emerald-500 hover:bg-emerald-400 text-slate-950 rounded-md flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
            >
              <Maximize2 className="w-3.5 h-3.5" />
              Use This Screen as TV
            </button>
            <a
              href={downloads.tvApk ? '/tv.apk' : undefined}
              download={downloads.tvApk ? 'UvLink-TV.apk' : undefined}
              aria-disabled={!downloads.tvApk}
              title={downloads.tvApk ? 'Android TV app' : 'Not built yet: run "npm run release" on the PC'}
              data-testid="tv-apk-download"
              className={`px-3 py-2 text-xs font-medium rounded-md flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
                downloads.tvApk
                  ? 'bg-slate-800 hover:bg-slate-700 text-slate-100'
                  : 'bg-slate-900 text-slate-500 cursor-not-allowed'
              }`}
            >
              <Download className="w-3.5 h-3.5" />
              TV App (.apk)
            </a>
          </div>
        </div>

        {/* Card 2: Windows PC Sender (.EXE / Native Desktop Launcher) */}
        <div className="border border-slate-800/90 bg-slate-900/50 rounded-lg p-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between gap-2 mb-2">
              <h2 className="text-sm font-semibold text-white flex items-center gap-2 whitespace-nowrap">
                <Laptop className="w-4 h-4 text-sky-400 shrink-0" />
                2. PC Sender (.EXE)
              </h2>
              <span className="text-xs font-mono text-sky-400 whitespace-nowrap">
                v{otaStatus.currentVersion} · NVENC
              </span>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed mb-4">
              Install the Uv Link PC app: it runs everything (no Node.js needed) and shares your screen with system sound. Or open <code className="text-slate-200">http://localhost:3000</code> in Chrome or Edge.
            </p>
          </div>

          <div className="flex items-center gap-2 pt-3 border-t border-slate-800/80">
            {isPcApp ? (
              <span className="flex-1 px-3 py-2 text-xs font-medium text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-md text-center">
                You&apos;re using the PC app
              </span>
            ) : (
              <a
                href={downloads.pcExe ? '/pc-setup.exe' : undefined}
                download={downloads.pcExe ? 'UvLink-PC-Setup.exe' : undefined}
                aria-disabled={!downloads.pcExe}
                title={downloads.pcExe ? 'Windows installer' : 'Not built yet: run "npm run release" on the PC'}
                data-testid="pc-exe-download"
                className={`flex-1 px-3 py-2 text-xs font-semibold rounded-md flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
                  downloads.pcExe
                    ? 'bg-sky-400 hover:bg-sky-300 text-slate-950'
                    : 'bg-slate-900 text-slate-500 cursor-not-allowed'
                }`}
              >
                <Download className="w-3.5 h-3.5" />
                PC App (.exe)
              </a>
            )}
            <a
              href="/api/download/pc-exe-launcher"
              download="UvLink-PC-Sender-Launcher.bat"
              title="Opens this page as an app window in Edge or Chrome"
              className="px-3 py-2 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-100 rounded-md flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
            >
              <Download className="w-3.5 h-3.5" />
              Launcher (.bat)
            </a>
          </div>
        </div>

        {/* Card 3: Phone Native Screen Mirroring Tab (iOS AirPlay + Android Cast / Smart View) */}
        <div className="border border-slate-800/90 bg-slate-900/50 rounded-lg p-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between gap-2 mb-2">
              <h2 className="text-sm font-semibold text-white flex items-center gap-2 whitespace-nowrap">
                <Smartphone className="w-4 h-4 text-indigo-400 shrink-0" />
                3. Phones &amp; Tablets
              </h2>
              <span className="text-xs font-mono text-slate-400 whitespace-nowrap">Receive only</span>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed mb-4">
              Any phone or tablet can <strong className="text-slate-200">watch</strong>: open the TV link in its browser. Phones can&apos;t <strong className="text-slate-200">send</strong> their screen from a web page. iOS and Android block screen capture in mobile browsers, and AirPlay / Google Cast only work with licensed receivers.
            </p>
          </div>

          <div className="flex items-center justify-between gap-2 pt-3 border-t border-slate-800/80">
            <div className="text-xs font-mono text-slate-400 whitespace-nowrap">
              Same link as the TV
            </div>
            <button
              type="button"
              onClick={copyTvUrl}
              disabled={!tvUrl}
              className="px-3 py-2 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-100 rounded-md flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
            >
              {tvUrlCopied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5 text-sky-400" />}
              {tvUrlCopied ? 'Copied' : 'Copy Link'}
            </button>
          </div>
        </div>
      </div>

      {/* GitHub Releases Over-The-Air (OTA) Auto-Updater Bar */}
      <div
        data-testid="github-autoupdater-bar"
        className="border border-slate-800/90 bg-slate-900/40 rounded-lg px-5 py-3.5 flex flex-col lg:flex-row lg:items-center justify-between gap-4"
      >
        <div className="flex flex-wrap items-center gap-3 min-w-0">
          <span className="text-xs font-semibold text-white whitespace-nowrap flex items-center gap-1.5">
            <ArrowUpCircle className="w-4 h-4 text-sky-400 shrink-0" />
            GitHub Releases OTA Auto-Updater
          </span>
          <span className="text-slate-600" aria-hidden="true">·</span>
          <span className="text-xs font-mono text-slate-300 tabular-nums whitespace-nowrap">
            Installed: <strong className="text-white">v{otaStatus.currentVersion}</strong>
          </span>
          <span className="text-slate-600" aria-hidden="true">·</span>
          <span
            data-testid="ota-update-status"
            className={`text-xs font-mono tabular-nums whitespace-nowrap ${
              otaStatus.updateAvailable ? 'text-amber-400 font-semibold' : 'text-emerald-400'
            }`}
          >
            {otaStatus.updateAvailable
              ? `Update Available: v${otaStatus.latestVersion}`
              : `Up to Date (v${otaStatus.currentVersion})`}
          </span>
          {repoError && (
            <span className="text-xs text-rose-400 font-medium" role="alert">
              {repoError}
            </span>
          )}
        </div>

        <form onSubmit={handleCheckGitHubUpdates} className="flex flex-wrap sm:flex-nowrap items-center gap-2 shrink-0">
          <label htmlFor="github-repo-input" className="sr-only">
            GitHub Repository (owner/repo)
          </label>
          <input
            id="github-repo-input"
            type="text"
            value={repoInput}
            onChange={(e) => setRepoInput(e.target.value)}
            placeholder="owner/uv-link"
            className="bg-slate-950 border border-slate-800 rounded-md px-3 py-1.5 text-xs font-mono text-slate-200 w-48 focus:outline-none focus:border-sky-500"
          />
          <button
            type="submit"
            disabled={isCheckingOta}
            className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-md flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isCheckingOta ? 'animate-spin text-sky-400' : ''}`} />
            Check GitHub
          </button>
          {otaStatus.updateAvailable && (
            <button
              type="button"
              onClick={handleApplyOtaUpdate}
              disabled={isApplyingOta}
              className="px-3.5 py-1.5 text-xs font-semibold bg-sky-400 hover:bg-sky-300 text-slate-950 rounded-md flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
            >
              <ArrowUpCircle className="w-3.5 h-3.5" />
              {isApplyingOta ? 'Updating...' : `Auto-Update to v${otaStatus.latestVersion}`}
            </button>
          )}
        </form>
      </div>
    </section>
  );
};
