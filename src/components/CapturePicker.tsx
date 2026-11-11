import React, { useMemo, useState } from 'react';
import { AppWindow, ExternalLink, Monitor, MonitorSmartphone, Volume2, VolumeX, X } from 'lucide-react';
import type { CaptureChoice, CaptureSource } from '../shared/protocol';

interface CapturePickerProps {
  sources: CaptureSource[];
  /** Ask for system sound by default only when sound is on in the settings. */
  audioEnabled: boolean;
  onPick: (choice: CaptureChoice) => void;
  onCancel: () => void;
}

const VDD_RELEASES = 'https://github.com/VirtualDrivers/Virtual-Display-Driver/releases/latest';

/** The PC app's screen / window picker, with thumbnails and the sound choice. */
export const CapturePicker: React.FC<CapturePickerProps> = ({ sources, audioEnabled, onPick, onCancel }) => {
  const screens = useMemo(() => sources.filter((s) => s.kind === 'screen'), [sources]);
  const windows = useMemo(() => sources.filter((s) => s.kind === 'window'), [sources]);
  const hasVirtualScreen = screens.some((s) => s.virtual);
  const [tab, setTab] = useState<'screens' | 'windows'>('screens');
  const [selected, setSelected] = useState<string>(() => (screens.find((s) => s.virtual) ?? screens[0])?.id ?? '');
  const [audio, setAudio] = useState<CaptureChoice['audio']>(audioEnabled ? 'system' : 'none');

  const selectedSource = sources.find((s) => s.id === selected) ?? null;
  // "This app only" exists for windows; switching to a screen falls back to all PC sound.
  const audioChoice = audio === 'app' && selectedSource?.kind !== 'window' ? 'system' : audio;
  const shown = tab === 'screens' ? screens : windows;

  const tile = (source: CaptureSource) => (
    <button
      key={source.id}
      type="button"
      onClick={() => setSelected(source.id)}
      onDoubleClick={() => onPick({ id: source.id, audio: audioChoice })}
      aria-pressed={selected === source.id}
      className={`text-left rounded-md border p-2 transition-colors ${
        selected === source.id ? 'border-sky-400 bg-sky-500/10' : 'border-slate-800 bg-slate-950 hover:border-slate-600'
      }`}
    >
      <div className="aspect-video bg-black rounded overflow-hidden flex items-center justify-center">
        {source.thumbnail ? (
          <img src={source.thumbnail} alt="" className="w-full h-full object-contain" />
        ) : (
          <AppWindow className="w-6 h-6 text-slate-600" />
        )}
      </div>
      <div className="mt-1.5 text-xs text-slate-200 truncate" title={source.name}>
        {source.name}
      </div>
      {source.kind === 'screen' && (
        <div className="text-xs text-slate-400 font-mono">
          {source.width ? `${source.width}x${source.height}` : ''}
          {source.virtual && <span className="ml-1.5 text-emerald-300">· second screen for the TV</span>}
        </div>
      )}
    </button>
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Choose what to cast"
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-6"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-4xl max-h-full overflow-y-auto bg-slate-900 border border-slate-700 rounded-lg p-5"
        onClick={(e) => e.stopPropagation()}
        data-testid="capture-picker"
      >
        <div className="flex items-center justify-between gap-3 mb-4">
          <h2 className="text-sm font-semibold text-white">Choose what to cast</h2>
          <button type="button" onClick={onCancel} aria-label="Cancel" className="p-1.5 rounded hover:bg-slate-800 text-slate-300">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex gap-1.5 mb-4" role="tablist">
          {(['screens', 'windows'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md flex items-center gap-1.5 ${
                tab === t ? 'bg-sky-400 text-slate-950' : 'bg-slate-800 text-slate-200 hover:bg-slate-700'
              }`}
            >
              {t === 'screens' ? <Monitor className="w-3.5 h-3.5" /> : <AppWindow className="w-3.5 h-3.5" />}
              {t === 'screens' ? `Screens (${screens.length})` : `Windows (${windows.length})`}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {shown.map(tile)}
          {shown.length === 0 && <p className="text-xs text-slate-400 col-span-full">Nothing to show here.</p>}
        </div>

        {tab === 'screens' && !hasVirtualScreen && (
          <div className="mt-4 p-3 rounded-md border border-slate-800 bg-slate-950 text-xs text-slate-300 leading-relaxed" data-testid="second-screen-help">
            <div className="font-semibold text-white flex items-center gap-1.5 mb-1">
              <MonitorSmartphone className="w-3.5 h-3.5 text-emerald-400" />
              Use the TV as a second screen
            </div>
            Install the free <strong>Virtual Display Driver</strong> (open source), add a 1920x1080 display in it, and choose{' '}
            <em>Extend these displays</em> in Windows display settings. The new screen shows up here: cast it, and drag
            windows onto the TV like a real monitor.{' '}
            <a href={VDD_RELEASES} target="_blank" rel="noreferrer" className="text-sky-400 hover:text-sky-300 underline inline-flex items-center gap-1">
              Get Virtual Display Driver <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        )}

        <div className="mt-4 pt-4 border-t border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Sound">
            {(
              [
                ['system', 'All PC sound', Volume2],
                ['app', 'Only this app', Volume2],
                ['none', 'No sound', VolumeX]
              ] as const
            ).map(([value, label, Icon]) => {
              const disabled = value === 'app' && selectedSource?.kind !== 'window';
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={audioChoice === value}
                  disabled={disabled}
                  title={disabled ? 'Pick a window to send only its sound' : undefined}
                  onClick={() => setAudio(value)}
                  className={`px-2.5 py-1.5 text-xs rounded-md flex items-center gap-1.5 disabled:opacity-40 ${
                    audioChoice === value ? 'bg-emerald-500/20 text-emerald-200 border border-emerald-500/40' : 'bg-slate-800 text-slate-300'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {label}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            disabled={!selectedSource}
            onClick={() => selectedSource && onPick({ id: selectedSource.id, audio: audioChoice })}
            className="px-4 py-2 text-xs font-semibold bg-sky-400 hover:bg-sky-300 text-slate-950 rounded-md disabled:opacity-50"
            data-testid="capture-picker-cast"
          >
            Cast {selectedSource?.kind === 'window' ? 'this window' : 'this screen'}
          </button>
        </div>
      </div>
    </div>
  );
};
