import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecodeLoadController, fitScale } from './decodeLoad';

test('fits any screen into the TV picture without upscaling', () => {
  assert.equal(fitScale(3440, 1440).toFixed(3), (3440 / 1920).toFixed(3)); // ultrawide -> 1920x804
  assert.equal(fitScale(2560, 1600).toFixed(3), (1600 / 1080).toFixed(3)); // 16:10 -> 1728x1080
  assert.equal(fitScale(1920, 1080), 1);
  assert.equal(fitScale(960, 540), 1);
  assert.equal(fitScale(0, 0), 1);
});

test('a TV that decodes too slowly gets a smaller picture, then a lower frame rate', () => {
  const decide = createDecodeLoadController({ targetFps: 60, fittedWidth: 1920, cooldown: 2 });
  // 60 ms per frame at 60 fps (16.7 ms budget): the KONKA's software VP8 at 3440x1440.
  assert.equal(decide({ decodeMs: 60, jitterBufferMs: 11000 }).change, null, 'one bad second is not enough');
  const first = decide({ decodeMs: 60, jitterBufferMs: 11000 });
  assert.equal(first.extraScale, 2, 'halves each side (capped at 960 px wide)');
  assert.equal(first.fps, 60);
  assert.match(first.change ?? '', /60 ms per frame/);

  // Cooldown while the new size takes effect.
  assert.equal(decide({ decodeMs: 20, jitterBufferMs: 400 }).change, null);
  assert.equal(decide({ decodeMs: 20, jitterBufferMs: 400 }).change, null);
  // Still too slow at the smallest size: drop to 30 fps.
  decide({ decodeMs: 20, jitterBufferMs: 300 });
  const second = decide({ decodeMs: 20, jitterBufferMs: 300 });
  assert.equal(second.extraScale, 2);
  assert.equal(second.fps, 30);
  assert.equal(second.exhausted, false);

  // Still too slow at 960 px and 30 fps: give up on this codec.
  decide({ decodeMs: 40, jitterBufferMs: 300 });
  decide({ decodeMs: 40, jitterBufferMs: 300 });
  decide({ decodeMs: 40, jitterBufferMs: 300 });
  const last = decide({ decodeMs: 40, jitterBufferMs: 300 });
  assert.equal(last.exhausted, true);
  assert.equal(last.change, null);
});

test('a moderately slow TV shrinks by the square root of the overshoot', () => {
  const decide = createDecodeLoadController({ targetFps: 60, fittedWidth: 1920, cooldown: 0 });
  decide({ decodeMs: 30, jitterBufferMs: 50 });
  // 30 ms against a 10 ms goal (60% of 16.7 ms): 3x the pixels too many -> each side / sqrt(3).
  assert.equal(decide({ decodeMs: 30, jitterBufferMs: 50 }).extraScale, 1.73);
});

test('a growing backlog counts as too slow even when decode time looks borderline', () => {
  const decide = createDecodeLoadController({ targetFps: 60, fittedWidth: 1920, cooldown: 0 });
  decide({ decodeMs: 9, jitterBufferMs: 2000 });
  assert.equal(decide({ decodeMs: 9, jitterBufferMs: 2000 }).extraScale, 1.25);
});

test('recovers frame rate first, then size', () => {
  const decide = createDecodeLoadController({ targetFps: 60, fittedWidth: 1920, cooldown: 0 });
  for (let i = 0; i < 2; i++) decide({ decodeMs: 60, jitterBufferMs: 100 }); // -> extra 2
  for (let i = 0; i < 2; i++) decide({ decodeMs: 60, jitterBufferMs: 100 }); // -> 30 fps
  let state = decide({ decodeMs: 2, jitterBufferMs: 10 });
  for (let i = 0; i < 9; i++) state = decide({ decodeMs: 2, jitterBufferMs: 10 });
  assert.equal(state.fps, 60);
  assert.equal(state.extraScale, 2);
  for (let i = 0; i < 10; i++) state = decide({ decodeMs: 2, jitterBufferMs: 10 });
  assert.equal(state.extraScale, 1.6);
});

test('does nothing without decode measurements', () => {
  const decide = createDecodeLoadController({ targetFps: 60, fittedWidth: 1920 });
  for (let i = 0; i < 20; i++) {
    assert.deepEqual(decide({ decodeMs: null, jitterBufferMs: null }), { extraScale: 1, fps: 60, change: null, exhausted: false });
  }
});
