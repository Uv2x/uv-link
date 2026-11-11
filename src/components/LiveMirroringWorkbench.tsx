import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Tv,
  MonitorUp,
  Play,
  Square,
  RefreshCw,
  Volume2,
  AlertTriangle,
  Loader2,
  Copy,
  Check,
  Radio
} from 'lucide-react';
import { QUALITY_PRESETS, effectiveFps, type CastSettings } from '../utils/castSettings';
import { openAppAudioTrack, type AppAudioTrack } from '../utils/appAudio';
import { CapturePicker } from './CapturePicker';
import type { CaptureChoice, CaptureSource } from '../shared/protocol';
import type { LiveReceiver, TvStatsReport } from '../shared/protocol';
import type { SignalingClient } from '../utils/signalingClient';
import { createSenderStatsSampler, estimateGlassToGlassMs, type SenderStatsSample } from '../utils/rtcStats';
import {
  createDecodeLoadController,
  fitScale,
  type DecodeLoadDecision,
  type DecodeLoadSample
} from '../utils/decodeLoad';
import {
  addOrQueueIceCandidate,
  codecTryOrder,
  flushQueuedIceCandidates,
  preferVideoCodec,
  type VideoCodecName
} from '../utils/peer';

export type { LiveReceiver, PacketLogItem } from '../shared/protocol';

export interface LiveStreamStats {
  sender: SenderStatsSample;
  tv: TvStatsReport | null;
  estimatedDelayMs: number | null;
}

type CastSource = 'screen' | 'pattern';
type CastPhase = 'idle' | 'capturing' | 'connecting' | 'live';

/** Give up if the TV hasn't connected within this time. */
const CONNECT_TIMEOUT_MS = 15000;
/** When the TV is this far behind, reconnect (dropping its queue) instead of only shrinking. */
const BACKLOG_RESTART_MS = 1000;

interface AudioMeter {
  left: AnalyserNode;
  right: AnalyserNode;
  buffer: Float32Array<ArrayBuffer>;
}

interface CastSession {
  pc: RTCPeerConnection;
  receiverId: string;
  receiverName: string;
  stream: MediaStream;
  videoSender: RTCRtpSender;
  pendingIce: RTCIceCandidateInit[];
  timers: number[];
  audioCtx: AudioContext | null;
  /** The video codec offered first (the one the TV is expected to use). */
  codec: VideoCodecName;
  /** Highest frame rate the TV can show. */
  tvMaxFps: number;
  /** Capture size, e.g. 3440x1440 for an ultrawide screen. */
  sourceWidth: number;
  sourceHeight: number;
  /** scaleResolutionDownBy that fits the capture into the TV's 1920x1080 picture. */
  fit: number;
  /** Extra downscale and frame-rate cap while the TV can't decode fast enough. */
  extraScale: number;
  fpsCap: number;
  decodeLoad: (sample: DecodeLoadSample) => DecodeLoadDecision;
  /** The TV report the decode-load controller saw last (reports arrive once a second). */
  lastTvStats: TvStatsReport | null;
}

/** What a reconnect needs to start a new peer connection for the same capture. */
interface PeerTarget {
  receiverId: string;
  receiverName: string;
  tvMaxFps: number;
  stream: MediaStream;
  audioCtx: AudioContext | null;
  codec: VideoCodecName;
  /** Codecs this TV couldn't decode; left out of the offer. */
  failures: string[];
  /** Size / frame-rate limits to keep when reconnecting with the same codec. */
  load?: { extraScale: number; fpsCap: number; decodeLoad: (sample: DecodeLoadSample) => DecodeLoadDecision };
}

// Codecs a TV couldn't decode, remembered per TV name so the next cast starts with one that works.
// v2: failures recorded before 1.1.2 happened at full screen size (e.g. 3440x1440); now that the
// picture is sized for the TV, H.264 may decode in hardware after all, so it gets another try.
const CODEC_FAILURES_KEY = 'uvlink.codecFailures.v2';

function readCodecFailures(tvName: string): string[] {
  try {
    const all = JSON.parse(localStorage.getItem(CODEC_FAILURES_KEY) ?? '{}') as Record<string, unknown>;
    const list = all[tvName];
    return Array.isArray(list) ? list.filter((c): c is string => typeof c === 'string') : [];
  } catch {
    return [];
  }
}

function writeCodecFailures(tvName: string, failures: string[]): void {
  try {
    const all = JSON.parse(localStorage.getItem(CODEC_FAILURES_KEY) ?? '{}') as Record<string, unknown>;
    if (failures.length) all[tvName] = failures;
    else delete all[tvName];
    localStorage.setItem(CODEC_FAILURES_KEY, JSON.stringify(all));
  } catch {
    // Storage blocked: the TV just gets the full codec order again next time.
  }
}

const codecLabel = (codec: string): string =>
  ({ H264: 'H.264', H265: 'H.265', VP8: 'VP8', VP9: 'VP9', AV1: 'AV1' })[codec.toUpperCase()] ?? codec;

const preferredCodec = (p: CastSettings): VideoCodecName => p.codec;

/**
 * The capture's real frame size. getSettings() can report the main monitor's size when another
 * screen is captured (seen in Electron with two monitors), so read it from an actual frame.
 */
async function frameSize(track: MediaStreamTrack): Promise<{ width: number; height: number }> {
  const reported = track.getSettings();
  const video = document.createElement('video');
  video.muted = true;
  video.srcObject = new MediaStream([track]);
  try {
    await video.play().catch(() => {});
    for (let i = 0; i < 30 && !video.videoWidth; i++) await new Promise((r) => setTimeout(r, 50));
    if (video.videoWidth > 0 && video.videoHeight > 0) return { width: video.videoWidth, height: video.videoHeight };
  } finally {
    video.srcObject = null;
  }
  return { width: reported.width ?? 1920, height: reported.height ?? 1080 };
}

