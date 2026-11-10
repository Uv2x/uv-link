import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mungeZeroLatencySdp,
  calculateLatencyBudget,
  computeAdaptiveBitrateDecision,
  evaluateNetworkQualityIndicator,
  calculateAvSyncState,
  ZeroLatencyParameters
} from './webrtcConfig';

const defaultLowLatencyParams: ZeroLatencyParameters = {
  codec: 'H264_42e01f',
  targetFps: 60,
  baseResolution: '1920x1080',
  degradationPreference: 'maintain-framerate',
  zeroPlayoutDelay: true,
  disableBFrames: true,
  forceHardwareEncoder: true,
  minBitrateKbps: 15000,
  maxBitrateKbps: 35000,
  startBitrateKbps: 25000,
  packetLossPercent: 0,
  estimatedBandwidthMbps: 42,
  networkMode: 'Wi-Fi 6 (5GHz/6GHz 160MHz)',
  audio: {
    enabled: true,
    codec: 'Opus_48kHz_Stereo',
    sampleRateHz: 48000,
    channels: 2,
    bitrateKbps: 256,
    ptimeMs: 10,
    hardwareAudioTrackLowLatency: true,
    lipSyncLock: true
  }
};

test('calculateLatencyBudget achieves <20ms with zero playout delay, no B-frames, and HW acceleration', () => {
  const budget = calculateLatencyBudget(defaultLowLatencyParams);
  assert.equal(budget.meetsSub20msTarget, true);
  assert.ok(budget.totalEndToEndMs < 20, `Expected <20ms, got ${budget.totalEndToEndMs}ms`);
  assert.equal(budget.jitterBufferMs, 0.4);
  assert.equal(budget.effectiveResolution, '1920x1080');
  assert.equal(budget.effectiveFps, 60);
});

test('Adaptive Bitrate (ABR) scales down resolution while locking 60fps during bandwidth drop and packet loss', () => {
  const degraded = computeAdaptiveBitrateDecision({
    ...defaultLowLatencyParams,
    estimatedBandwidthMbps: 12,
    packetLossPercent: 3,
    degradationPreference: 'maintain-framerate'
  });
  assert.equal(degraded.effectiveFps, 60);
  assert.equal(degraded.scaleResolutionDownBy, 1.5);
  assert.equal(degraded.effectiveResolution, '1280x720');
  assert.ok(degraded.targetBitrateMbps <= 12);

  const severe = computeAdaptiveBitrateDecision({
    ...defaultLowLatencyParams,
    estimatedBandwidthMbps: 7,
    packetLossPercent: 6,
    degradationPreference: 'maintain-framerate'
  });
  assert.equal(severe.effectiveFps, 60);
  assert.equal(severe.scaleResolutionDownBy, 2.0);
  assert.equal(severe.effectiveResolution, '960x540');
});

test('evaluateNetworkQualityIndicator reports accurate signal bars and grade across network conditions', () => {
  const excellent = evaluateNetworkQualityIndicator(defaultLowLatencyParams, 13.6, 2.6);
  assert.equal(excellent.grade, 'Excellent');
  assert.equal(excellent.signalBars, 4);

  const degraded = evaluateNetworkQualityIndicator(
    {
      ...defaultLowLatencyParams,
      estimatedBandwidthMbps: 8,
      packetLossPercent: 6
    },
    24.5,
    6.2
  );
  assert.equal(degraded.grade, 'Degraded');
  assert.equal(degraded.signalBars, 1);
});

test('calculateAvSyncState locks audio and video pipelines within 5ms lip-sync tolerance', () => {
  const sync = calculateAvSyncState(defaultLowLatencyParams, 13.6, 2.6);
  assert.equal(sync.audioEnabled, true);
  assert.equal(sync.isSynchronized, true);
  assert.ok(Math.abs(sync.avSyncOffsetMs) <= 5.0);
});

test('mungeZeroLatencySdp injects playout-delay=0 0, bframes=0, ABR start bitrate, and Opus 10ms stereo flags', () => {
  const sampleOffer = [
    'v=0',
    'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'm=video 9 UDP/TLS/RTP/SAVPF 96',
    'a=rtpmap:96 H264/90000'
  ].join('\r\n');

  const munged = mungeZeroLatencySdp(sampleOffer, defaultLowLatencyParams);
  assert.ok(
    munged.includes('http://www.webrtc.org/experiments/rtp-hdrext/playout-delay'),
    'Must inject playout-delay RTP extension URI'
  );
  assert.ok(munged.includes('a=playout-delay:0 0'), 'Must set min/max playout delay to 0');
  assert.ok(munged.includes('profile-level-id=42e01f'), 'Must enforce H.264 Constrained Baseline');
  assert.ok(munged.includes('bframes=0'), 'Must disable B-frames');
  assert.ok(munged.includes('ptime=10;stereo=1'), 'Must configure 10ms low-latency stereo Opus audio');
});
