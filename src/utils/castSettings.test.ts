import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, effectiveFps, parseSettings } from './castSettings';

test('missing or broken saved settings fall back to the defaults', () => {
  assert.deepEqual(parseSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(parseSettings('nonsense'), DEFAULT_SETTINGS);
  assert.deepEqual(
    parseSettings({ codec: 'MPEG2', targetFps: 75, quality: 'ultra', degradationPreference: 'x', audio: { enabled: 'yes' } }),
    DEFAULT_SETTINGS
  );
});

test('valid saved settings are kept', () => {
  const saved = {
    codec: 'AV1',
    targetFps: 120,
    quality: 'low',
    degradationPreference: 'balanced',
    audio: { enabled: false, lipSyncLock: false }
  };
  assert.deepEqual(parseSettings(saved), saved);
});

test('the frame rate never exceeds what the TV shows', () => {
  const at120 = { ...DEFAULT_SETTINGS, targetFps: 120 as const };
  assert.equal(effectiveFps(at120, 60), 60);
  assert.equal(effectiveFps(at120, 120), 120);
  assert.equal(effectiveFps(at120, undefined), 60, 'unknown TVs are treated as 60 Hz');
  assert.equal(effectiveFps({ ...DEFAULT_SETTINGS, targetFps: 30 }, 120), 30);
});
