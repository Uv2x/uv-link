export type VideoCodecChoice = 'H264_42e01f' | 'HEVC_Main10';
export type NetworkTransportMode = 'Wi-Fi 6 (5GHz/6GHz 160MHz)' | 'Gigabit Ethernet LAN' | 'Congested 2.4GHz Wi-Fi';
export type DegradationPolicy = 'maintain-framerate' | 'maintain-resolution' | 'balanced';

export interface AudioStreamConfig {
  enabled: boolean;
  codec: 'Opus_48kHz_Stereo' | 'AAC_ELD_Hardware';
  sampleRateHz: 48000;
  channels: 2;
  bitrateKbps: 128 | 256 | 320;
  ptimeMs: 10 | 20;
  hardwareAudioTrackLowLatency: boolean;
  lipSyncLock: boolean;
}

export interface ZeroLatencyParameters {
  codec: VideoCodecChoice;
  targetFps: 60 | 120;
  baseResolution: '1920x1080' | '2560x1440' | '3840x2160';
  degradationPreference: DegradationPolicy;
  zeroPlayoutDelay: boolean;
  disableBFrames: boolean;
  forceHardwareEncoder: boolean;
  minBitrateKbps: number;
  maxBitrateKbps: number;
  startBitrateKbps: number;
  packetLossPercent: number;
  estimatedBandwidthMbps: number;
  networkMode: NetworkTransportMode;
  audio: AudioStreamConfig;
}

export interface AdaptiveBitrateDecision {
  targetBitrateKbps: number;
  targetBitrateMbps: number;
  scaleResolutionDownBy: number;
  effectiveResolution: string;
  effectiveFps: number;
  abrTierLabel: 'Ultra (Full Res @ 60fps+)' | 'High (1080p @ 60fps+)' | 'Adaptive Scale (810p @ 60fps+)' | 'Congestion Guard (720p @ 60fps+)';
  hwEncoderPipeline: string;
  hwDecoderPipeline: string;
  reason: string;
}

export interface NetworkQualityIndicator {
  grade: 'Excellent' | 'Good' | 'Fair' | 'Degraded';
  signalBars: 1 | 2 | 3 | 4;
  rssiDbm: number;
  estimatedBandwidthMbps: number;
  rttMs: number;
  endToEndLatencyMs: number;
  jitterMs: number;
  packetLossPercent: number;
  statusSummary: string;
}

export interface AvSyncTelemetry {
  audioEnabled: boolean;
  audioCodecDescriptor: string;
  audioBitrateKbps: number;
  audioPacketTimeMs: number;
  videoPipelineMs: number;
  audioPipelineMs: number;
  avSyncOffsetMs: number;
  isSynchronized: boolean;
  hwAudioPath: string;
}

export interface LatencyBudgetBreakdown {
  captureMs: number;
  encodeMs: number;
  networkRttHalfMs: number;
  jitterBufferMs: number;
  decodeMs: number;
  renderVsyncMs: number;
  totalEndToEndMs: number;
  meetsSub20msTarget: boolean;
  effectiveResolution: string;
  effectiveFps: number;
  scaleResolutionDownBy: number;
  abrDecision: AdaptiveBitrateDecision;
  networkQuality: NetworkQualityIndicator;
  avSync: AvSyncTelemetry;
}

/**
 * Computes the Adaptive Bitrate (ABR) controller decision based on real-time
 * estimated bandwidth, packet loss, and RTT, prioritizing 60fps+ over spatial resolution.
 */
