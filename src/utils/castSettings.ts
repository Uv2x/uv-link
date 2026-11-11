/**
 * The settings that change how the PC casts. Everything here is applied to the real encoder
 * (see LiveMirroringWorkbench); nothing is a prediction. Saved in the browser between sessions.
 */
import type { VideoCodecName } from './peer';

export type QualityPreset = 'max' | 'high' | 'medium' | 'low';
export type FrameRate = 30 | 60 | 120;

export interface CastSettings {
  /** Format tried first; the cast falls back to others when the TV can't decode it. */
  codec: VideoCodecName;
  /** Frames per second to capture and send (capped at what the TV can show). */
  targetFps: FrameRate;
  quality: QualityPreset;
  /** What the encoder gives up first when the network is busy. */
  degradationPreference: RTCDegradationPreference;
  audio: {
    enabled: boolean;
    /** Same stream id for audio and video: in sync, but video waits for the audio buffer. */
    lipSyncLock: boolean;
  };
}

export interface QualityCap {
  label: string;
  hint: string;
  maxBitrateKbps: number;
  /** Extra downscale on top of fitting the picture to the TV. */
  scaleResolutionDownBy: number;
}

export const QUALITY_PRESETS: Record<QualityPreset, QualityCap> = {
  max: { label: 'Max', hint: 'Ethernet or very strong Wi-Fi: up to 60 Mbps', maxBitrateKbps: 60_000, scaleResolutionDownBy: 1 },
  high: { label: 'High', hint: 'Good 5 GHz Wi-Fi: up to 35 Mbps', maxBitrateKbps: 35_000, scaleResolutionDownBy: 1 },
  medium: { label: 'Medium', hint: 'Busy Wi-Fi: up to 12 Mbps, 2/3 size', maxBitrateKbps: 12_000, scaleResolutionDownBy: 1.5 },
  low: { label: 'Low', hint: 'Weak or 2.4 GHz Wi-Fi: up to 5 Mbps, half size', maxBitrateKbps: 5_000, scaleResolutionDownBy: 2 }
};

export const CODEC_OPTIONS: Array<{ value: VideoCodecName; label: string; hint: string }> = [
  { value: 'H264', label: 'H.264', hint: 'Best for most TVs. Encoded on the graphics card when it can.' },
  { value: 'VP8', label: 'VP8', hint: 'Works everywhere; the TV decodes it in software.' },
  { value: 'VP9', label: 'VP9', hint: 'Sharper than VP8 at the same bitrate; heavier to decode.' },
  { value: 'AV1', label: 'AV1', hint: 'Newest and most efficient. Only for TVs that decode AV1 (mostly 2021+); encoded in software here.' },
  { value: 'H265', label: 'H.265', hint: 'Only if the TV browser supports H.265 in WebRTC (few do).' }
];

export const DEFAULT_SETTINGS: CastSettings = {
  codec: 'H264',
  targetFps: 60,
  quality: 'high',
  degradationPreference: 'maintain-framerate',
  audio: { enabled: true, lipSyncLock: true }
};

const STORAGE_KEY = 'uvlink.settings.v1';
const CODECS = new Set<string>(CODEC_OPTIONS.map((c) => c.value));
const DEGRADATIONS = new Set<string>(['maintain-framerate', 'maintain-resolution', 'balanced']);

/** Settings from storage, with anything missing or invalid replaced by the default. */
export function parseSettings(raw: unknown): CastSettings {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const audio = (s.audio && typeof s.audio === 'object' ? s.audio : {}) as Record<string, unknown>;
  return {
    codec: CODECS.has(s.codec) ? s.codec : DEFAULT_SETTINGS.codec,
    targetFps: s.targetFps === 30 || s.targetFps === 60 || s.targetFps === 120 ? s.targetFps : DEFAULT_SETTINGS.targetFps,
    quality: typeof s.quality === 'string' && s.quality in QUALITY_PRESETS ? (s.quality as QualityPreset) : DEFAULT_SETTINGS.quality,
    degradationPreference: DEGRADATIONS.has(s.degradationPreference)
      ? s.degradationPreference
      : DEFAULT_SETTINGS.degradationPreference,
    audio: {
      enabled: typeof audio.enabled === 'boolean' ? audio.enabled : DEFAULT_SETTINGS.audio.enabled,
      lipSyncLock: typeof audio.lipSyncLock === 'boolean' ? audio.lipSyncLock : DEFAULT_SETTINGS.audio.lipSyncLock
    }
  };
}

export function loadSettings(): CastSettings {
  try {
    return parseSettings(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: CastSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage blocked: settings just aren't remembered.
  }
}

/** Frame rate to send: the setting, but never more than the TV can show. */
export function effectiveFps(settings: CastSettings, tvMaxFps: number | undefined): number {
  return Math.min(settings.targetFps, tvMaxFps && tvMaxFps > 0 ? tvMaxFps : 60);
}
