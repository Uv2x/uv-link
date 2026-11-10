import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ArrowUpCircle, Check, Loader2, RefreshCw } from 'lucide-react';
import type { UpdateStatus } from '../shared/updates';

/**
 * Shows the PC app's real update status (GitHub Releases, see server/pcUpdater.ts). Updates
 * download by themselves; this bar reports progress and offers "Restart to update".
 */
export const UpdateBar: React.FC = () => {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const load = useCallback(() => {
    fetch('/api/update')
      .then((r) => (r.ok ? r.json() : null))
      .then((next: UpdateStatus | null) => {
        if (next?.state) setStatus(next);
      })
      .catch(() => {});
  }, []);

  useEffect(load, [load]);

  // Poll quickly while checking or downloading, slowly otherwise.
  const active = status?.state === 'checking' || status?.state === 'downloading';
  useEffect(() => {
    const timer = setInterval(load, active ? 1000 : 30_000);
    return () => clearInterval(timer);
  }, [active, load]);

  const post = async (path: string): Promise<boolean> => {
    setBusy(true);
    try {
      const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const next = (await res.json()) as UpdateStatus;
      if (next?.state) setStatus(next);
      return res.ok;
    } catch {
      return false;
    } finally {
      setBusy(false);
    }
  };

  const install = async () => {
    if (await post('/api/update/install')) setRestarting(true);
  };

  if (!status) return null;

  const { state, currentVersion, latestVersion, progress, error, releaseUrl, checkedAt, canControl } = status;
  const checkedTime = checkedAt
    ? new Date(checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;

  let icon = <ArrowUpCircle className="w-4 h-4 text-sky-400 shrink-0" />;
  let message: React.ReactNode;
  let tone = 'text-slate-300';

  if (restarting) {
    icon = <Loader2 className="w-4 h-4 text-sky-400 shrink-0 animate-spin" />;
    message = `Installing v${latestVersion}… Uv Link restarts in a moment.`;
    tone = 'text-sky-300';
  } else if (state === 'disabled') {
    message = 'Automatic updates come with the installed PC app.';
    tone = 'text-slate-400';
  } else if (state === 'checking') {
    icon = <Loader2 className="w-4 h-4 text-sky-400 shrink-0 animate-spin" />;
    message = 'Checking GitHub for updates…';
  } else if (state === 'downloading') {
    icon = <Loader2 className="w-4 h-4 text-sky-400 shrink-0 animate-spin" />;
    message = `Downloading v${latestVersion}… ${progress != null ? Math.round(progress * 100) : 0}%`;
    tone = 'text-sky-300';
  } else if (state === 'ready') {
    message = `v${latestVersion} is ready. It installs when you restart or close Uv Link.`;
    tone = 'text-amber-300 font-semibold';
  } else if (state === 'error') {
    icon = <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />;
    message = `Couldn't update: ${error}`;
    tone = 'text-rose-300';
  } else if (state === 'up-to-date') {
    icon = <Check className="w-4 h-4 text-emerald-400 shrink-0" />;
    message = `Up to date${checkedTime ? ` (checked ${checkedTime})` : ''}`;
    tone = 'text-emerald-300';
  } else {
    message = 'Checks GitHub for updates automatically.';
  }

  return (
    <div
      data-testid="update-bar"
      className="border border-slate-800/90 bg-slate-900/40 rounded-lg px-5 py-3.5 flex flex-col lg:flex-row lg:items-center justify-between gap-3"
    >
      <div className="flex flex-wrap items-center gap-3 min-w-0">
        <span className="text-xs font-semibold text-white whitespace-nowrap flex items-center gap-1.5">
          {icon}
          Uv Link v{currentVersion}
        </span>
        <span className="text-slate-600" aria-hidden="true">
          ·
        </span>
        <span data-testid="update-status" role="status" className={`text-xs ${tone}`}>
          {message}
        </span>
        {releaseUrl && latestVersion && (state === 'downloading' || state === 'ready') && (
          <a href={releaseUrl} target="_blank" rel="noreferrer" className="text-xs text-sky-400 hover:text-sky-300 underline">
            What&apos;s new in v{latestVersion}
          </a>
        )}
      </div>

      {canControl && !restarting && (
        <div className="flex items-center gap-2 shrink-0">
          {state === 'ready' ? (
            <button
              type="button"
              onClick={install}
              disabled={busy}
              data-testid="update-install"
              className="px-3.5 py-1.5 text-xs font-semibold bg-sky-400 hover:bg-sky-300 text-slate-950 rounded-md flex items-center gap-1.5 transition-colors whitespace-nowrap disabled:opacity-60"
            >
              <ArrowUpCircle className="w-3.5 h-3.5" />
              Restart to update
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void post('/api/update/check')}
              disabled={busy || active}
              data-testid="update-check"
              className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-md flex items-center gap-1.5 transition-colors whitespace-nowrap disabled:opacity-60"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${busy || active ? 'animate-spin text-sky-400' : ''}`} />
              {state === 'error' ? 'Try again' : 'Check now'}
            </button>
          )}
        </div>
      )}
    </div>
  );
};