export function computeAdaptiveBitrateDecision(params: ZeroLatencyParameters): AdaptiveBitrateDecision {
  const [baseW, baseH] = params.baseResolution.split('x').map(Number);
  const usableBwKbps = Math.max(
    2500,
    Math.round(params.estimatedBandwidthMbps * 1000 * (1 - params.packetLossPercent * 0.04))
  );

  // Clamp within configured [minBitrateKbps, maxBitrateKbps] while respecting available network capacity
  const targetBitrateKbps = Math.min(
    params.maxBitrateKbps,
    Math.max(3000, Math.min(usableBwKbps, params.maxBitrateKbps))
  );
  const targetBitrateMbps = Number((targetBitrateKbps / 1000).toFixed(1));

  let scaleResolutionDownBy = 1.0;
  let effectiveFps: number = params.targetFps;
  let abrTierLabel: AdaptiveBitrateDecision['abrTierLabel'] = 'Ultra (Full Res @ 60fps+)';
  let reason = 'Full LAN headroom available; locking native resolution and 60fps+ hardware encode.';

  const isDegraded =
    params.packetLossPercent >= 2 ||
    params.estimatedBandwidthMbps < 18 ||
    params.networkMode === 'Congested 2.4GHz Wi-Fi';

  const isSevere =
    params.packetLossPercent >= 5 ||
    params.estimatedBandwidthMbps < 10;

  if (isSevere) {
    if (params.degradationPreference === 'maintain-framerate') {
      scaleResolutionDownBy = 2.0;
      effectiveFps = params.targetFps;
      abrTierLabel = 'Congestion Guard (720p @ 60fps+)';
      reason = `Severe network drop (${params.estimatedBandwidthMbps} Mbps, ${params.packetLossPercent}% loss): ABR scaled resolution by 2.0x to preserve locked ${params.targetFps}fps.`;
    } else if (params.degradationPreference === 'maintain-resolution') {
      scaleResolutionDownBy = 1.0;
      effectiveFps = Math.max(24, Math.round(params.targetFps * 0.45));
      abrTierLabel = 'Congestion Guard (720p @ 60fps+)';
      reason = 'Resolution prioritized; frame rate reduced due to bandwidth saturation.';
    } else {
      scaleResolutionDownBy = 1.5;
      effectiveFps = Math.round(params.targetFps * 0.75);
      abrTierLabel = 'Adaptive Scale (810p @ 60fps+)';
      reason = 'Balanced ABR scaling applied across resolution and frame rate.';
    }
  } else if (isDegraded) {
    if (params.degradationPreference === 'maintain-framerate') {
      scaleResolutionDownBy = 1.5;
      effectiveFps = params.targetFps;
      abrTierLabel = 'Adaptive Scale (810p @ 60fps+)';
      reason = `Network contention detected (${params.estimatedBandwidthMbps} Mbps, ${params.packetLossPercent}% loss): ABR downscaled resolution by 1.5x to guarantee ${params.targetFps}fps fluidity.`;
    } else if (params.degradationPreference === 'maintain-resolution') {
      scaleResolutionDownBy = 1.0;
      effectiveFps = Math.max(30, Math.round(params.targetFps / 2));
      abrTierLabel = 'High (1080p @ 60fps+)';
      reason = 'Resolution locked; frame rate stepped down under moderate contention.';
    } else {
      scaleResolutionDownBy = 1.25;
      effectiveFps = Math.round(params.targetFps * 0.85);
      abrTierLabel = 'Adaptive Scale (810p @ 60fps+)';
      reason = 'Balanced ABR step-down active.';
    }
  } else if (targetBitrateMbps < 24) {
    abrTierLabel = 'High (1080p @ 60fps+)';
    reason = `Operating within optimal LAN envelope (${targetBitrateMbps} Mbps @ ${params.targetFps}fps).`;
  }

  // Ensure standard 720p output when base is 1080p and scale is 1.5x
  const effW = Math.round(baseW / scaleResolutionDownBy);
  const effH = Math.round(baseH / scaleResolutionDownBy);

  const hwEncoderPipeline = params.forceHardwareEncoder
    ? params.codec === 'H264_42e01f'
      ? 'NVENC H.264 P1 Ultra-Low-Latency / VideoToolbox HW (CBR/VBR Dynamic Reconfig)'
      : 'NVENC HEVC Main10 P1 / MediaCodec Hardware Encoder'
    : 'Software Libx264 (CPU Fallback — High Latency Warning)';

  const hwDecoderPipeline = params.forceHardwareEncoder
    ? 'Android MediaCodec C2 Low-Latency HW + Hardware Scaler (SurfaceView HWC2)'
    : 'Software VP8/H264 Decoder';

  return {
    targetBitrateKbps,
    targetBitrateMbps,
    scaleResolutionDownBy,
    effectiveResolution: `${effW}x${effH}`,
    effectiveFps,
    abrTierLabel,
    hwEncoderPipeline,
    hwDecoderPipeline,
    reason
  };
}

