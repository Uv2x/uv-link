import type { ClientMessage, ServerMessage } from '../shared/protocol';

type MessageListener = (msg: ServerMessage) => void;
type StatusListener = (connected: boolean) => void;

export function defaultSignalingUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws/signaling`;
}

/**
 * WebSocket wrapper for /ws/signaling that reconnects on its own.
 * TVs stay open for hours, so Wi-Fi blips and server restarts must not strand them.
 * The `hello` message is re-sent on every (re)connect so the server re-learns who we are.
 */
export class SignalingClient {
  private ws: WebSocket | null = null;
  private readonly messageListeners = new Set<MessageListener>();
  private readonly statusListeners = new Set<StatusListener>();
  private reconnectTimer: number | null = null;
  private attempts = 0;
  private closed = false;
  private isConnected = false;
  private readonly makeHello: () => ClientMessage;
  private readonly url: string;

  constructor(makeHello: () => ClientMessage, url: string = defaultSignalingUrl()) {
    this.makeHello = makeHello;
    this.url = url;
  }

  get connected(): boolean {
    return this.isConnected;
  }

  connect(): void {
    if (this.closed || this.ws) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.attempts = 0;
      ws.send(JSON.stringify(this.makeHello()));
      this.setConnected(true);
    };
    ws.onmessage = (event) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      for (const listener of [...this.messageListeners]) listener(msg);
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.setConnected(false);
      this.scheduleReconnect();
    };
    // Errors are always followed by `close`, which handles reconnecting.
    ws.onerror = () => {};
  }

  /** Returns false when the socket is not open (the message is dropped, not queued). */
  send(msg: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  subscribe(listener: MessageListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.setConnected(false);
  }

  private setConnected(value: boolean): void {
    if (this.isConnected === value) return;
    this.isConnected = value;
    for (const listener of [...this.statusListeners]) listener(value);
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== null) return;
    const delay = Math.min(8000, 500 * 2 ** this.attempts);
    this.attempts += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
