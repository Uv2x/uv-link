/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import type { LiveReceiver, PacketLogItem } from './shared/protocol';
import { SignalingClient } from './utils/signalingClient';
import { loadSettings, saveSettings, type CastSettings } from './utils/castSettings';
import { DeviceInstallCards } from './components/DeviceInstallCards';
import { NetworkQualityBanner } from './components/NetworkQualityBanner';
import { LiveMirroringWorkbench, type LiveStreamStats } from './components/LiveMirroringWorkbench';
import { CastSettingsPanel } from './components/CastSettingsPanel';
import { ConnectionLog } from './components/ConnectionLog';
import { TvReceiverScreen } from './components/TvReceiverScreen';

const isTvModeUrl = () =>
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('mode') === 'tv';

function setTvModeInUrl(enabled: boolean) {
  const url = new URL(window.location.href);
  if (enabled) url.searchParams.set('mode', 'tv');
  else url.searchParams.delete('mode');
  window.history.replaceState(null, '', url);
}

export default function App() {
  const [settings, setSettings] = useState<CastSettings>(loadSettings);
  const [receivers, setReceivers] = useState<LiveReceiver[]>([]);
  const [selectedReceiverId, setSelectedReceiverId] = useState<string>('');
  const [packetLogs, setPacketLogs] = useState<PacketLogItem[]>([]);
  const [lanUrls, setLanUrls] = useState<string[]>([]);
  const [liveStats, setLiveStats] = useState<LiveStreamStats | null>(null);
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const [signaling, setSignaling] = useState<SignalingClient | null>(null);
  const [signalingConnected, setSignalingConnected] = useState(false);
  const [isTvReceiverMode, setIsTvReceiverMode] = useState<boolean>(isTvModeUrl);

  useEffect(() => saveSettings(settings), [settings]);

  // Sender-side signaling: live TV list, packet log, and the channel the workbench casts over.
  useEffect(() => {
    if (isTvReceiverMode) return;
    const client = new SignalingClient(() => ({ type: 'hello', role: 'sender' }));
    const addLog = (entry: PacketLogItem) =>
      setPacketLogs((prev) => (prev.some((p) => p.id === entry.id) ? prev : [entry, ...prev].slice(0, 40)));

    const offStatus = client.onStatus(setSignalingConnected);
    const offMessages = client.subscribe((msg) => {
      if (msg.type === 'welcome') {
        setReceivers(msg.receivers);
        setPacketLogs(msg.packetLogs);
        setLanUrls(msg.lanUrls);
      } else if (msg.type === 'receivers') {
        setReceivers(msg.receivers);
      } else if (msg.type === 'log') {
        addLog(msg.entry);
      }
    });
    client.connect();
    setSignaling(client);

    return () => {
      offMessages();
      offStatus();
      client.close();
      setSignaling(null);
      setSignalingConnected(false);
    };
  }, [isTvReceiverMode]);

  // Keep a valid selection: first TV when nothing (or a TV that left) is selected.
  useEffect(() => {
    if (receivers.length === 0) return;
    if (!receivers.some((r) => r.id === selectedReceiverId)) {
      setSelectedReceiverId(receivers[0].id);
    }
  }, [receivers, selectedReceiverId]);

  const handleRefreshReceivers = useCallback(async () => {
    try {
      const res = await fetch('/api/receivers');
      if (!res.ok) return;
      const data = (await res.json()) as { receivers?: LiveReceiver[] };
      if (Array.isArray(data.receivers)) setReceivers(data.receivers);
    } catch {
      // The WebSocket keeps the list current anyway; a failed manual refresh changes nothing.
    }
  }, []);

  const enterTvMode = useCallback(() => {
    setTvModeInUrl(true);
    setIsTvReceiverMode(true);
  }, []);

  const exitTvMode = useCallback(() => {
    setTvModeInUrl(false);
    setIsTvReceiverMode(false);
  }, []);

  const tvUrl = lanUrls[0] ? `${lanUrls[0]}/?mode=tv` : null;

  // Fullscreen receiver: open /?mode=tv in any TV / phone / laptop browser on the same network.
  if (isTvReceiverMode) {
    return <TvReceiverScreen onExit={exitTvMode} />;
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="flex items-center justify-between gap-8 px-8 py-4 border-b border-slate-900 bg-slate-950/95 sticky top-0 z-30">
        {/* Zone 1: Single text element wordmark */}
        <a
          href="#top"
          className="text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0 font-display"
        >
          Uv Link
        </a>

        <nav aria-label="Primary Navigation" className="hidden md:flex items-center gap-7 text-sm font-medium text-slate-400">
          <a href="#cast" className="hover:text-white transition-colors whitespace-nowrap">
            Cast
          </a>
          <a href="#settings" className="hover:text-white transition-colors whitespace-nowrap">
            Settings
          </a>
          <a href="#log" className="hover:text-white transition-colors whitespace-nowrap">
            Connection log
          </a>
        </nav>

        <a
          href="#cast"
          className="px-4 py-2 text-xs font-semibold text-slate-950 bg-sky-400 rounded-md hover:bg-sky-300 transition-colors whitespace-nowrap shrink-0"
        >
          Cast to a TV
        </a>
      </header>

      {/* Main Content Container */}
      <main id="top" className="flex-1 max-w-[1320px] w-full mx-auto px-8 py-8 space-y-8">
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-white tracking-tight text-balance">
              Uv Link — Cast your screen and sound to a TV
            </h1>
            <p className="text-sm text-slate-400 mt-1">
              Cast this PC&apos;s screen and sound to any TV, phone or laptop browser on your Wi-Fi. Peer-to-peer, nothing leaves your network.
            </p>
          </div>
          <div className="text-xs font-mono text-slate-400 tabular-nums whitespace-nowrap" data-testid="server-status">
            Server:{' '}
            <span className={signalingConnected ? 'text-emerald-400' : 'text-amber-400'}>
              {signalingConnected ? 'connected' : 'reconnecting…'}
            </span>{' '}
            · <span className="text-slate-200">{receivers.length} TV{receivers.length === 1 ? '' : 's'} online</span>
          </div>
        </div>

        <DeviceInstallCards onEnterTvMode={enterTvMode} tvUrl={tvUrl} receiverCount={receivers.length} />

        <NetworkQualityBanner settings={settings} liveStats={liveStats} isStreaming={isStreaming} />

        <div id="cast" className="scroll-mt-24" />
        <LiveMirroringWorkbench
          params={settings}
          onUpdateParams={setSettings}
          receivers={receivers}
          selectedReceiverId={selectedReceiverId}
          onSelectReceiver={setSelectedReceiverId}
          onRefreshReceivers={handleRefreshReceivers}
          signaling={signaling}
          signalingConnected={signalingConnected}
          tvUrl={tvUrl}
          onLiveStats={setLiveStats}
          isStreaming={isStreaming}
          setIsStreaming={setIsStreaming}
        />

        <CastSettingsPanel
          settings={settings}
          onChange={setSettings}
          tvMaxFps={receivers.find((r) => r.id === selectedReceiverId)?.maxFps ?? null}
        />

        <ConnectionLog entries={packetLogs} />
      </main>

      <footer className="border-t border-slate-900 px-8 py-5 text-xs text-slate-500 flex flex-wrap items-center justify-between gap-4 max-w-[1320px] w-full mx-auto">
        <span>Uv Link · peer-to-peer on your network</span>
        <span>Video and sound go straight from this PC to the TV (WebRTC)</span>
      </footer>
    </div>
  );
}
