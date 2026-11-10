/** Small RTCPeerConnection helpers shared by the PC sender and the TV receiver. */

/**
 * Candidates can arrive over signaling before the remote description is set;
 * addIceCandidate() would reject them then, so they wait in `queue`.
 */
export async function addOrQueueIceCandidate(
  pc: RTCPeerConnection,
  queue: RTCIceCandidateInit[],
  candidate: RTCIceCandidateInit
): Promise<void> {
  if (!pc.remoteDescription) {
    queue.push(candidate);
    return;
  }
  try {
    await pc.addIceCandidate(candidate);
  } catch (err) {
    // One bad candidate (e.g. an unresolvable .local name) is normal; ICE keeps trying the others.
    console.warn('Uv Link: ignored ICE candidate', err);
  }
}

export async function flushQueuedIceCandidates(
  pc: RTCPeerConnection,
  queue: RTCIceCandidateInit[]
): Promise<void> {
  for (const candidate of queue.splice(0)) {
    try {
      await pc.addIceCandidate(candidate);
    } catch (err) {
      console.warn('Uv Link: ignored ICE candidate', err);
    }
  }
}

export type VideoCodecName = 'H264' | 'H265' | 'VP8' | 'VP9' | 'AV1';

/**
 * Codecs to try for a TV, best first: the preferred one (hardware-decoded on most TVs), then
 * VP8 and VP9, which browsers can always decode in software. On Android, WebRTC decodes H.264
 * only in hardware, so a TV with a broken H.264 decoder freezes until another codec is used.
 * Codecs that already failed on this TV are left out.
 */
export function codecTryOrder(preferred: VideoCodecName, failed: readonly string[]): VideoCodecName[] {
  const failedSet = new Set(failed.map((c) => c.toUpperCase()));
  const order: VideoCodecName[] = [preferred, 'VP8', 'VP9', 'H264'];
  return order.filter((codec, i) => order.indexOf(codec) === i && !failedSet.has(codec));
}

const MEDIA_CODECS = new Set(['h264', 'h265', 'vp8', 'vp9', 'av1']);

/**
 * Puts `codec` first in the transceiver's preference list (H.264: constrained baseline with
 * packetization-mode=1 first, which TV hardware decoders handle best) and removes the codecs in
 * `exclude`, so the TV can't pick them. Returns false when the browser can't do this.
 */
export function preferVideoCodec(
  transceiver: RTCRtpTransceiver,
  codec: VideoCodecName,
  exclude: readonly string[] = []
): boolean {
  if (typeof transceiver.setCodecPreferences !== 'function') return false;
  const mime = `video/${codec}`.toLowerCase();
  const excluded = new Set(exclude.map((c) => `video/${c}`.toLowerCase()));
  const score = (c: RTCRtpCodec): number => {
    if (c.mimeType.toLowerCase() !== mime) return 0;
    const fmtp = c.sdpFmtpLine ?? '';
    if (codec === 'H264') return 1 + (fmtp.includes('packetization-mode=1') ? 2 : 0) + (fmtp.includes('42e01f') ? 1 : 0);
    if (codec === 'VP9') return 1 + (fmtp.includes('profile-id=0') || !fmtp ? 1 : 0);
    return 1;
  };

  // Browsers disagree on whether sender or receiver capabilities are valid here; try both.
  for (const source of [RTCRtpSender, RTCRtpReceiver]) {
    const codecs = source.getCapabilities?.('video')?.codecs;
    if (!codecs?.length) continue;
    const kept = codecs.filter((c) => !excluded.has(c.mimeType.toLowerCase()));
    const sorted = [...kept].sort((a, b) => score(b) - score(a));
    if (!sorted.some((c) => MEDIA_CODECS.has(c.mimeType.toLowerCase().replace('video/', '')))) return false;
    try {
      transceiver.setCodecPreferences(sorted);
      return true;
    } catch {
      // Try the other capability list.
    }
  }
  return false;
}

/** Ask the receiver to play frames as soon as they are decoded (no extra buffering). */
export function tuneReceiverForLowLatency(receiver: RTCRtpReceiver): void {
  const r = receiver as RTCRtpReceiver & {
    jitterBufferTarget?: number | null;
    playoutDelayHint?: number | null;
  };
  try {
    if ('jitterBufferTarget' in r) r.jitterBufferTarget = 0;
  } catch {
    // Not supported by this browser.
  }
  try {
    if ('playoutDelayHint' in r) r.playoutDelayHint = 0;
  } catch {
    // Not supported by this browser.
  }
}
