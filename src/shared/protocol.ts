/**
 * Uv Link signaling protocol shared by server.ts and the browser.
 *
 * Flow: a TV page (/?mode=tv) says `hello` as role "tv" and shows up in every
 * sender's receiver list. A sender then sends `webrtc:offer` to that TV's id;
 * the server relays offer / answer / ICE between exactly those two peers.
 * Media itself never touches the server — it flows peer-to-peer on the LAN.
 */

export type ReceiverStatus = 'idle' | 'streaming';

/** A TV (or any browser) that currently has /?mode=tv open. */
export interface LiveReceiver {
  id: string;
  name: string;
  /** Short device label derived from the TV browser's user agent. */
  device: string;
  /** Address the TV connected to the server from. */
  ip: string;
  status: ReceiverStatus;
  connectedAt: number;
}

export type PacketDirection = 'TV → Server' | 'Sender → TV' | 'TV → Sender' | 'Server';

export interface PacketLogItem {
  id: string;
  timestamp: string;
  direction: PacketDirection;
  type: string;
  summary: string;
  payloadSize: number;
}

/** Decode-side measurements the TV reports back to the sender once per second. */
export interface TvStatsReport {
  fps: number | null;
  width: number | null;
  height: number | null;
  bitrateMbps: number | null;
  /** Average time frames waited in the jitter buffer over the last interval. */
  jitterBufferMs: number | null;
  /** Average decode time per frame over the last interval. */
  decodeMs: number | null;
  framesDropped: number | null;
  packetsLost: number | null;
  decoder: string | null;
  /** Video codec being received, e.g. "H264", "VP8". */
  codec: string | null;
  /** Complete frames received and frames decoded since the stream started. */
  framesReceived: number | null;
  framesDecoded: number | null;
  keyFramesDecoded: number | null;
  /** Times the picture froze, by the browser's own freeze detection. */
  freezeCount: number | null;
  /** Keyframe requests the TV sent to recover. */
  pliCount: number | null;
  /** The TV's browser engine, e.g. "Chrome 91". */
  browser: string | null;
}

/** Messages a browser sends to the server. `to` is a TV id (from senders) or a sender client id (from TVs). */
export type ClientMessage =
  | { type: 'hello'; role: 'sender' }
  | { type: 'hello'; role: 'tv'; tvId: string; name: string; device: string }
  | { type: 'tv:rename'; name: string }
  | { type: 'webrtc:offer'; to: string; sdp: string }
  | { type: 'webrtc:answer'; to: string; sdp: string }
  | { type: 'webrtc:ice'; to: string; candidate: RTCIceCandidateInit }
  | { type: 'webrtc:stop'; to: string }
  | { type: 'tv:stats'; to: string; stats: TvStatsReport }
  /** The TV receives frames but its decoder produces none (e.g. a broken hardware H.264 decoder). */
  | { type: 'tv:decode-stalled'; to: string; codec: string | null; stats: TvStatsReport };

/** Messages the server sends to a browser. `from` is the sender client id (to TVs) or the TV id (to senders). */
export type ServerMessage =
  | {
      type: 'welcome';
      clientId: string;
      receiverId: string | null;
      lanUrls: string[];
      receivers: LiveReceiver[];
      packetLogs: PacketLogItem[];
    }
  | { type: 'receivers'; receivers: LiveReceiver[] }
  | { type: 'log'; entry: PacketLogItem }
  | { type: 'webrtc:offer'; from: string; sdp: string }
  | { type: 'webrtc:answer'; from: string; sdp: string }
  | { type: 'webrtc:ice'; from: string; candidate: RTCIceCandidateInit }
  | { type: 'webrtc:stop'; from: string }
  /** Sent to a sender when its cast can't continue (TV left, another PC took over, ...). */
  | { type: 'webrtc:ended'; receiverId: string; reason: string }
  | { type: 'tv:stats'; from: string; stats: TvStatsReport }
  | { type: 'tv:decode-stalled'; from: string; codec: string | null; stats: TvStatsReport };