/**
 * Evaluates real-time network telemetry and produces the Sender UI Network Quality Indicator.
 */
export function evaluateNetworkQualityIndicator(
  params: ZeroLatencyParameters,
  endToEndLatencyMs: number,
  networkRttHalfMs: number
): NetworkQualityIndicator {
  const rttMs = Number((networkRttHalfMs * 2).toFixed(1));
  const bw = params.estimatedBandwidthMbps;
  const loss = params.packetLossPercent;

  let grade: NetworkQualityIndicator['grade'] = 'Excellent';
  let signalBars: NetworkQualityIndicator['signalBars'] = 4;
  let rssiDbm = -44;
  let jitterMs = 0.6;
  let statusSummary = '5GHz/6GHz LAN Optimal — Direct UDP P2P Locked';

  if (params.networkMode === 'Gigabit Ethernet LAN') {
    rssiDbm = -32;
    jitterMs = 0.2;
  } else if (params.networkMode === 'Congested 2.4GHz Wi-Fi') {
    rssiDbm = -74;
    jitterMs = 4.8;
  }

  if (loss >= 5 || bw < 10 || endToEndLatencyMs > 30) {
    grade = 'Degraded';
    signalBars = 1;
    rssiDbm = Math.min(rssiDbm, -78);
    jitterMs = Number((jitterMs + loss * 0.9).toFixed(1));
    statusSummary = 'High Wi-Fi Interference — ABR Scaling Resolution to Lock 60fps';
  } else if (loss >= 2 || bw < 18 || endToEndLatencyMs > 20) {
    grade = 'Fair';
    signalBars = 2;
    rssiDbm = Math.min(rssiDbm, -67);
    jitterMs = Number((jitterMs + loss * 0.5).toFixed(1));
    statusSummary = 'Moderate Airtime Contention — Dynamic Bitrate Adaptation Active';
  } else if (loss > 0.5 || bw < 28) {
    grade = 'Good';
    signalBars = 3;
    rssiDbm = Math.min(rssiDbm, -56);
    jitterMs = Number((jitterMs + 0.4).toFixed(1));
    statusSummary = 'Stable LAN Link — Hardware ABR Maintaining 60fps+';
  }

  return {
    grade,
    signalBars,
    rssiDbm,
    estimatedBandwidthMbps: bw,
    rttMs,
    endToEndLatencyMs,
    jitterMs,
    packetLossPercent: loss,
    statusSummary
  };
}

/**
 * Computes Audio/Video Synchronization telemetry and hardware audio pipeline state.
 */
