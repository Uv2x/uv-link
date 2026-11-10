import test from 'node:test';
import assert from 'node:assert/strict';
import { codecTryOrder } from './peer';

test('tries the preferred codec first, then VP8 and VP9', () => {
  assert.deepEqual(codecTryOrder('H264', []), ['H264', 'VP8', 'VP9']);
  assert.deepEqual(codecTryOrder('H265', []), ['H265', 'VP8', 'VP9', 'H264']);
});

test('skips codecs that already froze on this TV', () => {
  assert.deepEqual(codecTryOrder('H264', ['H264']), ['VP8', 'VP9']);
  assert.deepEqual(codecTryOrder('H264', ['h264', 'vp8']), ['VP9']);
  assert.deepEqual(codecTryOrder('H264', ['H264', 'VP8', 'VP9']), []);
});
