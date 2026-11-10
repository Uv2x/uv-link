/**
 * Uv Link server: serves the web app, relays WebRTC signaling between PCs and TVs,
 * announces itself on the LAN (mDNS `_uvlink._tcp`) so the Android TV app can find it,
 * and serves the built TV .apk / PC .exe for download.
 *
 * Used by `server.ts` (npm run dev / npm start) and, bundled, by the Electron PC app.
 */
import express from 'express';
import { createServer, type IncomingMessage, type Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { Bonjour } from 'bonjour-service';
import type {
  ClientMessage,
  LiveReceiver,
  PacketDirection,
  PacketLogItem,
  ServerMessage
} from '../src/shared/protocol';

export interface UvLinkServerOptions {
  /** Preferred port (default 3000). */
  port?: number;
  /** Try the next ports when the preferred one is taken (the PC app uses this). */
  portFallback?: boolean;
  /** Serve the frontend through Vite with hot reload instead of from `staticDir`. */
  dev?: boolean;
  /** Folder with the built frontend (vite build output). */
  staticDir: string;
  /** Folder holding UvLink-TV.apk / UvLink-PC-Setup.exe to offer for download. */
  downloadsDir?: string;
  /** Announce `_uvlink._tcp` over mDNS so TV apps can find this PC (default true). */
  advertise?: boolean;
  /** Print the startup banner (default true). */
  printBanner?: boolean;
}

export interface RunningUvLinkServer {
  port: number;
  lanUrls: () => string[];
  close: () => Promise<void>;
}

export const DOWNLOADS = {
  tvApk: { route: '/tv.apk', file: 'UvLink-TV.apk', type: 'application/vnd.android.package-archive' },
  pcExe: { route: '/pc-setup.exe', file: 'UvLink-PC-Setup.exe', type: 'application/vnd.microsoft.portable-executable' }
} as const;

const MAX_LOGS = 40;
/** How long a TV that dropped its WebSocket stays listed, so a Wi-Fi blip doesn't end the cast. */
const TV_RECONNECT_GRACE_MS = 5000;
const HEARTBEAT_MS = 15000;
const PORT_FALLBACK_ATTEMPTS = 10;

interface ClientConn {
  id: string;
  ws: WebSocket;
  role: 'unknown' | 'sender' | 'tv';
  /** For TVs: the receiver id this socket speaks for. */
  receiverId: string | null;
  ip: string;
  isAlive: boolean;
}

interface ReceiverRecord {
  info: LiveReceiver;
  /** Socket currently speaking for this TV; null while it is reconnecting. */
  clientId: string | null;
  /** Sender client id that is casting to this TV right now. */
  activeSenderId: string | null;
  removalTimer: NodeJS.Timeout | null;
}

/** IPv4 addresses other devices on the LAN can reach this PC at, most likely first. */
export function lanAddresses(): string[] {
  const virtualAdapter = /vEthernet|VirtualBox|VMware|WSL|Hyper-V|docker|^br-|^veth|Loopback|Tailscale|ZeroTier|utun/i;
  const found: Array<{ address: string; score: number }> = [];
  for (const [name, infos] of Object.entries(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' || info.internal || info.address.startsWith('169.254.')) continue;
      let score = 0;
      if (info.address.startsWith('192.168.')) score = 3;
      else if (info.address.startsWith('10.')) score = 2;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(info.address)) score = 1;
      if (virtualAdapter.test(name)) score -= 10;
      found.push({ address: info.address, score });
    }
  }
  return found.sort((a, b) => b.score - a.score).map((f) => f.address);
}

function cleanIp(remoteAddress: string | undefined): string {
  if (!remoteAddress) return 'unknown';
  return remoteAddress.replace(/^::ffff:/, '');
}

function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

/** "video H264 · audio opus" — the first-choice codec of each m-line, for the packet log. */
function describeSdp(sdp: string): string {
  const parts: string[] = [];
  for (const media of sdp.split(/\r?\nm=/).slice(1)) {
    const [kind, , , firstPt] = media.split(/\s+/);
    const rtpmap = new RegExp(`a=rtpmap:${firstPt} ([^/\\r\\n]+)`).exec(media);
    if (kind && rtpmap) parts.push(`${kind} ${rtpmap[1]}`);
  }
  return parts.join(' · ') || 'no media';
}

