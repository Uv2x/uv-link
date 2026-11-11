import test from 'node:test';
import assert from 'node:assert/strict';
import { codecTryOrder, h264ProfileRank } from './peer';

test('offers the H.264 profiles Windows encodes in hardware first', () => {
  const main = h264ProfileRank('level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=4d001f');
  const baseline = h264ProfileRank('level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f');
  const constrained = h264ProfileRank('level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f');
  assert.ok(main > baseline && baseline > constrained && constrained > h264ProfileRank(undefined));
});

test('tries the preferred codec first, then VP8 and VP9', () => {
  assert.deepEqual(codecTryOrder('H264', []), ['H264', 'VP8', 'VP9']);
  assert.deepEqual(codecTryOrder('H265', []), ['H265', 'VP8', 'VP9', 'H264']);
});

test('skips codecs that already froze on this TV', () => {
  assert.deepEqual(codecTryOrder('H264', ['H264']), ['VP8', 'VP9']);
  assert.deepEqual(codecTryOrder('H264', ['h264', 'vp8']), ['VP9']);
  assert.deepEqual(codecTryOrder('H264', ['H264', 'VP8', 'VP9']), []);
});
