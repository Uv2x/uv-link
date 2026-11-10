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

/**
 * Puts `codec` first in the transceiver's preference list so TVs get a stream their
 * hardware decoder handles (H.264 constrained baseline, packetization-mode=1, first).
 * Leaves the browser's default order alone when the codec isn't available.
 */
export function preferVideoCodec(transceiver: RTCRtpTransceiver, codec: 'H264' | 'H265'): void {
  if (typeof transceiver.setCodecPreferences !== 'function') return;
  const mime = `video/${codec}`.toLowerCase();
  const score = (c: RTCRtpCodec): number => {
    if (c.mimeType.toLowerCase() !== mime) return 0;
    const fmtp = c.sdpFmtpLine ?? '';
    return 1 + (fmtp.includes('packetization-mode=1') ? 2 : 0) + (fmtp.includes('42e01f') ? 1 : 0);
  };

  // Browsers disagree on whether sender or receiver capabilities are valid here; try both.
  for (const source of [RTCRtpSender, RTCRtpReceiver]) {
    const codecs = source.getCapabilities?.('video')?.codecs;
    if (!codecs?.length) continue;
    const sorted = [...codecs].sort((a, b) => score(b) - score(a));
    if (score(sorted[0]) === 0) return;
    try {
      transceiver.setCodecPreferences(sorted);
      return;
    } catch {
      // Try the other capability list.
    }
  }
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
