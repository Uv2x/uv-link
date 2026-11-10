import React, { useState } from 'react';
import {
  Copy,
  Check,
  Search
} from 'lucide-react';
import {
  ZeroLatencyParameters,
  LatencyBudgetBreakdown,
  mungeZeroLatencySdp
} from '../utils/webrtcConfig';
import {
  ARCHITECTURE_STACK_MATRIX,
  CODE_ARTIFACTS
} from '../data/blueprintCode';
import type { PacketLogItem } from '../shared/protocol';

interface StepBlueprintExplorerProps {
  activeStep: 1 | 2 | 3 | 4 | 5;
  onSelectStep: (step: 1 | 2 | 3 | 4 | 5) => void;
  params: ZeroLatencyParameters;
  budget: LatencyBudgetBreakdown;
  onUpdateParams: (updater: (prev: ZeroLatencyParameters) => ZeroLatencyParameters) => void;
  packetLogs: PacketLogItem[];
}

export const StepBlueprintExplorer: React.FC<StepBlueprintExplorerProps> = ({
  activeStep,
  onSelectStep,
  params,
  budget,
  onUpdateParams,
  packetLogs
}) => {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [packetFilter, setPacketFilter] = useState<string>('');

  const handleCopyCode = (id: string, text: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1800);
  };

  const sampleRawSdp = [
    'v=0',
    'o=- 8491029384710293 2 IN IP4 192.168.1.10',
    's=UvLink-ZeroLatency-Session',
    't=0 0',
    'a=group:BUNDLE 0 1',
    'm=video 9 UDP/TLS/RTP/SAVPF 96',
    'c=IN IP4 0.0.0.0',
    'a=mid:0',
    'a=sendonly',
    `a=rtpmap:96 ${params.codec === 'H264_42e01f' ? 'H264/90000' : 'H265/90000'}`,
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'c=IN IP4 0.0.0.0',
    'a=mid:1',
    'a=sendonly',
    'a=rtpmap:111 opus/48000/2'
  ].join('\r\n');

  const liveMungedSdp = mungeZeroLatencySdp(sampleRawSdp, params);

  const stepTabs: Array<{
    step: 1 | 2 | 3 | 4 | 5;
    label: string;
  }> = [
    { step: 1, label: '01. Architecture & Stack' },
    { step: 2, label: '02. Zero-Latency & ABR' },
    { step: 3, label: '03. mDNS Signaling' },
    { step: 4, label: '04. Android TV App' },
    { step: 5, label: '05. Sender Code' }
  ];

  const stepCodeArtifacts = CODE_ARTIFACTS.filter((a) => a.stepNumber === activeStep);

  const filteredPackets = packetLogs.filter(
    (pkt) =>
      !packetFilter.trim() ||
      pkt.type.toLowerCase().includes(packetFilter.toLowerCase()) ||
      pkt.summary.toLowerCase().includes(packetFilter.toLowerCase()) ||
      pkt.direction.toLowerCase().includes(packetFilter.toLowerCase())
  );

  return (
    <section
      aria-label="System Architecture and Production Code"
      className="border border-slate-800/90 bg-slate-900/50 rounded-lg p-6"
    >
      {/* Clean Header & Segmented Tabs */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-5 mb-6 border-b border-slate-800/80">
        <div>
          <h2 className="text-base font-semibold text-white">
            System Architecture &amp; Implementation Code
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Select a module to inspect the architecture, configure WebRTC parameters, or copy production code.
          </p>
        </div>

        <div
          role="tablist"
          aria-label="Architecture Steps"
          className="flex flex-wrap items-center gap-1 p-1 bg-slate-950 border border-slate-800/90 rounded-lg"
        >
          {stepTabs.map((t) => (
            <button
              key={t.step}
              role="tab"
              aria-selected={activeStep === t.step}
              type="button"
              onClick={() => onSelectStep(t.step)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                activeStep === t.step
                  ? 'bg-sky-400 text-slate-950 font-semibold'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* STEP 1: ARCHITECTURE & LATENCY BUDGET */}
      {activeStep === 1 && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {[
              { stage: '1. Capture', ms: budget.captureMs, tech: 'DXGI / MediaProjection' },
              { stage: '2. HW Encode', ms: budget.encodeMs, tech: 'NVENC P1 (0 B-frames)' },
              { stage: '3. LAN UDP', ms: budget.networkRttHalfMs, tech: params.networkMode.split(' ')[0] },
              { stage: '4. Playout', ms: budget.jitterBufferMs, tech: params.zeroPlayoutDelay ? '0ms Bypass' : 'Standard Buffer' },
              { stage: '5. HW Decode', ms: budget.decodeMs, tech: 'MediaCodec Low-Latency' },
              { stage: '6. TV Scanout', ms: budget.renderVsyncMs, tech: 'SurfaceView HWC2' }
            ].map((item) => (
              <div
                key={item.stage}
                className="border border-slate-800/80 bg-slate-950/70 rounded-md p-3.5"
              >
                <div className="text-xs text-slate-400">{item.stage}</div>
                <div className="text-base font-mono font-semibold text-sky-400 mt-1 tabular-nums">
                  {item.ms} ms
                </div>
                <div className="text-xs text-slate-400 mt-0.5 truncate">{item.tech}</div>
              </div>
            ))}
          </div>

          <div className="border border-slate-800/80 rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-800 bg-slate-950/80 text-slate-400">
                    <th className="py-3 px-4 font-medium">System Layer</th>
                    <th className="py-3 px-4 font-medium">Recommended Stack</th>
                    <th className="py-3 px-4 font-medium">Why Selected</th>
                    <th className="py-3 px-4 font-medium text-right">Budget</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {ARCHITECTURE_STACK_MATRIX.map((row) => (
                    <tr key={row.layer} className="hover:bg-slate-800/20">
                      <td className="py-3.5 px-4 font-medium text-white whitespace-nowrap">
                        {row.layer}
                      </td>
                      <td className="py-3.5 px-4 font-mono text-sky-300">
                        {row.recommendedStack}
                      </td>
                      <td className="py-3.5 px-4 text-slate-300 leading-relaxed">
                        {row.whySelected}
                      </td>
                      <td className="py-3.5 px-4 font-mono text-emerald-400 text-right whitespace-nowrap tabular-nums">
                        {row.latencyContribution}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* STEP 2: ZERO-LATENCY & ABR CONFIGURATOR */}
      {activeStep === 2 && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-6 border border-slate-800/80 bg-slate-950/70 rounded-lg p-5 space-y-4">
            <h3 className="text-sm font-semibold text-white pb-2 border-b border-slate-800">
              Codec, Adaptive Bitrate &amp; Audio Parameters
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="codec-select" className="block text-xs text-slate-300 mb-1">
                  Video Codec Profile
                </label>
                <select
                  id="codec-select"
                  value={params.codec}
                  onChange={(e) =>
                    onUpdateParams((prev) => ({
                      ...prev,
                      codec: e.target.value as ZeroLatencyParameters['codec']
                    }))
                  }
                  className="w-full bg-slate-900 border border-slate-800 rounded px-3 py-2 text-xs font-mono text-slate-100"
                >
                  <option value="H264_42e01f">H.264 Baseline (42e01f)</option>
                  <option value="HEVC_Main10">HEVC Main10 (Low-Delay)</option>
                </select>
              </div>

              <div>
                <label htmlFor="degradation-select" className="block text-xs text-slate-300 mb-1">
                  Degradation Policy
                </label>
                <select
                  id="degradation-select"
                  value={params.degradationPreference}
                  onChange={(e) =>
                    onUpdateParams((prev) => ({
                      ...prev,
                      degradationPreference: e.target.value as ZeroLatencyParameters['degradationPreference']
                    }))
                  }
                  className="w-full bg-slate-900 border border-slate-800 rounded px-3 py-2 text-xs font-mono text-slate-100"
                >
                  <option value="maintain-framerate">maintain-framerate (60fps+)</option>
                  <option value="balanced">balanced</option>
                  <option value="maintain-resolution">maintain-resolution</option>
                </select>
              </div>

              <div>
                <label htmlFor="bandwidth-slider" className="block text-xs text-slate-300 mb-1">
                  Available Bandwidth: <span className="font-mono text-sky-400">{params.estimatedBandwidthMbps} Mbps</span>
                </label>
                <input
                  id="bandwidth-slider"
                  type="range"
                  min={4}
                  max={100}
                  step={1}
                  value={params.estimatedBandwidthMbps}
                  onChange={(e) =>
                    onUpdateParams((prev) => ({
                      ...prev,
                      estimatedBandwidthMbps: Number(e.target.value)
                    }))
                  }
                  className="w-full accent-sky-400"
                />
              </div>

              <div>
                <label htmlFor="loss-slider" className="block text-xs text-slate-300 mb-1">
                  Packet Loss: <span className="font-mono text-amber-400">{params.packetLossPercent}%</span>
                </label>
                <input
                  id="loss-slider"
                  type="range"
                  min={0}
                  max={10}
                  step={0.5}
                  value={params.packetLossPercent}
                  onChange={(e) =>
                    onUpdateParams((prev) => ({
                      ...prev,
                      packetLossPercent: Number(e.target.value)
                    }))
                  }
                  className="w-full accent-sky-400"
                />
              </div>
            </div>

            <div className="space-y-2.5 pt-2 border-t border-slate-800 text-xs">
              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-slate-200">Bypass Jitter Buffer (playout-delay: 0 0)</span>
                <input
                  type="checkbox"
                  checked={params.zeroPlayoutDelay}
                  onChange={(e) =>
                    onUpdateParams((prev) => ({ ...prev, zeroPlayoutDelay: e.target.checked }))
                  }
                  className="accent-sky-400 w-4 h-4"
                />
              </label>

              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-slate-200">Disable B-Frames (bframes=0)</span>
                <input
                  type="checkbox"
                  checked={params.disableBFrames}
                  onChange={(e) =>
                    onUpdateParams((prev) => ({ ...prev, disableBFrames: e.target.checked }))
                  }
                  className="accent-sky-400 w-4 h-4"
                />
              </label>

              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-slate-200">Force Hardware Acceleration (NVENC / MediaCodec)</span>
                <input
                  type="checkbox"
                  checked={params.forceHardwareEncoder}
                  onChange={(e) =>
                    onUpdateParams((prev) => ({ ...prev, forceHardwareEncoder: e.target.checked }))
                  }
                  className="accent-sky-400 w-4 h-4"
                />
              </label>

              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-slate-200">48kHz Stereo Audio (10ms Opus + AAudio)</span>
                <input
                  type="checkbox"
                  checked={params.audio.enabled}
                  onChange={(e) =>
                    onUpdateParams((prev) => ({
                      ...prev,
                      audio: { ...prev.audio, enabled: e.target.checked }
                    }))
                  }
                  className="accent-sky-400 w-4 h-4"
                />
              </label>
            </div>
          </div>

          <div className="lg:col-span-6 border border-slate-800/80 bg-slate-950 rounded-lg p-5 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between pb-2 mb-3 border-b border-slate-800">
                <h3 className="text-sm font-semibold text-white">
                  Generated Zero-Latency SDP Offer
                </h3>
                <button
                  type="button"
                  onClick={() => handleCopyCode('live-sdp', liveMungedSdp)}
                  className="px-2.5 py-1 text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 rounded flex items-center gap-1 whitespace-nowrap shrink-0"
                >
                  {copiedId === 'live-sdp' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  {copiedId === 'live-sdp' ? 'Copied' : 'Copy SDP'}
                </button>
              </div>
              <pre
                data-testid="munged-sdp-preview"
                className="text-xs font-mono text-sky-300 bg-slate-900/80 p-3.5 rounded border border-slate-800 overflow-x-auto leading-relaxed"
              >
                {liveMungedSdp}
              </pre>
            </div>
          </div>
        </div>
      )}

      {/* STEP 3: SIGNALING & MDNS LOG */}
      {activeStep === 3 && (
        <div className="border border-slate-800/80 bg-slate-950 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-white">
              Local Signaling &amp; mDNS (_uvlink._tcp.local.) Packet Log
            </h3>
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2" />
              <input
                type="text"
                aria-label="Filter signaling and mDNS packets"
                placeholder="Filter packets..."
                value={packetFilter}
                onChange={(e) => setPacketFilter(e.target.value)}
                className="bg-slate-900 border border-slate-800 rounded pl-8 pr-3 py-1 text-xs text-slate-100"
              />
            </div>
          </div>

          <div className="max-h-56 overflow-y-auto">
            <table className="w-full text-left border-collapse text-xs font-mono">
              <thead>
                <tr className="border-b border-slate-800 bg-slate-900/60 text-slate-400">
                  <th className="py-2 px-4">Time</th>
                  <th className="py-2 px-4">Direction</th>
                  <th className="py-2 px-4">Type</th>
                  <th className="py-2 px-4">Summary</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {filteredPackets.map((pkt) => (
                  <tr key={pkt.id} className="hover:bg-slate-900/40">
                    <td className="py-2 px-4 text-slate-400 tabular-nums whitespace-nowrap">
                      {pkt.timestamp}
                    </td>
                    <td className="py-2 px-4 text-sky-400 whitespace-nowrap">
                      {pkt.direction}
                    </td>
                    <td className="py-2 px-4 text-emerald-400 font-semibold whitespace-nowrap">
                      {pkt.type}
                    </td>
                    <td className="py-2 px-4 text-slate-200">
                      {pkt.summary}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* CODE ARTIFACTS FOR STEPS 2, 3, 4, 5 */}
      {stepCodeArtifacts.length > 0 && (
        <div className="space-y-5 mt-6">
          {stepCodeArtifacts.map((artifact) => (
            <div
              key={artifact.id}
              className="border border-slate-800/80 bg-slate-950 rounded-lg overflow-hidden"
            >
              <div className="px-4 py-3 bg-slate-900/80 border-b border-slate-800 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-white">
                    {artifact.title}
                  </h3>
                  <span className="text-xs text-slate-500">·</span>
                  <code className="text-xs font-mono text-sky-400">
                    {artifact.filename}
                  </code>
                </div>

                <button
                  type="button"
                  onClick={() => handleCopyCode(artifact.id, artifact.code)}
                  className="px-3 py-1 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-100 rounded flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
                >
                  {copiedId === artifact.id ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      Copy Code
                    </>
                  )}
                </button>
              </div>
              <pre className="p-4 text-xs font-mono text-slate-200 overflow-x-auto leading-relaxed max-h-[460px]">
                <code>{artifact.code}</code>
              </pre>
            </div>
          ))}
        </div>
      )}
    </section>
  );
};
