/**
 * Keeps the video within what the TV can decode in time.
 *
 * A TV that decodes in software (e.g. VP8 after its hardware H.264 decoder failed) can take
 * 60 ms per frame for a 3440x1440 picture: it falls behind, frames pile up for seconds, and
 * the sender's bandwidth estimate drops as if the network were congested. So:
 *  1. never send more than the TV shows: fit the picture into 1920x1080 (the TV browser's size);
 *  2. watch the TV's decode time per frame; when it doesn't fit the frame interval, shrink the
 *     picture further (down to `minWidth`), then halve the frame rate; grow back when there's room.
 */

export const TV_MAX_WIDTH = 1920;
export const TV_MAX_HEIGHT = 1080;

/** scaleResolutionDownBy that fits the source into maxWidth x maxHeight (never upscales). */
export function fitScale(sourceWidth: number, sourceHeight: number, maxWidth = TV_MAX_WIDTH, maxHeight = TV_MAX_HEIGHT): number {
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) return 1;
  return Math.max(1, sourceWidth / maxWidth, sourceHeight / maxHeight);
}

export interface DecodeLoadSample {
  /** Average decode time per frame on the TV over the last second. */
  decodeMs: number | null;
  /** Average time frames waited in the TV's buffer; large = a backlog is building. */
  jitterBufferMs: number | null;
}

export interface DecodeLoadDecision {
  /** Extra scaleResolutionDownBy on top of fitting into the TV (1 = none). */
  extraScale: number;
  /** Frame rate cap. */
  fps: number;
  /** Set when this sample changed the decision: why, in plain words. */
  change: string | null;
  /** The TV still can't keep up at the smallest size and 30 fps: this codec is too heavy for it. */
  exhausted: boolean;
}

export interface DecodeLoadOptions {
  targetFps: number;
  /** Width of the picture after fitting into the TV (extraScale 1). */
  fittedWidth: number;
  /** Don't go narrower than this; drop the frame rate instead. */
  minWidth?: number;
  /** Samples to wait after a change before judging again (stats lag behind). */
  cooldown?: number;
}

export function createDecodeLoadController(options: DecodeLoadOptions): (sample: DecodeLoadSample) => DecodeLoadDecision {
  const { targetFps, fittedWidth, minWidth = 960, cooldown = 4 } = options;
  const maxExtra = Math.max(1, fittedWidth / minWidth);
  let extraScale = 1;
  let fps = targetFps;
  let overloaded = 0;
  let roomy = 0;
  let wait = 0;

  const round = (v: number) => Math.round(v * 100) / 100;

  return ({ decodeMs, jitterBufferMs }) => {
    const unchanged = { extraScale, fps, change: null, exhausted: false };
    if (decodeMs === null) return unchanged;
    if (wait > 0) {
      wait--;
      return unchanged;
    }
    const frameMs = 1000 / fps;
    const backlog = (jitterBufferMs ?? 0) > 500 && decodeMs > 0.5 * frameMs;
    const tooSlow = decodeMs > 0.8 * frameMs || backlog;
    const hasRoom = decodeMs < 0.35 * frameMs && (jitterBufferMs ?? 0) < 80;
    overloaded = tooSlow ? overloaded + 1 : 0;
    roomy = hasRoom ? roomy + 1 : 0;

    if (overloaded >= 2) {
      overloaded = 0;
      roomy = 0;
      wait = cooldown;
      if (extraScale < maxExtra) {
        // Decode time grows with the pixel count, so shrink each side by sqrt of the overshoot.
        const step = Math.min(2, Math.max(1.25, Math.sqrt(decodeMs / (0.6 * frameMs))));
        extraScale = round(Math.min(maxExtra, extraScale * step));
        return { extraScale, fps, change: `the TV needed ${decodeMs} ms per frame`, exhausted: false };
      }
      if (fps > 30) {
        fps = Math.max(30, Math.round(fps / 2));
        return {
          extraScale,
          fps,
          change: `the TV needed ${decodeMs} ms per frame even at the lowest size`,
          exhausted: false
        };
      }
      return { ...unchanged, exhausted: true };
    }

    if (roomy >= 10) {
      roomy = 0;
      wait = cooldown;
      if (fps < targetFps) {
        fps = targetFps;
        return { extraScale, fps, change: 'the TV has room again', exhausted: false };
      }
      if (extraScale > 1) {
        extraScale = round(Math.max(1, extraScale / 1.25));
        return { extraScale, fps, change: 'the TV has room again', exhausted: false };
      }
    }
    return unchanged;
  };
}
