import React from 'react';
import { RotateCcw, SlidersHorizontal } from 'lucide-react';
import {
  CODEC_OPTIONS,
  DEFAULT_SETTINGS,
  QUALITY_PRESETS,
  type CastSettings,
  type FrameRate,
  type QualityPreset
} from '../utils/castSettings';

interface CastSettingsPanelProps {
  settings: CastSettings;
  onChange: (updater: (prev: CastSettings) => CastSettings) => void;
  /** Highest frame rate the selected TV can show. */
  tvMaxFps: number | null;
}

const FRAME_RATES: FrameRate[] = [30, 60, 120];

/** The settings that change the cast. Changes apply to a running cast right away (format: next cast). */
export const CastSettingsPanel: React.FC<CastSettingsPanelProps> = ({ settings, onChange, tvMaxFps }) => {
  const codecHint = CODEC_OPTIONS.find((c) => c.value === settings.codec)?.hint ?? '';
  const button = (active: boolean) =>
    `px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
      active ? 'bg-sky-400 text-slate-950 font-semibold' : 'bg-slate-800 text-slate-200 hover:bg-slate-700'
    }`;

  return (
    <section
      id="settings"
      aria-label="Cast settings"
      className="border border-slate-800/90 bg-slate-900/50 rounded-lg p-6 scroll-mt-24"
      data-testid="cast-settings"
    >
      <div className="flex items-center justify-between gap-3 pb-4 mb-5 border-b border-slate-800/80">
        <h2 className="text-sm font-semibold text-white flex items-center gap-2">
          <SlidersHorizontal className="w-4 h-4 text-sky-400" />
          Settings
        </h2>
        <button
          type="button"
          onClick={() => onChange(() => DEFAULT_SETTINGS)}
          className="px-2.5 py-1 text-xs text-slate-300 hover:text-white bg-slate-800/80 hover:bg-slate-800 rounded flex items-center gap-1.5"
        >
          <RotateCcw className="w-3 h-3" />
          Reset
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <label htmlFor="codec-select" className="block text-xs font-medium text-slate-300 mb-1.5">
            Video format (tried first)
          </label>
          <select
            id="codec-select"
            value={settings.codec}
            onChange={(e) => onChange((prev) => ({ ...prev, codec: e.target.value as CastSettings['codec'] }))}
            className="w-full bg-slate-950 border border-slate-800 rounded-md px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-sky-500"
          >
            {CODEC_OPTIONS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
          <p className="text-xs text-slate-400 mt-1.5">
            {codecHint} If the TV can&apos;t play it, Uv Link switches format by itself.
          </p>
        </div>

        <div>
          <span className="block text-xs font-medium text-slate-300 mb-1.5">Frame rate</span>
          <div className="flex gap-1.5" role="group" aria-label="Frame rate">
            {FRAME_RATES.map((fps) => (
              <button
                key={fps}
                type="button"
                aria-pressed={settings.targetFps === fps}
                onClick={() => onChange((prev) => ({ ...prev, targetFps: fps }))}
                className={button(settings.targetFps === fps)}
              >
                {fps} fps
              </button>
            ))}
          </div>
          <p className="text-xs text-slate-400 mt-1.5">
            {settings.targetFps === 120
              ? tvMaxFps !== null && tvMaxFps >= 120
                ? 'This TV can show 120 Hz: it switches to 120 Hz while casting.'
                : `120 fps needs a 120 Hz TV running the Uv Link TV app.${tvMaxFps !== null ? ` This TV shows up to ${tvMaxFps} fps, so it gets ${tvMaxFps}.` : ''}`
              : 'Lower frame rates use less bandwidth and are easier for slow TVs.'}
          </p>
        </div>

        <div>
          <span className="block text-xs font-medium text-slate-300 mb-1.5">Quality cap</span>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Quality cap">
            {(Object.keys(QUALITY_PRESETS) as QualityPreset[]).map((key) => (
              <button
                key={key}
                type="button"
                aria-pressed={settings.quality === key}
                onClick={() => onChange((prev) => ({ ...prev, quality: key }))}
                className={button(settings.quality === key)}
              >
                {QUALITY_PRESETS[key].label}
              </button>
            ))}
          </div>
          <p className="text-xs text-slate-400 mt-1.5">{QUALITY_PRESETS[settings.quality].hint}</p>
        </div>

        <div>
          <label htmlFor="degradation-select" className="block text-xs font-medium text-slate-300 mb-1.5">
            When the network is busy
          </label>
          <select
            id="degradation-select"
            value={settings.degradationPreference}
            onChange={(e) =>
              onChange((prev) => ({ ...prev, degradationPreference: e.target.value as RTCDegradationPreference }))
            }
            className="w-full bg-slate-950 border border-slate-800 rounded-md px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-sky-500"
          >
            <option value="maintain-framerate">Keep it smooth (lower sharpness)</option>
            <option value="maintain-resolution">Keep it sharp (lower frame rate)</option>
            <option value="balanced">Balance both</option>
          </select>
          <p className="text-xs text-slate-400 mt-1.5">Games and video: smooth. Text and documents: sharp.</p>
        </div>
      </div>
    </section>
  );
};