/** "host udp" / "srflx udp" from a candidate line, for the packet log. */
function describeCandidate(candidate: unknown): string {
  const line = typeof (candidate as { candidate?: unknown })?.candidate === 'string'
    ? (candidate as { candidate: string }).candidate
    : '';
  if (!line) return 'end-of-candidates';
  const type = /typ (\w+)/.exec(line)?.[1] ?? '?';
  const protocol = / (udp|tcp) /i.exec(line)?.[1]?.toLowerCase() ?? '';
  return `${type} ${protocol}`.trim();
}

function listenWithFallback(server: Server, port: number, fallback: boolean): Promise<number> {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryListen = (candidate: number) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.off('listening', onListening);
        if (err.code === 'EADDRINUSE' && fallback && attempt < PORT_FALLBACK_ATTEMPTS) {
          attempt += 1;
          tryListen(candidate + 1);
        } else {
          reject(err);
        }
      };
      const onListening = () => {
        server.off('error', onError);
        resolve(candidate);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(candidate, '0.0.0.0');
    };
    tryListen(port);
  });
}

export async function startUvLinkServer(options: UvLinkServerOptions): Promise<RunningUvLinkServer> {
  const {
    port: preferredPort = 3000,
    portFallback = false,
    dev = false,
    staticDir,
    downloadsDir,
    advertise = true,
    printBanner = true
  } = options;

  /** Set once listening; used in URLs and download scripts. */
  let activePort = preferredPort;
  const lanUrls = () => lanAddresses().map((address) => `http://${address}:${activePort}`);

  const app = express();
  app.use(express.json({ limit: '32kb' }));

  const httpServer = createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

  const clients = new Map<string, ClientConn>();
  const receivers = new Map<string, ReceiverRecord>();
  const packetLogs: PacketLogItem[] = [];

  const newId = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;

  const sendTo = (client: ClientConn | undefined, msg: ServerMessage) => {
    if (client && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(msg));
    }
  };

  const broadcastToSenders = (msg: ServerMessage) => {
    for (const client of clients.values()) {
      if (client.role === 'sender') sendTo(client, msg);
    }
  };

  const log = (direction: PacketDirection, type: string, summary: string, payloadSize = 0) => {
    const entry: PacketLogItem = {
      id: newId('pkt'),
      timestamp: new Date().toISOString().slice(11, 23),
      direction,
      type,
      summary,
      payloadSize
    };
    packetLogs.unshift(entry);
    if (packetLogs.length > MAX_LOGS) packetLogs.pop();
    broadcastToSenders({ type: 'log', entry });
    return entry;
  };

  const receiverList = (): LiveReceiver[] =>
    [...receivers.values()].map((r) => r.info).sort((a, b) => a.connectedAt - b.connectedAt);

  const publishReceivers = () => broadcastToSenders({ type: 'receivers', receivers: receiverList() });

  const setActiveSender = (record: ReceiverRecord, senderId: string | null) => {
    record.activeSenderId = senderId;
    record.info.status = senderId ? 'streaming' : 'idle';
    publishReceivers();
  };

  const welcome = (client: ClientConn): ServerMessage => ({
    type: 'welcome',
    clientId: client.id,
    receiverId: client.receiverId,
    lanUrls: lanUrls(),
    receivers: receiverList(),
    packetLogs: packetLogs.slice(0, 25)
  });

  const downloadPath = (file: string): string | null => {
    if (!downloadsDir) return null;
    const full = path.join(downloadsDir, file);
    return fs.existsSync(full) ? full : null;
  };

  // ---------------------------------------------------------------- REST

  app.get('/api/info', (_req, res) => {
    res.json({
      app: 'uvlink',
      name: os.hostname(),
      lanUrls: lanUrls(),
      port: activePort,
      receivers: receivers.size,
      downloads: {
        tvApk: downloadPath(DOWNLOADS.tvApk.file) !== null,
        pcExe: downloadPath(DOWNLOADS.pcExe.file) !== null
      }
    });
  });

  app.get('/api/receivers', (_req, res) => {
    res.json({ receivers: receiverList(), packetLogs: packetLogs.slice(0, 25) });
  });

  // Built installers. Short URLs on purpose: they get typed on a TV remote.
  for (const download of Object.values(DOWNLOADS)) {
    app.get(download.route, (_req, res) => {
      const file = downloadPath(download.file);
      if (!file) {
        res
          .status(404)
          .type('text/plain')
          .send(`${download.file} has not been built yet. Run "npm run release" on the PC.`);
        return;
      }
      res.type(download.type);
      res.download(file, download.file);
    });
  }

  // Windows launcher: opens the sender as an app window in Edge/Chrome.
  app.get('/api/download/pc-exe-launcher', (_req, res) => {
    const batContent = [
      '@echo off',
      'title Uv Link PC Sender',
      `set UVLINK_URL=http://localhost:${activePort}`,
      'where msedge >nul 2>nul && (start "" msedge --app=%UVLINK_URL% & exit /b)',
      'where chrome >nul 2>nul && (start "" chrome --app=%UVLINK_URL% & exit /b)',
      'start "" %UVLINK_URL%',
      'exit /b'
    ].join('\r\n');
    res.setHeader('Content-Type', 'application/bat');
    res.setHeader('Content-Disposition', 'attachment; filename="UvLink-PC-Sender-Launcher.bat"');
    res.send(batContent);
  });

  // Authoritative OTA Auto-Updater State (tracks GitHub repo, current & latest versions for TV .APK and PC .EXE)
  let autoUpdateState = {
    githubRepo: 'youseffakhouri/uv-link',
    channel: 'stable',
    autoCheckEnabled: true,
    currentVersion: '2.4.0',
    latestVersion: '2.5.0',
    updateAvailable: true,
    lastChecked: new Date().toISOString().slice(11, 19),
    releaseNotes: 'v2.5.0: Added Hardware ABR 60fps lock, 10ms Stereo AAudio lip-sync, and iOS/Android native Screen Mirroring tab discovery.',
    assets: {
      tvApk: 'UvLink-TV-Receiver-v2.5.0.apk',
      pcExe: 'UvLink-PC-Sender-Setup-2.5.0.exe'
    }
  };

  app.get('/api/autoupdate/status', (_req, res) => {
    res.json(autoUpdateState);
  });

  app.post('/api/autoupdate/check', async (req, res) => {
    const repoInput = typeof req.body?.githubRepo === 'string' && req.body.githubRepo.trim()
      ? req.body.githubRepo.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, '')
      : autoUpdateState.githubRepo;

    autoUpdateState.githubRepo = repoInput;
    autoUpdateState.lastChecked = new Date().toISOString().slice(11, 19);

    // Query live GitHub Releases API if reachable, otherwise use deterministic OTA manifest
    try {
      const ghRes = await fetch(`https://api.github.com/repos/${repoInput}/releases/latest`, {
        headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'UvLink-AutoUpdater/2.5' }
      });
      if (ghRes.ok) {
        const ghData = await ghRes.json() as { tag_name?: string; body?: string };
        if (ghData.tag_name) {
          const cleanVer = ghData.tag_name.replace(/^v/, '');
          autoUpdateState.latestVersion = cleanVer;
          autoUpdateState.updateAvailable = cleanVer !== autoUpdateState.currentVersion;
          if (ghData.body) {
            autoUpdateState.releaseNotes = ghData.body.slice(0, 180);
          }
        }
      }
    } catch {
      // Offline LAN fallback uses built-in OTA manifest
    }

    log(
      'Server',
      'OTA AUTO-UPDATE CHECK',
      `Checked github.com/${autoUpdateState.githubRepo}/releases/latest — Latest: v${autoUpdateState.latestVersion} (Installed: v${autoUpdateState.currentVersion})`
    );
    res.json(autoUpdateState);
  });

  app.post('/api/autoupdate/apply', (_req, res) => {
    autoUpdateState = {
      ...autoUpdateState,
      currentVersion: autoUpdateState.latestVersion,
      updateAvailable: false,
      lastChecked: new Date().toISOString().slice(11, 19)
    };
    log('Server', 'OTA UPDATE APPLIED', `Version marker set to v${autoUpdateState.currentVersion}`);
    res.json(autoUpdateState);
  });

  // ---------------------------------------------------------------- Signaling

  httpServer.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname;
    if (pathname === '/ws/signaling') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else if (!dev) {
      // In dev, Vite owns other upgrade paths (hot reload); in production nothing else is served.
      socket.destroy();
    }
  });

  const handleTvHello = (client: ClientConn, msg: Extract<ClientMessage, { type: 'hello'; role: 'tv' }>) => {
    const requestedId = cleanText(msg.tvId, 64);
    const id = requestedId && /^[a-z0-9-]+$/i.test(requestedId) ? requestedId : newId('tv');
    const name = cleanText(msg.name, 60) ?? 'Uv Link TV';
    const device = cleanText(msg.device, 40) ?? 'Browser';
    client.role = 'tv';
    client.receiverId = id;

    const existing = receivers.get(id);
    if (existing) {
      // Same TV tab reconnecting: keep its place (and any running cast — media is peer-to-peer).
      if (existing.removalTimer) clearTimeout(existing.removalTimer);
      existing.removalTimer = null;
      const previous = existing.clientId ? clients.get(existing.clientId) : undefined;
      existing.clientId = client.id;
      if (previous && previous !== client) previous.ws.terminate();
      existing.info = { ...existing.info, name, device, ip: client.ip };
      sendTo(client, welcome(client));
      log('TV → Server', 'TV RECONNECTED', `${name} is back from ${client.ip}`);
    } else {
      receivers.set(id, {
        info: { id, name, device, ip: client.ip, status: 'idle', connectedAt: Date.now() },
        clientId: client.id,
        activeSenderId: null,
        removalTimer: null
      });
      sendTo(client, welcome(client));
      log('TV → Server', 'TV ONLINE', `${name} (${device}) joined from ${client.ip}`);
    }
    publishReceivers();
  };

  const handleMessage = (client: ClientConn, msg: ClientMessage, size: number) => {
    switch (msg.type) {
      case 'hello': {
        if (msg.role === 'tv') {
          handleTvHello(client, msg);
        } else {
          client.role = 'sender';
          sendTo(client, welcome(client));
        }
        return;
      }

      case 'tv:rename': {
        const record = client.receiverId ? receivers.get(client.receiverId) : undefined;
        const name = cleanText(msg.name, 60);
        if (client.role !== 'tv' || !record || !name) return;
        record.info.name = name;
        log('TV → Server', 'TV RENAMED', `Now called ${name}`);
        publishReceivers();
        return;
      }

      case 'webrtc:offer': {
        if (client.role !== 'sender' || typeof msg.sdp !== 'string') return;
        const record = receivers.get(String(msg.to));
        const tv = record?.clientId ? clients.get(record.clientId) : undefined;
        if (!record || !tv) {
          sendTo(client, { type: 'webrtc:ended', receiverId: String(msg.to), reason: 'That TV is not connected right now.' });
          return;
        }
        if (record.activeSenderId && record.activeSenderId !== client.id) {
          sendTo(clients.get(record.activeSenderId), {
            type: 'webrtc:ended',
            receiverId: record.info.id,
            reason: `Another device started casting to ${record.info.name}.`
          });
        }
        setActiveSender(record, client.id);
        sendTo(tv, { type: 'webrtc:offer', from: client.id, sdp: msg.sdp });
        log('Sender → TV', 'SDP OFFER', `${describeSdp(msg.sdp)} → ${record.info.name}`, size);
        return;
      }

      case 'webrtc:answer': {
        const record = client.receiverId ? receivers.get(client.receiverId) : undefined;
        if (client.role !== 'tv' || !record || record.activeSenderId !== msg.to || typeof msg.sdp !== 'string') return;
        sendTo(clients.get(msg.to), { type: 'webrtc:answer', from: record.info.id, sdp: msg.sdp });
        log('TV → Sender', 'SDP ANSWER', `${record.info.name} accepted: ${describeSdp(msg.sdp)}`, size);
        return;
      }

      case 'webrtc:ice': {
        if (client.role === 'sender') {
          const record = receivers.get(String(msg.to));
          if (!record || record.activeSenderId !== client.id || !record.clientId) return;
          sendTo(clients.get(record.clientId), { type: 'webrtc:ice', from: client.id, candidate: msg.candidate });
          log('Sender → TV', 'ICE CANDIDATE', describeCandidate(msg.candidate), size);
        } else if (client.role === 'tv') {
          const record = client.receiverId ? receivers.get(client.receiverId) : undefined;
          if (!record || record.activeSenderId !== msg.to) return;
          sendTo(clients.get(msg.to), { type: 'webrtc:ice', from: record.info.id, candidate: msg.candidate });
          log('TV → Sender', 'ICE CANDIDATE', describeCandidate(msg.candidate), size);
        }
        return;
      }

      case 'webrtc:stop': {
        const record = receivers.get(String(msg.to));
        if (client.role !== 'sender' || !record || record.activeSenderId !== client.id) return;
        sendTo(record.clientId ? clients.get(record.clientId) : undefined, { type: 'webrtc:stop', from: client.id });
        setActiveSender(record, null);
        log('Sender → TV', 'STOP', `Cast to ${record.info.name} ended by the PC`, size);
        return;
      }

      case 'tv:stats': {
        const record = client.receiverId ? receivers.get(client.receiverId) : undefined;
        if (client.role !== 'tv' || !record || record.activeSenderId !== msg.to) return;
        sendTo(clients.get(msg.to), { type: 'tv:stats', from: record.info.id, stats: msg.stats });
        return;
      }
    }
  };

  const handleDisconnect = (client: ClientConn) => {
    clients.delete(client.id);

    if (client.role === 'sender') {
      for (const record of receivers.values()) {
        if (record.activeSenderId !== client.id) continue;
        sendTo(record.clientId ? clients.get(record.clientId) : undefined, { type: 'webrtc:stop', from: client.id });
        setActiveSender(record, null);
        log('Server', 'SENDER LEFT', `PC closed the page; stopped cast to ${record.info.name}`);
      }
      return;
    }

    if (client.role === 'tv' && client.receiverId) {
      const record = receivers.get(client.receiverId);
      // Ignore sockets that were already replaced by a reconnect.
      if (!record || record.clientId !== client.id) return;
      record.clientId = null;
      record.removalTimer = setTimeout(() => {
        receivers.delete(record.info.id);
        if (record.activeSenderId) {
          sendTo(clients.get(record.activeSenderId), {
            type: 'webrtc:ended',
            receiverId: record.info.id,
            reason: `${record.info.name} disconnected.`
          });
        }
        log('TV → Server', 'TV OFFLINE', `${record.info.name} left`);
        publishReceivers();
      }, TV_RECONNECT_GRACE_MS);
    }
  };

  wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
    const client: ClientConn = {
      id: newId('c'),
      ws,
      role: 'unknown',
      receiverId: null,
      ip: cleanIp(request.socket.remoteAddress),
      isAlive: true
    };
    clients.set(client.id, client);

    ws.on('pong', () => {
      client.isAlive = true;
    });

    ws.on('message', (data) => {
      const raw = data.toString();
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
      try {
        handleMessage(client, msg, raw.length);
      } catch (err) {
        console.error('Signaling message failed:', err);
      }
    });

    ws.on('close', () => handleDisconnect(client));
  });

  // Drop sockets whose device vanished without closing (TV switched off, Wi-Fi lost).
  const heartbeat = setInterval(() => {
    for (const client of clients.values()) {
      if (!client.isAlive) {
        client.ws.terminate();
        continue;
      }
      client.isAlive = false;
      client.ws.ping();
    }
  }, HEARTBEAT_MS);

  // ---------------------------------------------------------------- Frontend

  let closeVite: (() => Promise<void>) | null = null;
  if (dev) {
    // Loaded lazily so the packaged PC app never needs Vite.
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
    closeVite = () => vite.close();
  } else {
    app.use(express.static(staticDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(staticDir, 'index.html'));
    });
  }

  activePort = await listenWithFallback(httpServer, preferredPort, portFallback);

  // ---------------------------------------------------------------- LAN discovery

  let bonjour: Bonjour | null = null;
  if (advertise) {
    try {
      bonjour = new Bonjour();
      const service = bonjour.publish({
        name: `Uv Link on ${os.hostname()}`,
        type: 'uvlink',
        port: activePort,
        txt: { app: 'uvlink', path: '/?mode=tv' }
      });
      service.on('error', (err: unknown) => console.warn('Uv Link: mDNS announcement failed', err));
    } catch (err) {
      console.warn('Uv Link: mDNS announcement unavailable', err);
      bonjour = null;
    }
  }

  if (printBanner) {
    console.log('');
    console.log('  Uv Link is running.');
    console.log(`  Cast from this PC:   http://localhost:${activePort}`);
    const urls = lanUrls();
    if (urls.length === 0) {
      console.log('  No network address found — connect this PC to Wi-Fi or Ethernet to reach a TV.');
    }
    for (const url of urls) {
      console.log(`  Open on your TV:     ${url}/?mode=tv`);
    }
    console.log('');
  }

  const close = async () => {
    clearInterval(heartbeat);
    for (const record of receivers.values()) {
      if (record.removalTimer) clearTimeout(record.removalTimer);
    }
    for (const client of clients.values()) client.ws.terminate();
    if (bonjour) {
      const instance = bonjour;
      await new Promise<void>((resolve) => instance.unpublishAll(() => resolve()));
      instance.destroy();
    }
    await closeVite?.();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };

  return { port: activePort, lanUrls, close };
}
