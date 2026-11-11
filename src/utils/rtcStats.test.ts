import test from 'node:test';
import assert from 'node:assert/strict';
import { browserLabel, createSenderStatsSampler, createTvStatsSampler, estimateGlassToGlassMs } from './rtcStats';

const report = (...stats: Array<Record<string, unknown>>) => new Map(stats.map((s) => [s.id as string, s]));

test('sender sampler computes bitrate, encode time, RTT, loss and codec from consecutive reports', () => {
  const sample = createSenderStatsSampler();
  const shared = [
    { id: 'T1', type: 'transport', timestamp: 0, selectedCandidatePairId: 'CP1' },
    { id: 'CP1', type: 'candidate-pair', timestamp: 0, currentRoundTripTime: 0.004, availableOutgoingBitrate: 48_000_000 },
    { id: 'RI1', type: 'remote-inbound-rtp', kind: 'video', timestamp: 0, fractionLost: 0.01 },
    { id: 'C1', type: 'codec', timestamp: 0, mimeType: 'video/H264' }
  ];

  const first = sample(
    report(...shared, {
      id: 'O1', type: 'outbound-rtp', kind: 'video', timestamp: 1000, codecId: 'C1',
      bytesSent: 0, framesEncoded: 0, totalEncodeTime: 0, framesPerSecond: 60,
      frameWidth: 1920, frameHeight: 1080, encoderImplementation: 'NVIDIA', qualityLimitationReason: 'none'
    })
  );
  assert.equal(first.bitrateMbps, null, 'no rate on the first sample');
  assert.equal(first.encodeMs, null);
  assert.equal(first.rttMs, 4);
  assert.equal(first.packetLossPercent, 1);
  assert.equal(first.availableOutgoingMbps, 48);
  assert.equal(first.codec, 'H264');
  assert.equal(first.encoder, 'NVIDIA');

  const second = sample(
    report(...shared, {
      id: 'O1', type: 'outbound-rtp', kind: 'video', timestamp: 2000, codecId: 'C1',
      bytesSent: 2_500_000, framesEncoded: 60, totalEncodeTime: 0.18, framesPerSecond: 60,
      frameWidth: 1920, frameHeight: 1080
    })
  );
  assert.equal(second.bitrateMbps, 20, '2.5 MB in 1 s = 20 Mbps');
  assert.equal(second.encodeMs, 3, '0.18 s over 60 frames = 3 ms/frame');
  assert.equal(second.width, 1920);
});

test('sender sampler falls back to the nominated succeeded pair when transport has no selection', () => {
  const sample = createSenderStatsSampler();
  const result = sample(
    report(
      { id: 'CPx', type: 'candidate-pair', timestamp: 0, nominated: false, state: 'in-progress', currentRoundTripTime: 0.5 },
      { id: 'CPy', type: 'candidate-pair', timestamp: 0, nominated: true, state: 'succeeded', currentRoundTripTime: 0.002 }
    )
  );
  assert.equal(result.rttMs, 2);
  assert.equal(result.fps, null, 'no outbound video yet');
});

test('TV sampler computes jitter buffer and decode time per frame', () => {
  const sample = createTvStatsSampler('Chrome 91');
  sample(
    report({
      id: 'I1', type: 'inbound-rtp', kind: 'video', timestamp: 1000, bytesReceived: 0,
      jitterBufferDelay: 1.0, jitterBufferEmittedCount: 100, totalDecodeTime: 0.5, framesDecoded: 100
    })
  );
  const tv = sample(
    report(
      {
        id: 'I1', type: 'inbound-rtp', kind: 'video', timestamp: 2000, bytesReceived: 1_250_000, codecId: 'C1',
        jitterBufferDelay: 1.3, jitterBufferEmittedCount: 160, totalDecodeTime: 0.62, framesDecoded: 160,
        framesReceived: 170, keyFramesDecoded: 1, freezeCount: 3, pliCount: 4,
        framesPerSecond: 60, frameWidth: 1280, frameHeight: 720, framesDropped: 2, packetsLost: 5,
        decoderImplementation: 'ExternalDecoder'
      },
      { id: 'C1', type: 'codec', timestamp: 2000, mimeType: 'video/VP8' }
    )
  );
  assert.equal(tv.bitrateMbps, 10);
  assert.equal(tv.jitterBufferMs, 5, '0.3 s over 60 frames = 5 ms');
  assert.equal(tv.decodeMs, 2, '0.12 s over 60 frames = 2 ms');
  assert.equal(tv.framesDropped, 2);
  assert.equal(tv.decoder, 'ExternalDecoder');
  assert.equal(tv.codec, 'VP8');
  assert.equal(tv.framesReceived, 170);
  assert.equal(tv.framesDecoded, 160);
  assert.equal(tv.freezeCount, 3);
  assert.equal(tv.pliCount, 4);
  assert.equal(tv.browser, 'Chrome 91');
});

test('browserLabel names the engine and major version', () => {
  assert.equal(
    browserLabel('Mozilla/5.0 (Linux; Android 9; KONKA 4K Android TV Build/PPR1; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/91.0.4472.120 Mobile Safari/537.36 UvLinkTV/1.1.0'),
    'Chrome 91'
  );
  assert.equal(browserLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36 Edg/130.0'), 'Edge 130');
  assert.equal(browserLabel('Mozilla/5.0 (Macintosh) Version/17.4 Safari/605.1.15'), 'Safari 17');
  assert.equal(browserLabel('curl/8'), null);
});

test('estimateGlassToGlassMs adds measured parts plus one frame, or returns null when a part is missing', () => {
  const sender = {
    bitrateMbps: 20, fps: 60, width: 1920, height: 1080, rttMs: 4, availableOutgoingMbps: 48,
    packetLossPercent: 0, encodeMs: 3, encoder: 'NVIDIA', hardwareEncoder: true, codec: 'H264', qualityLimitation: 'none'
  };
  const tv = {
    fps: 60, width: 1920, height: 1080, bitrateMbps: 20, jitterBufferMs: 5, decodeMs: 2,
    framesDropped: 0, packetsLost: 0, decoder: 'ExternalDecoder', codec: 'H264', framesReceived: 600,
    framesDecoded: 600, keyFramesDecoded: 1, freezeCount: 0, pliCount: 0, browser: 'Chrome 130'
  };
  // 3 + 4/2 + 5 + 2 + 16.67 = 28.67
  assert.equal(estimateGlassToGlassMs(sender, tv), 28.7);
  assert.equal(estimateGlassToGlassMs(sender, null), null);
  assert.equal(estimateGlassToGlassMs({ ...sender, encodeMs: null }, tv), null);
});