/** "MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)" -> "NVIDIA H.264 Encoder MFT". */
const encoderName = (encoder: string | null): string =>
  encoder ? (/\(([^)]+)\)\s*$/.exec(encoder)?.[1] ?? encoder) : 'name hidden by browser';

function createAudioMeter(ctx: AudioContext, track: MediaStreamTrack): AudioMeter {
  const source = ctx.createMediaStreamSource(new MediaStream([track]));
  const splitter = ctx.createChannelSplitter(2);
  const left = ctx.createAnalyser();
  const right = ctx.createAnalyser();
  left.fftSize = 512;
  right.fftSize = 512;
  source.connect(splitter);
  splitter.connect(left, 0);
  splitter.connect(right, 1);
  return { left, right, buffer: new Float32Array(512) };
}

/** RMS level mapped from -60..0 dBFS to 0..100. */
function meterLevel(analyser: AnalyserNode, buffer: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(buffer);
  let sum = 0;
  for (const v of buffer) sum += v * v;
  const rms = Math.sqrt(sum / buffer.length);
  if (rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  return Math.max(0, Math.min(100, Math.round(((db + 60) / 60) * 100)));
}

const show = (value: number | string | null | undefined, unit = ''): string =>
  value === null || value === undefined ? '—' : `${value}${unit}`;

interface LiveMirroringWorkbenchProps {
  params: CastSettings;
  onUpdateParams: (updater: (prev: CastSettings) => CastSettings) => void;
  receivers: LiveReceiver[];
  selectedReceiverId: string;
  onSelectReceiver: (id: string) => void;
  onRefreshReceivers: () => Promise<void>;
  signaling: SignalingClient | null;
  signalingConnected: boolean;
  tvUrl: string | null;
  onLiveStats: (stats: LiveStreamStats | null) => void;
  isStreaming: boolean;
  setIsStreaming: (val: boolean) => void;
}

export const LiveMirroringWorkbench: React.FC<LiveMirroringWorkbenchProps> = ({
  params,
  onUpdateParams,
  receivers,
  selectedReceiverId,
  onSelectReceiver,
  onRefreshReceivers,
  signaling,
  signalingConnected,
  tvUrl,
  onLiveStats,
  isStreaming,
  setIsStreaming
}) => {
  const senderCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const sessionRef = useRef<CastSession | null>(null);
  const meterRef = useRef<AudioMeter | null>(null);
  const tvStatsRef = useRef<TvStatsReport | null>(null);
  const signalingRef = useRef<SignalingClient | null>(signaling);

  const [phase, setPhase] = useState<CastPhase>('idle');
  const [activeSource, setActiveSource] = useState<CastSource | null>(null);
  const [castReceiverId, setCastReceiverId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [audioLevels, setAudioLevels] = useState({ left: 0, right: 0 });
  const [senderStats, setSenderStats] = useState<SenderStatsSample | null>(null);
  const [tvStats, setTvStats] = useState<TvStatsReport | null>(null);
  const [copied, setCopied] = useState(false);
  /** Informational message, e.g. "switched to VP8". */
  const [notice, setNotice] = useState('');
  const [activeCodec, setActiveCodec] = useState<VideoCodecName | null>(null);
  /** Bumped when remembered codec failures change, to re-read them. */
  const [failuresVersion, setFailuresVersion] = useState(0);
  /** What the encoder is sized to and why, e.g. "Sending 1920x804 to fit the TV". */
  const [sizeNote, setSizeNote] = useState('');

  const paramsRef = useRef(params);
  useEffect(() => {
    paramsRef.current = params;
  }, [params]);
  /** What the encoder is set to right now (shown in the header). */
  const [sending, setSending] = useState<{ width: number; height: number; fps: number } | null>(null);
  /** The PC app's screen/window picker, open while non-null. */
  const [pickerSources, setPickerSources] = useState<CaptureSource[] | null>(null);
  /** "This app only" sound for the running cast. */
  const appAudioRef = useRef<AppAudioTrack | null>(null);

  useEffect(() => {
    signalingRef.current = signaling;
  }, [signaling]);

  /**
   * Encoder size, frame rate and bitrate for a session: the bitrate settings' choice, but never
   * larger than the TV shows (fit) and smaller still while the TV can't decode fast enough.
   */
  const encodingFor = useCallback((session: CastSession) => {
    const p = paramsRef.current;
    const cap = QUALITY_PRESETS[p.quality];
    const scale = session.fit * session.extraScale * cap.scaleResolutionDownBy;
    return {
      scale,
      fps: Math.min(effectiveFps(p, session.tvMaxFps), session.fpsCap),
      maxBitrate: cap.maxBitrateKbps * 1000,
      width: Math.round(session.sourceWidth / scale),
      height: Math.round(session.sourceHeight / scale)
    };
  }, []);

  const applyEncoding = useCallback(
    async (session: CastSession) => {
      const encoding = encodingFor(session);
      try {
        const rtpParams = session.videoSender.getParameters();
        rtpParams.degradationPreference = paramsRef.current.degradationPreference;
        rtpParams.encodings = [
          {
            ...(rtpParams.encodings?.[0] ?? {}),
            maxBitrate: encoding.maxBitrate,
            maxFramerate: encoding.fps,
            scaleResolutionDownBy: encoding.scale
          }
        ];
        await session.videoSender.setParameters(rtpParams);
      } catch (err) {
        console.warn('Uv Link: could not update encoder settings', err);
      }
      if (sessionRef.current === session) setSending({ width: encoding.width, height: encoding.height, fps: encoding.fps });
      return encoding;
    },
    [encodingFor]
  );

  // Re-apply the bitrate / fps / resolution caps whenever the ABR decision changes mid-cast.
  useEffect(() => {
    const session = sessionRef.current;
    if (!session || !isStreaming) return;
    void applyEncoding(session);
  }, [
    applyEncoding,
    isStreaming,
    params.degradationPreference,
    params.targetFps,
    params.quality
  ]);

  // Test pattern: a running clock (photograph PC + TV together to measure real
  // glass-to-glass delay), a frame counter, and a sweep bar to judge smoothness.
  useEffect(() => {
    const canvas = senderCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let frameCount = 0;
    let rafId = 0;

    const renderFrame = (now: number) => {
      frameCount++;
      const w = canvas.width;
      const h = canvas.height;

      ctx.fillStyle = '#090d16';
      ctx.fillRect(0, 0, w, h);

      ctx.strokeStyle = 'rgba(148, 163, 184, 0.08)';
      ctx.lineWidth = 1;
      for (let x = 0; x < w; x += 64) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      for (let y = 0; y < h; y += 64) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      const sweepX = ((now * 0.36) % (w - 24)) + 12;
      const grad = ctx.createLinearGradient(sweepX - 36, 0, sweepX + 8, 0);
      grad.addColorStop(0, 'rgba(56, 189, 248, 0)');
      grad.addColorStop(1, 'rgba(56, 189, 248, 0.75)');
      ctx.fillStyle = grad;
      ctx.fillRect(sweepX - 36, 16, 44, h - 32);

      const clock = new Date();
      const time = `${clock.toTimeString().slice(0, 8)}.${String(clock.getMilliseconds()).padStart(3, '0')}`;
      ctx.textAlign = 'center';
      ctx.font = '600 56px "JetBrains Mono", monospace';
      ctx.fillStyle = '#f8fafc';
      ctx.fillText(time, w / 2, h / 2 + 18);

      ctx.textAlign = 'left';
      ctx.font = '600 13px "JetBrains Mono", monospace';
      ctx.fillStyle = '#38bdf8';
      ctx.fillText(`UV LINK TEST PATTERN · frame ${frameCount}`, 24, 36);
      ctx.font = '500 12px "JetBrains Mono", monospace';
      ctx.fillStyle = '#94a3b8';
      ctx.fillText('Photograph both screens: the clock difference is your real delay.', 24, h - 24);

      const meter = meterRef.current;
      if (frameCount % 4 === 0) {
        setAudioLevels(
          meter
            ? { left: meterLevel(meter.left, meter.buffer), right: meterLevel(meter.right, meter.buffer) }
            : { left: 0, right: 0 }
        );
      }

      rafId = requestAnimationFrame(renderFrame);
    };

    rafId = requestAnimationFrame(renderFrame);
    return () => cancelAnimationFrame(rafId);
  }, []);

  /** Closes a session's peer connection and timers; the capture keeps running. */
  const closePeer = useCallback((session: CastSession) => {
    session.timers.forEach((t) => window.clearTimeout(t));
    session.timers = [];
    session.pc.onicecandidate = null;
    session.pc.onconnectionstatechange = null;
    session.pc.close();
  }, []);

  /** Releases everything the current cast holds. Safe to call when nothing is running. */
  const releaseSession = useCallback((notifyTv: boolean) => {
    const session = sessionRef.current;
    sessionRef.current = null;
    meterRef.current = null;
    tvStatsRef.current = null;
    if (!session) return;
    closePeer(session);
    session.stream.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    session.audioCtx?.close().catch(() => {});
    appAudioRef.current?.close();
    appAudioRef.current = null;
    if (notifyTv) signalingRef.current?.send({ type: 'webrtc:stop', to: session.receiverId });
  }, [closePeer]);

  const endCast = useCallback(
    (notifyTv: boolean, errorMessage = '') => {
      releaseSession(notifyTv);
      if (previewVideoRef.current) previewVideoRef.current.srcObject = null;
      setPhase('idle');
      setActiveSource(null);
      setCastReceiverId(null);
      setSenderStats(null);
      setTvStats(null);
      setActiveCodec(null);
      setIsStreaming(false);
      onLiveStats(null);
      setError(errorMessage);
      setNotice('');
      setSizeNote('');
    },
    [releaseSession, setIsStreaming, onLiveStats]
  );

  // Stop casting if this component goes away (page navigation, hot reload).
  useEffect(() => () => releaseSession(true), [releaseSession]);

  // Answers, ICE candidates, stats and "ended" notices from the TV side.
  useEffect(() => {
    if (!signaling) return;
    return signaling.subscribe((msg) => {
      const session = sessionRef.current;
      if (!session) return;
      if (msg.type === 'webrtc:answer' && msg.from === session.receiverId) {
        session.pc
          .setRemoteDescription({ type: 'answer', sdp: msg.sdp })
          .then(() => flushQueuedIceCandidates(session.pc, session.pendingIce))
          .catch((err) => {
            if (sessionRef.current === session) endCast(true, `The TV sent an answer this browser could not use: ${err.message}`);
          });
      } else if (msg.type === 'webrtc:ice' && msg.from === session.receiverId) {
        void addOrQueueIceCandidate(session.pc, session.pendingIce, msg.candidate);
      } else if (msg.type === 'tv:stats' && msg.from === session.receiverId) {
        tvStatsRef.current = msg.stats;
      } else if (msg.type === 'tv:decode-stalled' && msg.from === session.receiverId) {
        tvStatsRef.current = msg.stats;
        switchCodecRef.current(session, msg.codec);
      } else if (msg.type === 'webrtc:ended' && msg.receiverId === session.receiverId) {
        endCast(false, msg.reason);
      }
    });
  }, [signaling, endCast]);

  /** In the PC app, show its screen/window picker first; in a browser, its own picker appears. */
  const castScreen = async () => {
    setError('');
    try {
      const res = await fetch('/api/capture/sources');
      if (res.ok) {
        const data = (await res.json()) as { sources?: CaptureSource[] };
        if (data.sources?.length) {
          setPickerSources(data.sources);
          return;
        }
      }
    } catch {
      // Not the PC app: use the browser's picker.
    }
    void startCasting('screen');
  };

  const castPicked = async (choice: CaptureChoice) => {
    setPickerSources(null);
    try {
      await fetch('/api/capture/choice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(choice)
      });
    } catch {
      // The PC app falls back to its own screen dialog.
    }
    void startCasting('screen', choice);
  };

  const startCasting = async (source: CastSource, choice?: CaptureChoice) => {
    setError('');
    const signalingClient = signalingRef.current;
    const target = receivers.find((r) => r.id === selectedReceiverId);
    if (!signalingClient || !signalingConnected) {
      setError('Not connected to the Uv Link server. Make sure "npm run dev" is still running.');
      return;
    }
    if (!target) {
      setError(tvUrl ? `No TV is connected yet. On your TV's browser, open ${tvUrl}` : 'No TV is connected yet.');
      return;
    }
    if (sessionRef.current) endCast(true);

    const p = paramsRef.current;
    const castFps = effectiveFps(p, target.maxFps);
    setPhase('capturing');

    let stream: MediaStream;
    let audioCtx: AudioContext | null = null;

    if (source === 'screen') {
      if (!window.isSecureContext || !navigator.mediaDevices?.getDisplayMedia) {
        setPhase('idle');
        setError(
          'This browser only allows screen capture on a secure page. On this PC, open http://localhost:3000 (not the network address).'
        );
        return;
      }
      try {
        // The PC app's picker decides the sound; elsewhere the Audio On/Muted setting does.
        const systemSound = choice ? choice.audio === 'system' : p.audio.enabled;
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: { ideal: castFps, max: castFps } },
          audio: systemSound ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false
        });
      } catch (err) {
        setPhase('idle');
        const cancelled = err instanceof DOMException && err.name === 'NotAllowedError';
        setError(cancelled ? 'Screen sharing was cancelled.' : `Could not capture the screen: ${(err as Error).message}`);
        return;
      }
    } else {
      const canvas = senderCanvasRef.current;
      if (!canvas) {
        setPhase('idle');
        return;
      }
      stream = canvas.captureStream(castFps);
      if (p.audio.enabled) {
        // Quiet 440 Hz tone so you can confirm sound reaches the TV.
        audioCtx = new AudioContext({ sampleRate: 48000 });
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        gain.gain.value = 0.04;
        osc.frequency.value = 440;
        const dest = audioCtx.createMediaStreamDestination();
        osc.connect(gain);
        gain.connect(dest);
        osc.start();
        const [toneTrack] = dest.stream.getAudioTracks();
        if (toneTrack) stream.addTrack(toneTrack);
      }
    }

    const [videoTrack] = stream.getVideoTracks();
    if (!videoTrack) {
      stream.getTracks().forEach((t) => t.stop());
      audioCtx?.close().catch(() => {});
      setPhase('idle');
      setError('The selected source has no video.');
      return;
    }
    videoTrack.contentHint = 'motion';
    if (choice?.audio === 'app') {
      // Only the chosen window's program: its sound comes from the PC app's helper.
      try {
        appAudioRef.current = await openAppAudioTrack();
        stream.addTrack(appAudioRef.current.track);
      } catch (err) {
        setError(`Casting without sound: couldn't capture that app's sound (${err instanceof Error ? err.message : String(err)}).`);
      }
    }
    const [audioTrack] = stream.getAudioTracks();
    if (audioTrack) {
      audioCtx = audioCtx ?? new AudioContext();
      audioCtx.resume().catch(() => {});
      meterRef.current = createAudioMeter(audioCtx, audioTrack);
    }
    // The browser's own "Stop sharing" button ends the track.
    videoTrack.onended = () => {
      if (sessionRef.current?.stream === stream) endCast(true);
    };

    // Start with a codec this TV can decode: skip ones that froze on it before.
    const failures = readCodecFailures(target.name);
    const order = codecTryOrder(preferredCodec(p), failures);
    const codec = order[0] ?? preferredCodec(p);
    setNotice(
      failures.length
        ? `Sending ${codecLabel(codec)}: ${failures.map(codecLabel).join(' and ')} froze on ${target.name} before.`
        : ''
    );

    if (previewVideoRef.current) {
      previewVideoRef.current.srcObject = stream;
      previewVideoRef.current.play().catch(() => {});
    }
    setActiveSource(source);
    setCastReceiverId(target.id);
    setIsStreaming(true);
    await connectPeer({
      receiverId: target.id,
      receiverName: target.name,
      tvMaxFps: target.maxFps,
      stream,
      audioCtx,
      codec,
      failures
    });
  };

  /**
   * Opens a peer connection to the TV for an existing capture and offers `codec` first.
   * Used for a new cast, and again (same capture) when the TV can't decode the codec.
   */
  const connectPeer = async (target: PeerTarget) => {
    const signalingClient = signalingRef.current;
    if (!signalingClient) {
      endCast(false, 'Not connected to the Uv Link server.');
      return;
    }
    const p = paramsRef.current;
    const { stream } = target;
    const [videoTrack] = stream.getVideoTracks();
    const [audioTrack] = stream.getAudioTracks();

    const pc = new RTCPeerConnection({ iceServers: [] });
    const videoTransceiver = pc.addTransceiver(videoTrack, { direction: 'sendonly', streams: [stream] });
    preferVideoCodec(videoTransceiver, target.codec, target.failures);
    // The capture only has sound when sound was asked for (settings, or the PC app's picker).
    if (audioTrack) {
      // Same stream id = the TV lip-syncs audio and video, which holds video back to match
      // the audio buffer (~40-60 ms). A separate stream lets video play as soon as it's decoded.
      const audioStream = p.audio.lipSyncLock ? stream : new MediaStream([audioTrack]);
      pc.addTransceiver(audioTrack, { direction: 'sendonly', streams: [audioStream] });
    }

    // Never send more pixels than the TV shows; an ultrawide 3440x1440 becomes 1920x804.
    const { width: sourceWidth, height: sourceHeight } = await frameSize(videoTrack);
    if (videoTrack.readyState === 'ended') {
      pc.close(); // the cast was stopped meanwhile
      return;
    }
    const fit = fitScale(sourceWidth, sourceHeight);
    const session: CastSession = {
      pc,
      receiverId: target.receiverId,
      receiverName: target.receiverName,
      stream,
      videoSender: videoTransceiver.sender,
      pendingIce: [],
      timers: [],
      audioCtx: target.audioCtx,
      codec: target.codec,
      sourceWidth,
      sourceHeight,
      fit,
      tvMaxFps: target.tvMaxFps,
      extraScale: target.load?.extraScale ?? 1,
      fpsCap: target.load?.fpsCap ?? effectiveFps(p, target.tvMaxFps),
      decodeLoad:
        target.load?.decodeLoad ??
        createDecodeLoadController({ targetFps: effectiveFps(p, target.tvMaxFps), fittedWidth: Math.round(sourceWidth / fit) }),
      lastTvStats: null
    };
    sessionRef.current = session;
    setActiveCodec(target.codec);

    const initial = await applyEncoding(session);
    const holdingBack = session.extraScale > 1 || session.fpsCap < p.targetFps;
    setSizeNote(
      holdingBack
        ? `Sending ${initial.width}x${initial.height} at ${initial.fps} fps so the TV keeps up.`
        : fit > 1
          ? `Sending ${initial.width}x${initial.height} (your ${sourceWidth}x${sourceHeight} screen, sized for the TV).`
          : ''
    );

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        signalingClient.send({ type: 'webrtc:ice', to: target.receiverId, candidate: event.candidate.toJSON() });
      }
    };
    pc.onconnectionstatechange = () => {
      if (sessionRef.current !== session) return;
      const state = pc.connectionState;
      if (state === 'connected') setPhase('live');
      else if (state === 'disconnected') setPhase('connecting');
      else if (state === 'failed') {
        endCast(true, 'Lost the connection to the TV. Check that the PC and TV are on the same Wi-Fi network.');
      }
    };
    setPhase('connecting');

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
    } catch (err) {
      endCast(false, `Could not prepare the stream: ${(err as Error).message}`);
      return;
    }
    if (sessionRef.current !== session) return;
    // A new offer to the same TV replaces its previous connection (used when switching codec).
    signalingClient.send({ type: 'webrtc:offer', to: target.receiverId, sdp: pc.localDescription?.sdp ?? '' });

    session.timers.push(
      window.setTimeout(() => {
        if (sessionRef.current !== session || pc.connectionState === 'connected') return;
        endCast(
          true,
          pc.remoteDescription
            ? 'The TV answered but no network path was found. Both devices must be on the same network (guest Wi-Fi and "AP isolation" block this).'
            : 'The TV did not respond. Is the TV page still open?'
        );
      }, CONNECT_TIMEOUT_MS)
    );

    const sample = createSenderStatsSampler();
    const statsTimer = window.setInterval(async () => {
      if (sessionRef.current !== session) {
        window.clearInterval(statsTimer);
        return;
      }
      try {
        const senderSample = sample(await pc.getStats());
        const tv = tvStatsRef.current;
        // Keep the picture small enough for the TV to decode every frame in time.
        if (tv && tv !== session.lastTvStats) {
          session.lastTvStats = tv;
          const decision = session.decodeLoad({ decodeMs: tv.decodeMs, jitterBufferMs: tv.jitterBufferMs });
          if (decision.exhausted) {
            // Even the smallest picture at 30 fps is too much: this codec is too heavy for the TV.
            switchCodecRef.current(session, session.codec, 'fast enough');
            return;
          }
          if (decision.change) {
            session.extraScale = decision.extraScale;
            session.fpsCap = decision.fps;
            const backlogMs = tv.jitterBufferMs ?? 0;
            if (backlogMs > BACKLOG_RESTART_MS) {
              // Frames the TV already queued would keep it seconds behind; a fresh connection drops them.
              setSizeNote(
                `Reconnecting smaller: the TV was ${(backlogMs / 1000).toFixed(1)} s behind because ${decision.change}.`
              );
              restartPeerRef.current(session);
              return;
            }
            const applied = await applyEncoding(session);
            if (sessionRef.current === session) {
              setSizeNote(`Sending ${applied.width}x${applied.height} at ${applied.fps} fps: ${decision.change}.`);
            }
          }
        }
        setSenderStats(senderSample);
        setTvStats(tv);
        onLiveStats({ sender: senderSample, tv, estimatedDelayMs: estimateGlassToGlassMs(senderSample, tv) });
      } catch {
        // Connection closed between ticks; the next tick clears this timer.
      }
    }, 1000);
    session.timers.push(statsTimer);
  };

  /**
   * The TV gets frames but can't decode them (on Android, a broken hardware H.264 decoder has no
   * software fallback, so the picture just freezes). Remember that for this TV and reconnect with
   * the next codec, keeping the same screen capture.
   */
  const switchCodec = (session: CastSession, reportedCodec: string | null, how = '') => {
    if (sessionRef.current !== session) return;
    const failed = (reportedCodec ?? session.codec).toUpperCase();
    const couldnt = `couldn't decode ${codecLabel(failed)}${how ? ` ${how}` : ''}`;
    const failures = Array.from(new Set([...readCodecFailures(session.receiverName), failed]));
    writeCodecFailures(session.receiverName, failures);
    setFailuresVersion((v) => v + 1);
    const next = codecTryOrder(preferredCodec(paramsRef.current), failures)[0];
    if (!next) {
      endCast(
        true,
        `${session.receiverName} receives the video but can't decode it (tried ${failures.map(codecLabel).join(', ')}). Try the TV's own browser, or another TV.`
      );
      return;
    }
    setNotice(`${session.receiverName} ${couldnt}, so Uv Link switched to ${codecLabel(next)}.`);
    closePeer(session);
    tvStatsRef.current = null;
    setTvStats(null);
    void connectPeer({
      receiverId: session.receiverId,
      receiverName: session.receiverName,
      tvMaxFps: session.tvMaxFps,
      stream: session.stream,
      audioCtx: session.audioCtx,
      codec: next,
      failures
    });
  };
  const switchCodecRef = useRef(switchCodec);
  switchCodecRef.current = switchCodec;

  /** Same codec, smaller picture, fresh connection: drops the frames the TV had queued up. */
  const restartPeer = (session: CastSession) => {
    if (sessionRef.current !== session) return;
    closePeer(session);
    tvStatsRef.current = null;
    void connectPeer({
      receiverId: session.receiverId,
      receiverName: session.receiverName,
      tvMaxFps: session.tvMaxFps,
      stream: session.stream,
      audioCtx: session.audioCtx,
      codec: session.codec,
      failures: readCodecFailures(session.receiverName),
      load: { extraScale: session.extraScale, fpsCap: session.fpsCap, decodeLoad: session.decodeLoad }
    });
  };
  const restartPeerRef = useRef(restartPeer);
  restartPeerRef.current = restartPeer;

  const copyTvUrl = () => {
    if (!tvUrl) return;
    navigator.clipboard
      ?.writeText(tvUrl)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1800);
      })
      .catch(() => {});
  };

  const selectedReceiver = receivers.find((r) => r.id === selectedReceiverId) ?? null;
  const castReceiver = receivers.find((r) => r.id === castReceiverId) ?? selectedReceiver;
  const busy = phase !== 'idle';
  // Re-read whenever a failure is recorded or cleared (failuresVersion) or the TV changes.
  const rememberedFailures = selectedReceiver && failuresVersion >= 0 ? readCodecFailures(selectedReceiver.name) : [];

  const statusLabel =
    phase === 'live'
      ? `Live on ${castReceiver?.name ?? 'TV'}`
      : phase === 'connecting'
        ? 'Connecting…'
        : phase === 'capturing'
          ? 'Choose what to share…'
          : 'Standby';

  return (
    <section aria-label="Uv Link Sender and TV Receiver" className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
      {pickerSources && (
        <CapturePicker
          sources={pickerSources}
          audioEnabled={params.audio.enabled}
          onPick={(choice) => void castPicked(choice)}
          onCancel={() => setPickerSources(null)}
        />
      )}
      {/* Left: sender controls */}
      <div className="lg:col-span-5 border border-slate-800/90 bg-slate-900/50 rounded-lg p-6 flex flex-col justify-between">
        <div>
          <div className="flex items-center justify-between gap-2 pb-4 mb-4 border-b border-slate-800/80">
            <div>
              <h3 className="text-sm font-semibold text-white">Sender (this PC)</h3>
              <p className="text-xs text-slate-400 mt-0.5">
                {activeSource === 'screen'
                  ? 'Sharing your screen'
                  : activeSource === 'pattern'
                    ? 'Sending the test pattern'
                    : 'Ready to cast'}
              </p>
            </div>
            <span className="text-xs font-mono text-slate-400 tabular-nums whitespace-nowrap">
              {sending ? `${sending.fps} fps` : `${effectiveFps(params, selectedReceiver?.maxFps)} fps`} ·{' '}
              {codecLabel(activeCodec ?? preferredCodec(params))}
            </span>
          </div>

          <div className="relative rounded-md overflow-hidden border border-slate-800 bg-slate-950 aspect-video mb-5">
            <canvas
              ref={senderCanvasRef}
              width={960}
              height={540}
              data-testid="sender-capture-canvas"
              className="w-full h-full object-cover"
            />
          </div>

          {/* Target TV */}
          <div className="mb-4">
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <label htmlFor="receiver-select" className="text-xs font-medium text-slate-300 whitespace-nowrap">
                Target TV ({receivers.length} online)
              </label>
              <button
                type="button"
                onClick={() => void onRefreshReceivers()}
                className="px-2 py-1 text-xs text-slate-300 hover:text-white bg-slate-800/80 hover:bg-slate-800 rounded flex items-center gap-1 whitespace-nowrap shrink-0"
              >
                <RefreshCw className="w-3 h-3" />
                Refresh
              </button>
            </div>

            {receivers.length > 0 ? (
              <select
                id="receiver-select"
                value={selectedReceiverId}
                disabled={busy}
                onChange={(e) => onSelectReceiver(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-md px-3 py-2 text-xs text-slate-100 font-mono focus:outline-none focus:border-sky-500 disabled:opacity-60"
              >
                {receivers.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} — {r.device} ({r.ip})
                    {r.status === 'streaming' && r.id !== castReceiverId ? ' · in use' : ''}
                  </option>
                ))}
              </select>
            ) : (
              <div
                className="w-full bg-slate-950 border border-dashed border-slate-700 rounded-md px-3 py-2.5 text-xs text-slate-400"
                data-testid="no-receivers"
              >
                No TV connected yet. Open the TV link on your TV&apos;s browser and it will appear here.
              </div>
            )}
          </div>

          {/* Audio */}
          <div className="flex items-center justify-between gap-4 py-2.5 px-3.5 bg-slate-950/70 border border-slate-800/80 rounded-md mb-5">
            <div className="flex items-center gap-2.5 min-w-0">
              <Volume2 className="w-4 h-4 text-sky-400 shrink-0" />
              <div className="min-w-0">
                <div className="text-xs font-medium text-slate-200 whitespace-nowrap">
                  {activeSource === 'pattern' ? 'Test tone (440 Hz)' : 'System audio'}
                </div>
                <div className="flex items-center gap-2 mt-1" aria-hidden="true">
                  <div className="w-20 h-1.5 bg-slate-900 rounded-xs overflow-hidden">
                    <div
                      className="h-full bg-sky-400 transition-transform duration-75 origin-left"
                      style={{ transform: `scaleX(${audioLevels.left / 100})` }}
                    />
                  </div>
                  <div className="w-20 h-1.5 bg-slate-900 rounded-xs overflow-hidden">
                    <div
                      className="h-full bg-emerald-400 transition-transform duration-75 origin-left"
                      style={{ transform: `scaleX(${audioLevels.right / 100})` }}
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              {params.audio.enabled && (
                <button
                  type="button"
                  disabled={busy}
                  title={
                    params.audio.lipSyncLock
                      ? 'Lip sync on: sound matches the picture (best for videos). The TV holds video ~40-60 ms to line up with audio.'
                      : 'Lip sync off: lowest video delay (best for games/desktop). Sound may run slightly ahead or behind.'
                  }
                  onClick={() =>
                    onUpdateParams((prev) => ({
                      ...prev,
                      audio: { ...prev.audio, lipSyncLock: !prev.audio.lipSyncLock }
                    }))
                  }
                  data-testid="lip-sync-toggle"
                  className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap disabled:opacity-60 ${
                    params.audio.lipSyncLock
                      ? 'bg-sky-500/15 text-sky-300 border border-sky-500/30'
                      : 'bg-slate-800 text-slate-300 border border-slate-700'
                  }`}
                >
                  {params.audio.lipSyncLock ? 'Lip Sync' : 'Low Delay'}
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  onUpdateParams((prev) => ({
                    ...prev,
                    audio: { ...prev.audio, enabled: !prev.audio.enabled }
                  }))
                }
                className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap disabled:opacity-60 ${
                  params.audio.enabled
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                    : 'bg-slate-800 text-slate-400'
                }`}
              >
                {params.audio.enabled ? 'Audio On' : 'Muted'}
              </button>
            </div>
          </div>

          {error && (
            <p
              role="alert"
              data-testid="cast-error"
              className="mb-4 text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-md px-3 py-2 flex items-start gap-2"
            >
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>{error}</span>
            </p>
          )}
          {notice && !error && (
            <p
              role="status"
              data-testid="cast-notice"
              className="mb-4 text-xs text-sky-200 bg-sky-500/10 border border-sky-500/30 rounded-md px-3 py-2"
            >
              {notice}
            </p>
          )}
          {!busy && rememberedFailures.length > 0 && selectedReceiver && (
            <p className="mb-4 text-xs text-slate-400" data-testid="codec-memory">
              {selectedReceiver.name} froze with {rememberedFailures.map(codecLabel).join(' and ')} before, so Uv Link
              skips it.{' '}
              <button
                type="button"
                onClick={() => {
                  writeCodecFailures(selectedReceiver.name, []);
                  setFailuresVersion((v) => v + 1);
                }}
                className="text-sky-400 hover:text-sky-300 underline"
              >
                Try {rememberedFailures.map(codecLabel).join(' and ')} again
              </button>
            </p>
          )}
        </div>

        <div className="flex items-center gap-2.5 pt-4 border-t border-slate-800/80">
          {!busy ? (
            <>
              <button
                type="button"
                onClick={() => void castScreen()}
                className="flex-1 px-4 py-2.5 text-xs font-semibold bg-sky-400 hover:bg-sky-300 text-slate-950 rounded-md flex items-center justify-center gap-2 transition-colors whitespace-nowrap"
              >
                <MonitorUp className="w-3.5 h-3.5" />
                Cast Screen to TV
              </button>
              <button
                type="button"
                onClick={() => void startCasting('pattern')}
                className="px-3.5 py-2.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-100 rounded-md flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                Test Pattern
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => endCast(true)}
              className="w-full px-4 py-2.5 text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white rounded-md flex items-center justify-center gap-2 transition-colors whitespace-nowrap"
            >
              <Square className="w-3.5 h-3.5 fill-current" />
              Stop Casting{castReceiver ? ` to ${castReceiver.name}` : ''}
            </button>
          )}
        </div>
      </div>

      {/* Right: what the TV is getting */}
      <div className="lg:col-span-7 border border-slate-800/90 bg-slate-900/50 rounded-lg p-6 flex flex-col justify-between">
        <div>
          <div className="flex flex-wrap items-center justify-between gap-2 pb-4 mb-4 border-b border-slate-800/80">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                <Tv className="w-4 h-4 text-emerald-400 shrink-0" />
                <span className="truncate">{castReceiver ? castReceiver.name : 'No TV selected'}</span>
              </h3>
              <p className="text-xs text-slate-400 mt-0.5 font-mono">
                {castReceiver ? `${castReceiver.device} · ${castReceiver.ip}` : 'Waiting for a TV to join'}
              </p>
            </div>
            <span
              data-testid="webrtc-connection-status"
              className={`text-xs font-mono font-semibold flex items-center gap-1.5 whitespace-nowrap ${
                phase === 'live' ? 'text-emerald-400' : phase === 'idle' ? 'text-slate-400' : 'text-amber-300'
              }`}
            >
              {phase === 'live' ? (
                <Radio className="w-3.5 h-3.5" />
              ) : phase === 'idle' ? null : (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              )}
              {statusLabel}
            </span>
          </div>

          <div className="relative rounded-md overflow-hidden border border-slate-800 bg-slate-950 aspect-video mb-4 flex items-center justify-center">
            <video
              ref={previewVideoRef}
              playsInline
              muted
              data-testid="outgoing-preview-video"
              className={`absolute inset-0 w-full h-full object-contain ${busy ? '' : 'invisible'}`}
            />

            {!busy && (
              <div className="relative text-center p-6 max-w-md">
                <Tv className="w-9 h-9 text-slate-600 mx-auto mb-2.5" />
                {receivers.length === 0 ? (
                  <>
                    <p className="text-sm font-medium text-slate-200">Connect a TV</p>
                    <p className="text-xs text-slate-400 mt-1">
                      On your TV (or any phone, tablet or laptop on the same Wi-Fi), open this link in the web browser:
                    </p>
                    {tvUrl ? (
                      <div className="mt-3 flex items-center justify-center gap-2">
                        <code className="text-sm text-sky-300 bg-slate-900 border border-slate-800 rounded px-2.5 py-1.5" data-testid="tv-url">
                          {tvUrl}
                        </code>
                        <button
                          type="button"
                          onClick={copyTvUrl}
                          aria-label="Copy TV link"
                          className="p-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200"
                        >
                          {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                    ) : (
                      <p className="text-xs text-amber-300 mt-2">
                        This PC has no network address. Connect it to Wi-Fi or Ethernet.
                      </p>
                    )}
                  </>
                ) : (
                  <>
                    <p className="text-sm font-medium text-slate-200">{selectedReceiver?.name} is ready</p>
                    <p className="text-xs text-slate-400 mt-1">
                      Press <strong className="text-slate-200">Cast Screen to TV</strong>, or send the test pattern first to check the connection.
                    </p>
                  </>
                )}
              </div>
            )}

            {busy && (
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent px-4 py-2.5 flex items-center justify-between text-xs font-mono text-slate-300">
                <span>Outgoing preview</span>
                <span>
                  {senderStats?.width ? `${senderStats.width}x${senderStats.height} @ ${show(senderStats.fps)}fps` : 'starting…'}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Live measurements (from getStats on both ends) */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 pt-4 border-t border-slate-800/80 text-xs" data-testid="live-stats">
          <div>
            <span className="text-slate-400 block">Encoder</span>
            <span className="font-mono text-slate-200 font-medium block mt-0.5 truncate" title={senderStats?.encoder ?? ''}>
              {senderStats
                ? `${show(senderStats.codec)} · ${encoderName(senderStats.encoder)}${
                    senderStats.hardwareEncoder === true ? ' · hardware' : senderStats.hardwareEncoder === false ? ' · software' : ''
                  }`
                : '—'}
            </span>
          </div>
          <div>
            <span className="text-slate-400 block">Bitrate sent</span>
            <span className="font-mono text-slate-200 font-medium block mt-0.5" data-testid="live-bitrate">
              {senderStats ? show(senderStats.bitrateMbps, ' Mbps') : '—'}
              {senderStats?.qualityLimitation && senderStats.qualityLimitation !== 'none' && (
                <span className="text-amber-300"> · limited by {senderStats.qualityLimitation}</span>
              )}
            </span>
          </div>
          <div>
            <span className="text-slate-400 block">Network RTT / loss</span>
            <span className="font-mono text-slate-200 font-medium block mt-0.5">
              {senderStats ? `${show(senderStats.rttMs, ' ms')} / ${show(senderStats.packetLossPercent, '%')}` : '—'}
            </span>
          </div>
          <div>
            <span className="text-slate-400 block">TV decoder</span>
            <span
              className="font-mono text-slate-200 font-medium block mt-0.5 truncate"
              title={tvStats ? `${tvStats.decoder ?? 'decoder name hidden by browser'} · ${tvStats.browser ?? 'browser unknown'}` : ''}
            >
              {tvStats ? `${show(tvStats.codec)} · ${tvStats.decoder ?? tvStats.browser ?? 'name hidden'}` : '—'}
            </span>
          </div>
          <div>
            <span className="text-slate-400 block">TV playback</span>
            <span className="font-mono text-slate-200 font-medium block mt-0.5" data-testid="tv-playback-stats">
              {tvStats?.width ? `${tvStats.width}x${tvStats.height} @ ${show(tvStats.fps)}fps` : '—'}
            </span>
          </div>
          <div>
            <span className="text-slate-400 block">TV buffer / decode</span>
            <span className="font-mono text-slate-200 font-medium block mt-0.5">
              {tvStats ? `${show(tvStats.jitterBufferMs, ' ms')} / ${show(tvStats.decodeMs, ' ms')}` : '—'}
            </span>
          </div>
          <div>
            <span className="text-slate-400 block">TV frames decoded / received</span>
            <span className="font-mono text-slate-200 font-medium block mt-0.5" data-testid="tv-frames">
              {tvStats ? `${show(tvStats.framesDecoded)} / ${show(tvStats.framesReceived)}` : '—'}
            </span>
          </div>
          <div>
            <span className="text-slate-400 block">TV freezes / keyframe requests</span>
            <span className="font-mono text-slate-200 font-medium block mt-0.5">
              {tvStats ? `${show(tvStats.freezeCount)} / ${show(tvStats.pliCount)}` : '—'}
            </span>
          </div>
          <div>
            <span className="text-slate-400 block">TV browser</span>
            <span className="font-mono text-slate-200 font-medium block mt-0.5">{tvStats ? show(tvStats.browser) : '—'}</span>
          </div>
        </div>
        {busy && sizeNote && (
          <p className="mt-3 text-xs text-slate-400" data-testid="tv-size-note">
            {sizeNote}
          </p>
        )}
      </div>
    </section>
  );
};
