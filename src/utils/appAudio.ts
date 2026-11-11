/**
 * "This app only" sound: the PC app's helper captures one program's audio (48 kHz stereo
 * 16-bit PCM) and the server streams it over /ws/app-audio. This turns that into an ordinary
 * MediaStreamTrack the cast sends instead of the whole PC's sound.
 */

/** Never let more than this much audio queue up (keeps it in step with the picture). */
const MAX_QUEUE_SECONDS = 0.15;
const SAMPLE_RATE = 48000;

const WORKLET = `
class UvLinkPcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.queued = 0;
    const max = ${Math.round(MAX_QUEUE_SECONDS * SAMPLE_RATE * 2)};
    this.port.onmessage = (event) => {
      const samples = new Int16Array(event.data);
      this.queue.push(samples);
      this.queued += samples.length;
      // Too far behind (e.g. after a hiccup): drop the oldest audio.
      while (this.queued > max && this.queue.length > 1) {
        const dropped = this.queue.shift();
        this.queued -= dropped.length - this.offset;
        this.offset = 0;
      }
    };
  }
  process(inputs, outputs) {
    const left = outputs[0][0];
    const right = outputs[0][1] || left;
    for (let i = 0; i < left.length; i++) {
      const current = this.queue[0];
      if (!current) { left[i] = 0; right[i] = 0; continue; }
      left[i] = current[this.offset] / 32768;
      right[i] = current[this.offset + 1] / 32768;
      this.offset += 2;
      this.queued -= 2;
      if (this.offset >= current.length) { this.queue.shift(); this.offset = 0; }
    }
    return true;
  }
}
registerProcessor('uvlink-pcm-player', UvLinkPcmPlayer);
`;

export interface AppAudioTrack {
  track: MediaStreamTrack;
  close: () => void;
}

/** Connects to the PC app's app-audio stream. Rejects when it isn't available. */
export async function openAppAudioTrack(): Promise<AppAudioTrack> {
  const context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
  const moduleUrl = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
  try {
    await context.audioWorklet.addModule(moduleUrl);
  } finally {
    URL.revokeObjectURL(moduleUrl);
  }
  const player = new AudioWorkletNode(context, 'uvlink-pcm-player', { outputChannelCount: [2] });
  const destination = context.createMediaStreamDestination();
  player.connect(destination);

  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${protocol}://${window.location.host}/ws/app-audio`);
  socket.binaryType = 'arraybuffer';
  // Chunks can split a sample; keep whole stereo frames (4 bytes) only.
  let carry = new Uint8Array(0);
  socket.onmessage = (event) => {
    const incoming = new Uint8Array(event.data as ArrayBuffer);
    const data = new Uint8Array(carry.length + incoming.length);
    data.set(carry);
    data.set(incoming, carry.length);
    const whole = data.length - (data.length % 4);
    carry = data.slice(whole);
    if (whole > 0) {
      const frames = data.slice(0, whole).buffer;
      player.port.postMessage(frames, [frames]);
    }
  };

  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("couldn't connect to the app sound"));
    socket.onclose = () => reject(new Error('this program has no sound to capture'));
  });
  await context.resume().catch(() => {});

  const [track] = destination.stream.getAudioTracks();
  return {
    track,
    close: () => {
      socket.onclose = null;
      socket.close();
      track.stop();
      context.close().catch(() => {});
    }
  };
}