export function calculateAvSyncState(
  params: ZeroLatencyParameters,
  videoEndToEndMs: number,
  networkRttHalfMs: number
): AvSyncTelemetry {
  const { audio } = params;
  // Hardware AAudio / AudioTrack LOW_LATENCY capture + encode + decode + DMA buffer
  const captureAndEncodeMs = audio.codec === 'AAC_ELD_Hardware' ? 3.2 : 2.5;
  const decodeAndDmaMs = audio.hardwareAudioTrackLowLatency ? 3.4 : 14.0;
  const rawAudioMs = Number((captureAndEncodeMs + audio.ptimeMs * 0.5 + networkRttHalfMs + decodeAndDmaMs).toFixed(1));

  // When lipSyncLock is enabled, WebRTC's RtpReceiver synchronizes audio & video playout timestamps via RTCP SR
  const audioPipelineMs = audio.lipSyncLock
    ? Number((videoEndToEndMs - 0.3).toFixed(1))
    : rawAudioMs;

  const avSyncOffsetMs = Number((audioPipelineMs - videoEndToEndMs).toFixed(1));

  return {
    audioEnabled: audio.enabled,
    audioCodecDescriptor:
      audio.codec === 'Opus_48kHz_Stereo'
        ? `Opus 48kHz Stereo (ptime=${audio.ptimeMs}ms, In-Band FEC, 0 DTX)`
        : `MediaCodec AAC-ELD 48kHz Hardware (${audio.bitrateKbps} kbps)`,
    audioBitrateKbps: audio.bitrateKbps,
    audioPacketTimeMs: audio.ptimeMs,
    videoPipelineMs: videoEndToEndMs,
    audioPipelineMs,
    avSyncOffsetMs,
    isSynchronized: Math.abs(avSyncOffsetMs) <= 5.0,
    hwAudioPath: audio.hardwareAudioTrackLowLatency
      ? 'Android AAudio / AudioTrack PERFORMANCE_MODE_LOW_LATENCY + Hardware DSP'
      : 'Standard Android AudioTrack Buffer'
  };
}

/**
 * Pure function that munges a standard WebRTC SDP Offer/Answer to enforce:
 * 1. Playout Delay RTP extension (min=0ms, max=0ms) to bypass the WebRTC jitter buffer
 * 2. H.264 Constrained Baseline (profile-level-id=42e01f) or HEVC with zero B-frames
 * 3. Adaptive Bitrate bounds (x-google-min-bitrate, x-google-start-bitrate, x-google-max-bitrate)
 * 4. Low-latency synchronized Stereo 48kHz Audio (ptime=10, minptime=10, stereo=1, maxaveragebitrate)
 */
export function mungeZeroLatencySdp(rawSdp: string, params: ZeroLatencyParameters): string {
  const lines = rawSdp.replace(/\r\n/g, '\n').split('\n');
  const output: string[] = [];
  const profileId = params.codec === 'H264_42e01f' ? '42e01f' : 'Main10';
  const codecName = params.codec === 'H264_42e01f' ? 'H264/90000' : 'H265/90000';
  const abr = computeAdaptiveBitrateDecision(params);

  let injectedExtmap = false;
  let injectedVideoFmtp = false;
  let injectedAudioFmtp = false;

  for (const line of lines) {
    output.push(line);

    if (line.startsWith('m=video') && params.zeroPlayoutDelay && !injectedExtmap) {
      output.push(
        'a=extmap:14 http://www.webrtc.org/experiments/rtp-hdrext/playout-delay'
      );
      output.push(`a=framerate:${params.targetFps}`);
      injectedExtmap = true;
    }

    if (line.includes('a=rtpmap:') && (line.includes('H264') || line.includes('H265') || line.includes('VP8'))) {
      const match = line.match(/^a=rtpmap:(\d+)/);
      const pt = match ? match[1] : '96';
      if (!injectedVideoFmtp) {
        const bFrameFlag = params.disableBFrames ? 'bframes=0;max-br=35000;' : '';
        output.push(
          `a=fmtp:${pt} level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=${profileId};${bFrameFlag}x-google-min-bitrate=${params.minBitrateKbps};x-google-start-bitrate=${abr.targetBitrateKbps};x-google-max-bitrate=${params.maxBitrateKbps}`
        );
        if (params.zeroPlayoutDelay) {
          output.push('a=playout-delay:0 0');
        }
        injectedVideoFmtp = true;
      }
    }

    if (params.audio.enabled && line.includes('a=rtpmap:') && line.toLowerCase().includes('opus')) {
      const match = line.match(/^a=rtpmap:(\d+)/);
      const pt = match ? match[1] : '111';
      if (!injectedAudioFmtp) {
        output.push(
          `a=fmtp:${pt} minptime=${params.audio.ptimeMs};ptime=${params.audio.ptimeMs};stereo=1;sprop-stereo=1;maxaveragebitrate=${params.audio.bitrateKbps * 1000};useinbandfec=1;usedtx=0;cbr=1`
        );
        injectedAudioFmtp = true;
      }
    }
  }

  // If rawSdp was synthetic or minimal without codec lines, append deterministic video + audio lines
  if (!injectedVideoFmtp) {
    if (params.zeroPlayoutDelay && !injectedExtmap) {
      output.push('a=extmap:14 http://www.webrtc.org/experiments/rtp-hdrext/playout-delay');
    }
    output.push(`a=rtpmap:96 ${codecName}`);
    const bFrameFlag = params.disableBFrames ? 'bframes=0;max-br=35000;' : '';
    output.push(
      `a=fmtp:96 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=${profileId};${bFrameFlag}x-google-min-bitrate=${params.minBitrateKbps};x-google-start-bitrate=${abr.targetBitrateKbps};x-google-max-bitrate=${params.maxBitrateKbps}`
    );
    if (params.zeroPlayoutDelay) {
      output.push('a=playout-delay:0 0');
    }
  }

  if (params.audio.enabled && !injectedAudioFmtp) {
    output.push('m=audio 9 UDP/TLS/RTP/SAVPF 111');
    output.push('a=rtpmap:111 opus/48000/2');
    output.push(
      `a=fmtp:111 minptime=${params.audio.ptimeMs};ptime=${params.audio.ptimeMs};stereo=1;sprop-stereo=1;maxaveragebitrate=${params.audio.bitrateKbps * 1000};useinbandfec=1;usedtx=0;cbr=1`
    );
  }

  return output.join('\r\n');
}

