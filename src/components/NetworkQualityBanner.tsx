import React from 'react';
import {
  Wifi,
  Activity,
  Gauge,
  Cpu,
  Volume2
} from 'lucide-react';
import {
  LatencyBudgetBreakdown,
  ZeroLatencyParameters
} from '../utils/webrtcConfig';
import type { LiveStreamStats } from './LiveMirroringWorkbench';

type Grade = 'Excellent' | 'Good' | 'Fair' | 'Degraded';

interface NetworkQualityBannerProps {
  params: ZeroLatencyParameters;
  budget: LatencyBudgetBreakdown;
  onUpdateParams: (updater: (prev: ZeroLatencyParameters) => ZeroLatencyParameters) => void;
  /** Measurements from the running cast; null when not casting. */
  liveStats: LiveStreamStats | null;
  isStreaming: boolean;
}

/** Grade the real link from measured RTT and packet loss. */
function gradeMeasuredLink(rttMs: number | null, lossPercent: number | null): { grade: Grade; bars: 1 | 2 | 3 | 4 } {
  const rtt = rttMs ?? 0;
  const loss = lossPercent ?? 0;
  if (loss >= 5 || rtt >= 80) return { grade: 'Degraded', bars: 1 };
  if (loss >= 2 || rtt >= 30) return { grade: 'Fair', bars: 2 };
  if (loss >= 0.5 || rtt >= 10) return { grade: 'Good', bars: 3 };
  return { grade: 'Excellent', bars: 4 };
}

