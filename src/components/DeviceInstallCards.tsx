import React, { useState, useEffect } from 'react';
import { Tv, Laptop, Smartphone, Download, Maximize2, Copy, Check } from 'lucide-react';
import { UpdateBar } from './UpdateBar';

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

  return (
    <section aria-label="Get Uv Link on your TV, PC and phones" className="space-y-4">
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
              <span className="text-xs font-mono text-sky-400 whitespace-nowrap">Windows 10/11</span>
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
              <span className="text-xs font-mono text-slate-400 whitespace-nowrap">iPhone: AirPlay</span>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed mb-4">
              <strong className="text-slate-200">iPhone / iPad:</strong> with the Uv Link app open on an Android TV, use Control Center → Screen Mirroring → Uv Link. <strong className="text-slate-200">Android phones:</strong> use the TV&apos;s built-in Cast. Any phone or tablet can also <strong className="text-slate-200">watch</strong> this PC: open the TV link in its browser.
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

      {/* Real updates from GitHub Releases (PC app only) */}
      <UpdateBar />
    </section>
  );
};