/**
 * Computes the complete end-to-end glass-to-glass latency budget, ABR decision,
 * Network Quality Indicator, and A/V Synchronization state.
 */
export function calculateLatencyBudget(params: ZeroLatencyParameters): LatencyBudgetBreakdown {
  const captureMs = params.targetFps === 120 ? 1.2 : 1.8;

  let encodeMs = params.forceHardwareEncoder ? 2.4 : 11.5;
  if (params.codec === 'HEVC_Main10') {
    encodeMs += 0.5;
  }
  if (!params.disableBFrames) {
    encodeMs += 33.3;
  }

  let networkRttHalfMs = 2.6;
  if (params.networkMode === 'Gigabit Ethernet LAN') {
    networkRttHalfMs = 0.7;
  } else if (params.networkMode === 'Congested 2.4GHz Wi-Fi') {
    networkRttHalfMs = 8.4;
  }
  const lossPenaltyMs = params.packetLossPercent * (params.zeroPlayoutDelay ? 0.25 : 2.8);
  networkRttHalfMs = Number((networkRttHalfMs + lossPenaltyMs).toFixed(1));

  const jitterBufferMs = params.zeroPlayoutDelay ? 0.4 : 42.0;
  const decodeMs = params.forceHardwareEncoder ? 2.8 : 9.6;
  const renderVsyncMs = params.targetFps === 120 ? 2.1 : 3.6;

  const totalEndToEndMs = Number(
    (captureMs + encodeMs + networkRttHalfMs + jitterBufferMs + decodeMs + renderVsyncMs).toFixed(1)
  );

  const abrDecision = computeAdaptiveBitrateDecision(params);
  const networkQuality = evaluateNetworkQualityIndicator(params, totalEndToEndMs, networkRttHalfMs);
  const avSync = calculateAvSyncState(params, totalEndToEndMs, networkRttHalfMs);

  return {
    captureMs,
    encodeMs: Number(encodeMs.toFixed(1)),
    networkRttHalfMs,
    jitterBufferMs,
    decodeMs,
    renderVsyncMs,
    totalEndToEndMs,
    meetsSub20msTarget: totalEndToEndMs < 20.0,
    effectiveResolution: abrDecision.effectiveResolution,
    effectiveFps: abrDecision.effectiveFps,
    scaleResolutionDownBy: abrDecision.scaleResolutionDownBy,
    abrDecision,
    networkQuality,
    avSync
  };
}
