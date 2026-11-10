import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecodeWatchdog, type DecodeProgress } from './decodeWatchdog';

const at = (seconds: number, framesReceived: number | null, framesDecoded: number | null, bytesReceived: number | null = null): DecodeProgress => ({
  timestampMs: seconds * 1000,
  framesReceived,
  framesDecoded,
  bytesReceived
});

test('reports a stall when frames arrive for 4 s and none are decoded', () => {
  const stalled = createDecodeWatchdog();
  // The first frame decoded, then the decoder stopped while 60 fps kept arriving.
  const results = [0, 1, 2, 3, 4, 5].map((s) => stalled(at(s, 1 + s * 60, 1)));
  assert.deepEqual(results, [false, false, false, false, true, true]);
});

test('a healthy stream never stalls', () => {
  const stalled = createDecodeWatchdog();
  for (let s = 0; s < 20; s++) assert.equal(stalled(at(s, s * 60, s * 60)), false);
});

test('a static screen (few frames, all decoded or none sent) is not a stall', () => {
  const stalled = createDecodeWatchdog();
  for (let s = 0; s < 20; s++) assert.equal(stalled(at(s, 3 + Math.floor(s / 5), 3 + Math.floor(s / 5))), false);
  const idle = createDecodeWatchdog();
  for (let s = 0; s < 20; s++) assert.equal(idle(at(s, 5, 5)), false, 'nothing new arrived');
});

test('recovers: decoding again resets the verdict', () => {
  const stalled = createDecodeWatchdog();
  for (let s = 0; s <= 4; s++) stalled(at(s, s * 60, 0));
  assert.equal(stalled(at(5, 300, 0)), true);
  assert.equal(stalled(at(6, 360, 30)), false);
});

test('falls back to bytes when the browser has no framesReceived', () => {
  const stalled = createDecodeWatchdog();
  const results = [0, 1, 2, 3, 4].map((s) => stalled(at(s, null, 1, s * 100_000)));
  assert.deepEqual(results, [false, false, false, false, true]);
});

test('needs decode counters to judge', () => {
  const stalled = createDecodeWatchdog();
  for (let s = 0; s < 10; s++) assert.equal(stalled(at(s, s * 60, null)), false);
});
