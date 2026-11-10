import type { TvStatsReport } from '../shared/protocol';

/**
 * Turns RTCPeerConnection.getStats() reports into the numbers the UI shows.
 * Rates and per-frame times are computed from the difference between two
 * consecutive reports, so the first sample of a session has nulls for them.
 */

/** Anything with forEach over stats objects — a real RTCStatsReport or a Map in tests. */
export interface StatsReportLike {
  forEach(callback: (stat: any) => void): void;
}

type Stat = Record<string, any> & { id: string; type: string; timestamp: number };

export interface SenderStatsSample {
  bitrateMbps: number | null;
  fps: number | null;
  width: number | null;
  height: number | null;
  rttMs: number | null;
  availableOutgoingMbps: number | null;
  packetLossPercent: number | null;
  encodeMs: number | null;
  encoder: string | null;
  codec: string | null;
  /** Why the encoder is holding back: 'none' | 'bandwidth' | 'cpu' | 'other'. */
  qualityLimitation: string | null;
}

function collect(report: StatsReportLike): { all: Stat[]; byId: Map<string, Stat> } {
  const all: Stat[] = [];
  const byId = new Map<string, Stat>();
  report.forEach((stat: Stat) => {
    all.push(stat);
    byId.set(stat.id, stat);
  });
  return { all, byId };
}

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const round = (value: number, digits = 1): number => Number(value.toFixed(digits));

const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/** Bits per second between two byte counters, in Mbps. */
function mbpsBetween(bytesNow: unknown, bytesBefore: unknown, msNow: number, msBefore: number): number | null {
  const now = num(bytesNow);
  const before = num(bytesBefore);
  if (now === null || before === null || msNow <= msBefore || now < before) return null;
  return round(((now - before) * 8) / ((msNow - msBefore) / 1000) / 1e6);
}

/** Average milliseconds per unit between two (seconds-total, count) counter pairs. */
function msPerUnit(totalNow: unknown, totalBefore: unknown, countNow: unknown, countBefore: unknown): number | null {
  const t1 = num(totalNow);
  const t0 = num(totalBefore);
  const c1 = num(countNow);
  const c0 = num(countBefore);
  if (t1 === null || t0 === null || c1 === null || c0 === null || c1 <= c0) return null;
  return round(((t1 - t0) / (c1 - c0)) * 1000);
}

function codecName(byId: Map<string, Stat>, codecId: unknown): string | null {
  const codec = typeof codecId === 'string' ? byId.get(codecId) : undefined;
  return str(codec?.mimeType)?.replace(/^(video|audio)\//, '') ?? null;
}

function selectedCandidatePair(all: Stat[], byId: Map<string, Stat>): Stat | undefined {
  const transport = all.find((s) => s.type === 'transport' && s.selectedCandidatePairId);
  const selected = transport ? byId.get(transport.selectedCandidatePairId) : undefined;
  return selected ?? all.find((s) => s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded');
}

export function createSenderStatsSampler(): (report: StatsReportLike) => SenderStatsSample {
  let previous: Stat | null = null;

  return (report) => {
    const { all, byId } = collect(report);
    const outbound = all.find((s) => s.type === 'outbound-rtp' && s.kind === 'video');
    const pair = selectedCandidatePair(all, byId);
    const remoteInbound = all.find((s) => s.type === 'remote-inbound-rtp' && s.kind === 'video');

    let bitrateMbps: number | null = null;
    let encodeMs: number | null = null;
    if (outbound && previous) {
      bitrateMbps = mbpsBetween(outbound.bytesSent, previous.bytesSent, outbound.timestamp, previous.timestamp);
      encodeMs = msPerUnit(outbound.totalEncodeTime, previous.totalEncodeTime, outbound.framesEncoded, previous.framesEncoded);
    }
    previous = outbound ?? null;

    const rttSeconds = num(pair?.currentRoundTripTime);
    const available = num(pair?.availableOutgoingBitrate);
    const fractionLost = num(remoteInbound?.fractionLost);

    return {
      bitrateMbps,
      fps: num(outbound?.framesPerSecond),
      width: num(outbound?.frameWidth),
      height: num(outbound?.frameHeight),
      rttMs: rttSeconds === null ? null : round(rttSeconds * 1000),
      availableOutgoingMbps: available === null ? null : round(available / 1e6),
      packetLossPercent: fractionLost === null ? null : round(fractionLost * 100),
      encodeMs,
      encoder: str(outbound?.encoderImplementation),
      codec: codecName(byId, outbound?.codecId),
      qualityLimitation: str(outbound?.qualityLimitationReason)
    };
  };
}

export function createTvStatsSampler(): (report: StatsReportLike) => TvStatsReport {
  let previous: Stat | null = null;

  return (report) => {
    const { all } = collect(report);
    const inbound = all.find((s) => s.type === 'inbound-rtp' && s.kind === 'video');

    let bitrateMbps: number | null = null;
    let jitterBufferMs: number | null = null;
    let decodeMs: number | null = null;
    if (inbound && previous) {
      bitrateMbps = mbpsBetween(inbound.bytesReceived, previous.bytesReceived, inbound.timestamp, previous.timestamp);
      jitterBufferMs = msPerUnit(
        inbound.jitterBufferDelay,
        previous.jitterBufferDelay,
        inbound.jitterBufferEmittedCount,
        previous.jitterBufferEmittedCount
      );
      decodeMs = msPerUnit(inbound.totalDecodeTime, previous.totalDecodeTime, inbound.framesDecoded, previous.framesDecoded);
    }
    previous = inbound ?? null;

    return {
      fps: num(inbound?.framesPerSecond),
      width: num(inbound?.frameWidth),
      height: num(inbound?.frameHeight),
      bitrateMbps,
      jitterBufferMs,
      decodeMs,
      framesDropped: num(inbound?.framesDropped),
      packetsLost: num(inbound?.packetsLost),
      decoder: str(inbound?.decoderImplementation)
    };
  };
}

/**
 * Glass-to-glass estimate built only from measured parts:
 * encode + one-way network (RTT / 2) + TV jitter buffer + TV decode + one frame interval
 * (capture/display pacing). It leaves out the OS compositor and the TV panel's own
 * processing (turn on the TV's Game Mode to minimise that), so treat it as a lower bound.
 * Returns null until every part has been measured.
 */
export function estimateGlassToGlassMs(sender: SenderStatsSample, tv: TvStatsReport | null): number | null {
  if (!tv) return null;
  const parts = [sender.encodeMs, sender.rttMs, tv.jitterBufferMs, tv.decodeMs];
  if (parts.some((p) => p === null)) return null;
  const fps = sender.fps ?? tv.fps ?? 60;
  const frameIntervalMs = fps > 0 ? 1000 / fps : 16.7;
  return round(sender.encodeMs! + sender.rttMs! / 2 + tv.jitterBufferMs! + tv.decodeMs! + frameIntervalMs);
}
