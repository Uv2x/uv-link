/**
 * Spots a TV whose video decoder has stopped: frames keep arriving, none get decoded.
 *
 * That is how a broken hardware decoder looks from WebRTC on Android, where H.264 has no
 * software fallback: the picture freezes on the last good frame while data keeps flowing.
 * The TV then asks the PC to switch to another codec (see LiveMirroringWorkbench).
 */

export interface DecodeProgress {
  timestampMs: number;
  framesReceived: number | null;
  framesDecoded: number | null;
  bytesReceived: number | null;
}

export interface DecodeWatchdogOptions {
  /** How long frames must arrive without any being decoded. */
  windowMs?: number;
  /** Frames that must arrive in that time (a static screen sends few; that's not a stall). */
  minFrames?: number;
  /** Used instead of frames when the browser doesn't report framesReceived. */
  minBytes?: number;
}

/** Returns a function to call with each stats sample; it answers true once decoding has stalled. */
export function createDecodeWatchdog(options: DecodeWatchdogOptions = {}): (sample: DecodeProgress) => boolean {
  const { windowMs = 4000, minFrames = 20, minBytes = 200_000 } = options;
  const history: DecodeProgress[] = [];

  const delta = (now: number | null, before: number | null): number | null =>
    now === null || before === null || now < before ? null : now - before;

  return (sample) => {
    history.push(sample);
    // Keep the newest sample that is still at least `windowMs` old as the reference point.
    while (history.length > 2 && sample.timestampMs - history[1].timestampMs >= windowMs) history.shift();
    const reference = history[0];
    if (sample.timestampMs - reference.timestampMs < windowMs) return false;

    const decoded = delta(sample.framesDecoded, reference.framesDecoded);
    if (decoded === null || decoded > 0) return false;
    const received = delta(sample.framesReceived, reference.framesReceived);
    if (received !== null) return received >= minFrames;
    const bytes = delta(sample.bytesReceived, reference.bytesReceived);
    return bytes !== null && bytes >= minBytes;
  };
}