export const NetworkQualityBanner: React.FC<NetworkQualityBannerProps> = ({
  params,
  budget,
  onUpdateParams,
  liveStats,
  isStreaming
}) => {
  const { networkQuality, abrDecision, avSync } = budget;
  const live = isStreaming && liveStats !== null ? liveStats : null;
  const sender = live?.sender ?? null;

  const measured = sender ? gradeMeasuredLink(sender.rttMs, sender.packetLossPercent) : null;
  const grade: Grade = measured?.grade ?? networkQuality.grade;
  const bars = measured?.bars ?? networkQuality.signalBars;

  const gradeColorMap = {
    Excellent: 'text-emerald-400',
    Good: 'text-sky-400',
    Fair: 'text-amber-400',
    Degraded: 'text-rose-400'
  };

  const barActiveColorMap = {
    Excellent: 'bg-emerald-400',
    Good: 'bg-sky-400',
    Fair: 'bg-amber-400',
    Degraded: 'bg-rose-500'
  };

  const applyNetworkPreset = (
    label: 'optimal' | 'ethernet' | 'moderate' | 'severe'
  ) => {
    if (label === 'optimal') {
      onUpdateParams((prev) => ({
        ...prev,
        networkMode: 'Wi-Fi 6 (5GHz/6GHz 160MHz)',
        estimatedBandwidthMbps: 42,
        packetLossPercent: 0
      }));
    } else if (label === 'ethernet') {
      onUpdateParams((prev) => ({
        ...prev,
        networkMode: 'Gigabit Ethernet LAN',
        estimatedBandwidthMbps: 95,
        packetLossPercent: 0
      }));
    } else if (label === 'moderate') {
      onUpdateParams((prev) => ({
        ...prev,
        networkMode: 'Wi-Fi 6 (5GHz/6GHz 160MHz)',
        estimatedBandwidthMbps: 14,
        packetLossPercent: 2.5
      }));
    } else {
      onUpdateParams((prev) => ({
        ...prev,
        networkMode: 'Congested 2.4GHz Wi-Fi',
        estimatedBandwidthMbps: 7,
        packetLossPercent: 6
      }));
    }
  };

  const statusSummary = live
    ? sender?.qualityLimitation && sender.qualityLimitation !== 'none'
      ? `Live: encoder limited by ${sender.qualityLimitation}`
      : 'Live measurements from the running cast'
    : networkQuality.statusSummary;

  return (
    <section
      aria-label="Network Quality and Adaptive Bitrate Status"
      data-testid="network-quality-banner"
      className="border border-slate-800/90 bg-slate-900/50 rounded-lg p-5"
    >
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 pb-4 border-b border-slate-800/80">
        <div className="flex items-center gap-3 min-w-0">
          <h2 className="text-sm font-semibold text-white whitespace-nowrap">
            Network Quality &amp; Adaptive Bitrate
          </h2>
          <span
            data-testid="stats-source-badge"
            className={`text-xs font-mono px-1.5 py-0.5 rounded whitespace-nowrap ${
              live ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-800 text-slate-400'
            }`}
          >
            {live ? 'LIVE' : 'PREDICTED'}
          </span>
          <span className="text-xs text-slate-400 truncate">{statusSummary}</span>
        </div>

        <div
          className="flex items-center gap-1 bg-slate-950 p-1 rounded-md border border-slate-800/90 shrink-0"
          title="Sets the quality cap the sender uses (bitrate and resolution scaling)"
        >
          <span className="text-xs text-slate-400 px-2 whitespace-nowrap">
            Network profile:
          </span>
          <button
            type="button"
            onClick={() => applyNetworkPreset('ethernet')}
            className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
              params.estimatedBandwidthMbps >= 80
                ? 'bg-sky-500 text-slate-950 font-semibold'
                : 'text-slate-300 hover:text-white'
            }`}
          >
            Gigabit (95M)
          </button>
          <button
            type="button"
            onClick={() => applyNetworkPreset('optimal')}
            className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
              params.estimatedBandwidthMbps >= 30 && params.estimatedBandwidthMbps < 80 && params.packetLossPercent === 0
                ? 'bg-sky-500 text-slate-950 font-semibold'
                : 'text-slate-300 hover:text-white'
            }`}
          >
            Wi-Fi 6 (42M)
          </button>
          <button
            type="button"
            onClick={() => applyNetworkPreset('moderate')}
            className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
              params.estimatedBandwidthMbps === 14
                ? 'bg-amber-400 text-slate-950 font-semibold'
                : 'text-slate-300 hover:text-white'
            }`}
          >
            Busy Wi-Fi (14M)
          </button>
          <button
            type="button"
            onClick={() => applyNetworkPreset('severe')}
            className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
              params.estimatedBandwidthMbps <= 10
                ? 'bg-rose-500 text-white font-semibold'
                : 'text-slate-300 hover:text-white'
            }`}
          >
            Weak 2.4GHz (7M)
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-6 pt-4">
        {/* 1. Link quality */}
        <div className="flex items-center justify-between pr-2">
          <div>
            <div className="text-xs text-slate-400 flex items-center gap-1.5 mb-1 whitespace-nowrap">
              <Wifi className="w-3.5 h-3.5 text-sky-400" />
              Link Quality
            </div>
            <div
              data-testid="network-quality-grade"
              className={`text-base font-mono font-semibold tabular-nums whitespace-nowrap ${gradeColorMap[grade]}`}
            >
              {grade}
            </div>
            <div className="text-xs font-mono text-slate-400 tabular-nums whitespace-nowrap">
              {sender
                ? `loss ${sender.packetLossPercent ?? '—'}%`
                : `${networkQuality.packetLossPercent}% loss assumed`}
            </div>
          </div>
          <div
            className="flex items-end gap-1 h-6 shrink-0"
            aria-label={`Link quality ${bars} out of 4 bars`}
          >
            {[1, 2, 3, 4].map((bar) => (
              <div
                key={bar}
                style={{ height: `${bar * 5}px` }}
                className={`w-1.5 rounded-xs transition-colors ${
                  bar <= bars ? barActiveColorMap[grade] : 'bg-slate-800'
                }`}
              />
            ))}
          </div>
        </div>

        {/* 2. Bitrate */}
        <div>
          <div className="text-xs text-slate-400 flex items-center gap-1.5 mb-1 whitespace-nowrap">
            <Gauge className="w-3.5 h-3.5 text-sky-400" />
            Video Bitrate
          </div>
          <div className="text-base font-mono font-semibold text-white tabular-nums whitespace-nowrap" data-testid="abr-target-bitrate">
            {sender ? `${sender.bitrateMbps ?? '—'} Mbps` : `${abrDecision.targetBitrateMbps} Mbps`}{' '}
            <span className="text-xs font-normal text-slate-400">/ {abrDecision.targetBitrateMbps}M cap</span>
          </div>
          <div className="text-xs font-mono text-slate-400 tabular-nums whitespace-nowrap">
            {sender?.availableOutgoingMbps != null ? `link est. ${sender.availableOutgoingMbps} Mbps` : 'sent / max allowed'}
          </div>
        </div>

        {/* 3. Delay */}
        <div>
          <div className="text-xs text-slate-400 flex items-center gap-1.5 mb-1 whitespace-nowrap">
            <Activity className="w-3.5 h-3.5 text-sky-400" />
            {live ? 'Est. Delay (measured parts)' : 'Predicted Delay'}
          </div>
          <div className="flex items-baseline gap-2 whitespace-nowrap">
            {live ? (
              <span
                data-testid="total-latency-ms"
                className={`text-base font-mono font-semibold tabular-nums ${
                  live.estimatedDelayMs !== null && live.estimatedDelayMs < 40 ? 'text-emerald-400' : 'text-amber-400'
                }`}
              >
                {live.estimatedDelayMs !== null ? `≈ ${live.estimatedDelayMs} ms` : 'measuring…'}
              </span>
            ) : (
              <span
                data-testid="total-latency-ms"
                className={`text-base font-mono font-semibold tabular-nums ${
                  budget.meetsSub20msTarget ? 'text-emerald-400' : 'text-amber-400'
                }`}
              >
                {budget.totalEndToEndMs} ms
              </span>
            )}
          </div>
          <div className="text-xs font-mono text-slate-400 tabular-nums whitespace-nowrap">
            RTT {sender ? (sender.rttMs ?? '—') : networkQuality.rttMs} ms
          </div>
        </div>

        {/* 4. Output resolution */}
        <div>
          <div className="text-xs text-slate-400 flex items-center gap-1.5 mb-1 whitespace-nowrap">
            <Cpu className="w-3.5 h-3.5 text-sky-400" />
            {live ? 'Sending' : 'Target Output'}
          </div>
          <div className="text-base font-mono font-semibold text-white tabular-nums whitespace-nowrap" data-testid="abr-effective-resolution">
            {sender?.width
              ? `${sender.width}x${sender.height} @ ${sender.fps ?? '—'}fps`
              : `${abrDecision.effectiveResolution} @ ${abrDecision.effectiveFps}fps`}
          </div>
          <div className="text-xs font-mono text-slate-400 whitespace-nowrap truncate">
            {live?.tv?.fps != null ? `TV shows ${live.tv.fps}fps` : abrDecision.abrTierLabel}
          </div>
        </div>

        {/* 5. Audio */}
        <div>
          <div className="text-xs text-slate-400 flex items-center gap-1.5 mb-1 whitespace-nowrap">
            <Volume2 className="w-3.5 h-3.5 text-sky-400" />
            Stereo Audio
          </div>
          <div className="text-base font-mono font-semibold text-white tabular-nums whitespace-nowrap" data-testid="audio-sync-status">
            {avSync.audioEnabled ? (
              <>
                48kHz Opus{' '}
                {!live && <span className="text-xs font-normal text-slate-400">(Δ {avSync.avSyncOffsetMs}ms predicted)</span>}
              </>
            ) : (
              <span className="text-slate-400">Muted</span>
            )}
          </div>
        </div>
      </div>
    </section>
  );
};
