import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Tv, Minimize2, Wifi, WifiOff, Volume2, Pencil, Check, X } from 'lucide-react';
import type { ServerMessage } from '../shared/protocol';
import { SignalingClient } from '../utils/signalingClient';
import { createTvStatsSampler } from '../utils/rtcStats';
import { addOrQueueIceCandidate, flushQueuedIceCandidates, tuneReceiverForLowLatency } from '../utils/peer';

const TV_ID_KEY = 'uvlink.tvId';
const TV_NAME_KEY = 'uvlink.tvName';
const HUD_HIDE_MS = 4000;

function readStorage(getStorage: () => Storage, key: string): string | null {
  try {
    return getStorage().getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(getStorage: () => Storage, key: string, value: string): void {
  try {
    getStorage().setItem(key, value);
  } catch {
    // Private mode / blocked storage: the name just won't be remembered.
  }
}

export function describeDevice(userAgent: string = navigator.userAgent): string {
  if (/Android TV|GoogleTV|AFT\w|BRAVIA|SHIELD|SmartTV|SMART-TV|Tizen|Web0S|webOS|HbbTV|CrKey/i.test(userAgent)) return 'Smart TV';
  if (/iPhone|iPad|iPod/i.test(userAgent)) return 'iPhone / iPad';
  if (/Android/i.test(userAgent)) return 'Android';
  if (/Windows/i.test(userAgent)) return 'Windows PC';
  if (/Macintosh|Mac OS X/i.test(userAgent)) return 'Mac';
  if (/CrOS/i.test(userAgent)) return 'Chromebook';
  if (/Linux/i.test(userAgent)) return 'Linux';
  return 'Browser';
}

/** Per-tab id: survives reloads (so the PC keeps it selected) but differs between tabs. */
function getOrCreateTvId(): string {
  const existing = readStorage(() => sessionStorage, TV_ID_KEY);
  if (existing) return existing;
  const id = `tv-${Math.random().toString(36).slice(2, 10)}`;
  writeStorage(() => sessionStorage, TV_ID_KEY, id);
  return id;
}

interface TvSession {
  pc: RTCPeerConnection;
  senderId: string;
  pendingIce: RTCIceCandidateInit[];
  statsTimer: number | null;
  /** All received tracks. Audio may arrive in its own stream (lip sync off), so they're merged here for playback. */
  media: MediaStream;
  playbackStarted: boolean;
}

type TvPhase = 'waiting' | 'connecting' | 'playing';

interface TvReceiverScreenProps {
  onExit: () => void;
}

export const TvReceiverScreen: React.FC<TvReceiverScreenProps> = ({ onExit }) => {
  // The Android TV app opens /?mode=tv&app=android&device=Android%20TV&name=<TV model>.
  const [query] = useState(() => new URLSearchParams(window.location.search));
  const inTvApp = query.get('app') === 'android';
  const [tvId] = useState(getOrCreateTvId);
  const [device] = useState(() => query.get('device')?.slice(0, 40) || describeDevice());
  const [name, setName] = useState(
    () =>
      readStorage(() => localStorage, TV_NAME_KEY) ||
      query.get('name')?.trim().slice(0, 60) ||
      `${device} · ${tvId.slice(-4).toUpperCase()}`
  );
  const [serverConnected, setServerConnected] = useState(false);
  const [phase, setPhase] = useState<TvPhase>('waiting');
  const [notice, setNotice] = useState('');
  const [needsSoundPress, setNeedsSoundPress] = useState(false);
  const [hudVisible, setHudVisible] = useState(true);
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(name);
  const [liveInfo, setLiveInfo] = useState<{ fps: number | null; width: number | null; height: number | null } | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const clientRef = useRef<SignalingClient | null>(null);
  const sessionRef = useRef<TvSession | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const nameRef = useRef(name);

  useEffect(() => {
    nameRef.current = name;
  }, [name]);

  const teardown = useCallback(() => {
    const session = sessionRef.current;
    sessionRef.current = null;
    if (!session) return;
    if (session.statsTimer !== null) window.clearInterval(session.statsTimer);
    session.pc.ontrack = null;
    session.pc.onicecandidate = null;
    session.pc.onconnectionstatechange = null;
    session.pc.close();
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const endSession = useCallback(
    (message: string) => {
      teardown();
      setPhase('waiting');
      setNeedsSoundPress(false);
      setLiveInfo(null);
      setNotice(message);
    },
    [teardown]
  );

  const startPlayback = useCallback((stream: MediaStream) => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    video.muted = false;
    video
      .play()
      .then(() => setNeedsSoundPress(false))
      .catch(() => {
        // Browsers only allow sound after the viewer interacts with the page:
        // start muted now and ask for one button press.
        video.muted = true;
        setNeedsSoundPress(stream.getAudioTracks().length > 0);
        video.play().catch(() => {});
      });
  }, []);

  const acceptOffer = useCallback(
    async (senderId: string, sdp: string) => {
      const client = clientRef.current;
      if (!client) return;
      teardown();
      setNotice('');
      setPhase('connecting');

      const pc = new RTCPeerConnection({ iceServers: [] });
      const session: TvSession = {
        pc,
        senderId,
        pendingIce: [],
        statsTimer: null,
        media: new MediaStream(),
        playbackStarted: false
      };
      sessionRef.current = session;

      pc.ontrack = (event) => {
        tuneReceiverForLowLatency(event.receiver);
        session.media.addTrack(event.track);
        if (session.playbackStarted) return;
        session.playbackStarted = true;
        startPlayback(session.media);
      };
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          client.send({ type: 'webrtc:ice', to: senderId, candidate: event.candidate.toJSON() });
        }
      };
      pc.onconnectionstatechange = () => {
        if (sessionRef.current !== session) return;
        if (pc.connectionState === 'connected') setPhase('playing');
        else if (pc.connectionState === 'failed') endSession('Lost the connection to the PC.');
      };

      try {
        await pc.setRemoteDescription({ type: 'offer', sdp });
        await flushQueuedIceCandidates(pc, session.pendingIce);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        if (sessionRef.current !== session) return;
        client.send({ type: 'webrtc:answer', to: senderId, sdp: answer.sdp ?? '' });
      } catch (err) {
        if (sessionRef.current === session) {
          endSession(`Could not start the stream: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }

      const sample = createTvStatsSampler();
      session.statsTimer = window.setInterval(async () => {
        if (sessionRef.current !== session) return;
        try {
          const stats = sample(await pc.getStats());
          setLiveInfo({ fps: stats.fps, width: stats.width, height: stats.height });
          client.send({ type: 'tv:stats', to: senderId, stats });
        } catch {
          // The connection closed between ticks; teardown clears this timer.
        }
      }, 1000);
    },
    [teardown, endSession, startPlayback]
  );

  useEffect(() => {
    const client = new SignalingClient(() => ({
      type: 'hello',
      role: 'tv',
      tvId,
      name: nameRef.current,
      device
    }));
    clientRef.current = client;

    const offStatus = client.onStatus(setServerConnected);
    const offMessages = client.subscribe((msg: ServerMessage) => {
      const session = sessionRef.current;
      if (msg.type === 'webrtc:offer') {
        void acceptOffer(msg.from, msg.sdp);
      } else if (msg.type === 'webrtc:ice') {
        if (session && session.senderId === msg.from) {
          void addOrQueueIceCandidate(session.pc, session.pendingIce, msg.candidate);
        }
      } else if (msg.type === 'webrtc:stop') {
        if (session && session.senderId === msg.from) endSession('The PC stopped casting.');
      }
    });
    client.connect();

    return () => {
      offMessages();
      offStatus();
      teardown();
      client.close();
      clientRef.current = null;
    };
  }, [tvId, device, acceptOffer, endSession, teardown]);

  // Show the HUD on any activity; hide it again while video is playing.
  const pokeHud = useCallback(() => {
    setHudVisible(true);
    if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => setHudVisible(false), HUD_HIDE_MS);
  }, []);

  useEffect(() => {
    if (phase === 'playing') pokeHud();
    else setHudVisible(true);
  }, [phase, pokeHud]);

  useEffect(
    () => () => {
      if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
    },
    []
  );

  /** A click or remote-control OK press: turn sound on and go fullscreen. */
  const handleViewerGesture = useCallback(() => {
    pokeHud();
    const video = videoRef.current;
    if (video && needsSoundPress) {
      video.muted = false;
      video
        .play()
        .then(() => setNeedsSoundPress(false))
        .catch(() => {
          video.muted = true;
        });
    }
    if (phase === 'playing' && !document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    }
  }, [needsSoundPress, phase, pokeHud]);

  useEffect(() => {
    if (editingName) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'MediaPlayPause') {
        handleViewerGesture();
      } else {
        pokeHud();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editingName, handleViewerGesture, pokeHud]);

  const saveName = () => {
    const next = draftName.trim().replace(/\s+/g, ' ').slice(0, 60);
    if (next) {
      setName(next);
      writeStorage(() => localStorage, TV_NAME_KEY, next);
      clientRef.current?.send({ type: 'tv:rename', name: next });
    }
    setEditingName(false);
  };

  const exit = () => {
    teardown();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    onExit();
  };

  const showHud = hudVisible || phase !== 'playing';

  return (
    <div
      className={`fixed inset-0 bg-black text-slate-100 overflow-hidden select-none ${showHud ? '' : 'cursor-none'}`}
      onMouseMove={pokeHud}
      onClick={handleViewerGesture}
      data-testid="tv-receiver-screen"
    >
      <video
        ref={videoRef}
        playsInline
        data-testid="tv-receiver-video"
        className={`absolute inset-0 w-full h-full object-contain bg-black ${phase === 'playing' ? '' : 'invisible'}`}
      />

      {/* Top bar */}
      <div
        className={`absolute inset-x-0 top-0 flex items-center justify-between gap-4 px-6 py-4 bg-gradient-to-b from-black/80 to-transparent transition-opacity duration-300 ${
          showHud ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        <div className="flex items-center gap-3 min-w-0">
          <Tv className="w-5 h-5 text-emerald-400 shrink-0" />
          <span className="text-base font-semibold font-display text-white truncate">{name}</span>
          <span
            data-testid="tv-server-status"
            className={`text-xs font-mono flex items-center gap-1.5 whitespace-nowrap ${
              serverConnected ? 'text-emerald-400' : 'text-amber-400'
            }`}
          >
            {serverConnected ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
            {serverConnected ? 'Visible to PCs on this network' : 'Connecting to Uv Link…'}
          </span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {phase === 'playing' && liveInfo?.width && (
            <span className="text-xs font-mono text-slate-300 tabular-nums" data-testid="tv-live-info">
              {liveInfo.width}x{liveInfo.height} @ {liveInfo.fps ?? '—'}fps
            </span>
          )}
          {!inTvApp && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                exit();
              }}
              className="px-3.5 py-1.5 text-xs font-medium bg-slate-900/90 hover:bg-slate-800 text-slate-200 rounded-md flex items-center gap-1.5"
            >
              <Minimize2 className="w-3.5 h-3.5" />
              Exit TV Mode
            </button>
          )}
        </div>
      </div>

      {/* Waiting / connecting screen */}
      {phase !== 'playing' && (
        <div className="absolute inset-0 flex items-center justify-center p-8">
          <div className="max-w-xl w-full text-center space-y-5">
            <Tv className="w-16 h-16 text-sky-400 mx-auto" />

            {editingName ? (
              <form
                className="flex items-center justify-center gap-2"
                onClick={(event) => event.stopPropagation()}
                onSubmit={(event) => {
                  event.preventDefault();
                  saveName();
                }}
              >
                <label htmlFor="tv-name-input" className="sr-only">
                  TV name
                </label>
                <input
                  id="tv-name-input"
                  autoFocus
                  value={draftName}
                  maxLength={60}
                  onChange={(event) => setDraftName(event.target.value)}
                  className="bg-slate-950 border border-slate-700 rounded-md px-3 py-2 text-lg text-white w-72 focus:outline-none focus:border-sky-500"
                />
                <button type="submit" aria-label="Save name" className="p-2 rounded-md bg-sky-500 text-slate-950 hover:bg-sky-400">
                  <Check className="w-5 h-5" />
                </button>
                <button
                  type="button"
                  aria-label="Cancel renaming"
                  onClick={() => setEditingName(false)}
                  className="p-2 rounded-md bg-slate-800 text-slate-200 hover:bg-slate-700"
                >
                  <X className="w-5 h-5" />
                </button>
              </form>
            ) : (
              <div className="flex items-center justify-center gap-2">
                <h1 className="text-3xl font-bold text-white">{name}</h1>
                <button
                  type="button"
                  aria-label="Rename this TV"
                  onClick={(event) => {
                    event.stopPropagation();
                    setDraftName(name);
                    setEditingName(true);
                  }}
                  className="p-1.5 rounded-md text-slate-400 hover:text-white hover:bg-slate-800"
                >
                  <Pencil className="w-4 h-4" />
                </button>
              </div>
            )}

            <p className="text-lg text-slate-300" data-testid="tv-phase">
              {!serverConnected
                ? 'Connecting to the Uv Link server…'
                : phase === 'connecting'
                  ? 'A PC is connecting…'
                  : 'Ready. Waiting for a PC to cast.'}
            </p>

            {notice && <p className="text-sm text-amber-300">{notice}</p>}

            <div className="p-4 rounded-lg bg-slate-950 border border-slate-800 text-sm text-slate-300 leading-relaxed">
              On your PC, open the <strong className="text-white">Uv Link</strong> app (or{' '}
              <code className="text-sky-300">http://localhost:3000</code>), pick{' '}
              <strong className="text-white">{name}</strong> and press{' '}
              <strong className="text-white">Cast Screen to TV</strong>.
            </div>
          </div>
        </div>
      )}

      {/* Sound prompt (browsers block autoplay with sound until the viewer interacts) */}
      {phase === 'playing' && needsSoundPress && (
        <div className="absolute inset-x-0 bottom-8 flex justify-center pointer-events-none">
          <div className="px-5 py-3 rounded-full bg-black/80 border border-slate-700 text-sm text-white flex items-center gap-2">
            <Volume2 className="w-4 h-4 text-sky-400" />
            Press OK or click to turn on sound
          </div>
        </div>
      )}
    </div>
  );
};
