import React from 'react';
import { Wifi, Activity, Gauge, Cpu, Volume2 } from 'lucide-react';
import { QUALITY_PRESETS, type CastSettings } from '../utils/castSettings';
import type { LiveStreamStats } from './LiveMirroringWorkbench';

type Grade = 'Excellent' | 'Good' | 'Fair' | 'Poor';

interface NetworkQualityBannerProps {
  settings: CastSettings;
  /** Measurements from the running cast; null when not casting. */
  liveStats: LiveStreamStats | null;
  isStreaming: boolean;
}

/** Grade the link from measured round-trip time and packet loss. */
function gradeLink(rttMs: number | null, lossPercent: number | null): { grade: Grade; bars: 1 | 2 | 3 | 4 } {
  const rtt = rttMs ?? 0;
  const loss = lossPercent ?? 0;
  if (loss >= 5 || rtt >= 80) return { grade: 'Poor', bars: 1 };
  if (loss >= 2 || rtt >= 30) return { grade: 'Fair', bars: 2 };
  if (loss >= 0.5 || rtt >= 10) return { grade: 'Good', bars: 3 };
  return { grade: 'Excellent', bars: 4 };
}

const GRADE_TEXT: Record<Grade, string> = {
  Excellent: 'text-emerald-400',
  Good: 'text-sky-400',
  Fair: 'text-amber-400',
  Poor: 'text-rose-400'
};
const GRADE_BAR: Record<Grade, string> = {
  Excellent: 'bg-emerald-400',
  Good: 'bg-sky-400',
  Fair: 'bg-amber-400',
  Poor: 'bg-rose-500'
};

/** Live numbers from the running cast (getStats on the PC and the TV). Nothing here is estimated ahead of time. */
export const NetworkQualityBanner: React.FC<NetworkQualityBannerProps> = ({ settings, liveStats, isStreaming }) => {
  const live = isStreaming && liveStats !== null ? liveStats : null;
  const sender = live?.sender ?? null;
  const link = sender ? gradeLink(sender.rttMs, sender.packetLossPercent) : null;
  const cap = QUALITY_PRESETS[settings.quality];
  const dash = <span className="text-slate-500">—</span>;

  const summary = !live
    ? 'Start a cast to see live measurements.'
    : sender?.qualityLimitation && sender.qualityLimitation !== 'none'
      ? `Encoder limited by ${sender.qualityLimitation}`
      : 'Measured on the running cast';

  return (
    <section
      aria-label="Live connection measurements"
      data-testid="network-quality-banner"
      className="border border-slate-800/90 bg-slate-900/50 rounded-lg p-5"
    >
      <div className="flex flex-wrap items-center gap-3 pb-4 border-b border-slate-800/80">
        <h2 className="text-sm font-semibold text-white whitespace-nowrap">Connection</h2>
        <span
          data-testid="stats-source-badge"
          className={`text-xs font-mono px-1.5 py-0.5 rounded whitespace-nowrap ${
            live ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-800 text-slate-400'
          }`}
        >
          {live ? 'LIVE' : 'IDLE'}
        </span>
        <span className="text-xs text-slate-400 truncate">{summary}</span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-6 pt-4">
        <div className="flex items-center justify-between pr-2">
          <div>
            <div className="text-xs text-slate-400 flex items-center gap-1.5 mb-1 whitespace-nowrap">
              <Wifi className="w-3.5 h-3.5 text-sky-400" />
              Link
            </div>
            <div data-testid="network-quality-grade" className={`text-base font-mono font-semibold ${link ? GRADE_TEXT[link.grade] : ''}`}>
              {link ? link.grade : dash}
            </div>
            <div className="text-xs font-mono text-slate-400 tabular-nums whitespace-nowrap">
              {sender ? `loss ${sender.packetLossPercent ?? '—'}%` : 'loss —'}
            </div>
          </div>
          {link && (
            <div className="flex items-end gap-1 h-6 shrink-0" aria-label={`Link quality ${link.bars} out of 4 bars`}>
              {[1, 2, 3, 4].map((bar) => (
                <div
                  key={bar}
                  style={{ height: `${bar * 5}px` }}
                  className={`w-1.5 rounded-xs ${bar <= link.bars ? GRADE_BAR[link.grade] : 'bg-slate-800'}`}
                />
              ))}
            </div>
          )}
        </div>

        <div>
          <div className="text-xs text-slate-400 flex items-center gap-1.5 mb-1 whitespace-nowrap">
            <Gauge className="w-3.5 h-3.5 text-sky-400" />
            Video bitrate
          </div>
          <div className="text-base font-mono font-semibold text-white tabular-nums whitespace-nowrap" data-testid="abr-target-bitrate">
            {sender ? `${sender.bitrateMbps ?? '—'} Mbps` : dash}{' '}
            <span className="text-xs font-normal text-slate-400">/ {cap.maxBitrateKbps / 1000}M cap</span>
          </div>
          <div className="text-xs font-mono text-slate-400 tabular-nums whitespace-nowrap">
            {sender?.availableOutgoingMbps != null ? `link est. ${sender.availableOutgoingMbps} Mbps` : 'sent / quality cap'}
          </div>
        </div>

        <div>
          <div className="text-xs text-slate-400 flex items-center gap-1.5 mb-1 whitespace-nowrap">
            <Activity className="w-3.5 h-3.5 text-sky-400" />
            Est. delay (measured parts)
          </div>
          <div className="text-base font-mono font-semibold tabular-nums whitespace-nowrap" data-testid="total-latency-ms">
            {live ? (
              <span className={live.estimatedDelayMs !== null && live.estimatedDelayMs < 40 ? 'text-emerald-400' : 'text-amber-400'}>
                {live.estimatedDelayMs !== null ? `≈ ${live.estimatedDelayMs} ms` : 'measuring…'}
              </span>
            ) : (
              dash
            )}
          </div>
          <div className="text-xs font-mono text-slate-400 tabular-nums whitespace-nowrap">
            RTT {sender?.rttMs ?? '—'} ms
          </div>
        </div>

        <div>
          <div className="text-xs text-slate-400 flex items-center gap-1.5 mb-1 whitespace-nowrap">
            <Cpu className="w-3.5 h-3.5 text-sky-400" />
            Sending
          </div>
          <div className="text-base font-mono font-semibold text-white tabular-nums whitespace-nowrap" data-testid="abr-effective-resolution">
            {sender?.width ? `${sender.width}x${sender.height} @ ${sender.fps ?? '—'}fps` : dash}
          </div>
          <div className="text-xs font-mono text-slate-400 whitespace-nowrap truncate">
            {live?.tv?.fps != null ? `TV shows ${live.tv.fps}fps` : `up to ${settings.targetFps} fps`}
          </div>
        </div>

        <div>
          <div className="text-xs text-slate-400 flex items-center gap-1.5 mb-1 whitespace-nowrap">
            <Volume2 className="w-3.5 h-3.5 text-sky-400" />
            Audio
          </div>
          <div className="text-base font-mono font-semibold text-white whitespace-nowrap" data-testid="audio-sync-status">
            {settings.audio.enabled ? 'Opus stereo' : <span className="text-slate-400">Muted</span>}
          </div>
          <div className="text-xs font-mono text-slate-400 whitespace-nowrap">
            {settings.audio.enabled ? (settings.audio.lipSyncLock ? 'lip sync on' : 'low delay') : 'no sound sent'}
          </div>
        </div>
      </div>
    </section>
  );
};
