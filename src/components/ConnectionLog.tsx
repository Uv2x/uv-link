import React, { useState } from 'react';
import { ScrollText, Search } from 'lucide-react';
import type { PacketLogItem } from '../shared/protocol';

/** What the Uv Link server relayed between this PC and the TVs (newest first). */
export const ConnectionLog: React.FC<{ entries: PacketLogItem[] }> = ({ entries }) => {
  const [filter, setFilter] = useState('');
  const query = filter.trim().toLowerCase();
  const shown = query
    ? entries.filter((e) => `${e.type} ${e.summary} ${e.direction}`.toLowerCase().includes(query))
    : entries;

  return (
    <section
      id="log"
      aria-label="Connection log"
      className="border border-slate-800/90 bg-slate-900/50 rounded-lg p-6 scroll-mt-24"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 pb-4 mb-4 border-b border-slate-800/80">
        <h2 className="text-sm font-semibold text-white flex items-center gap-2">
          <ScrollText className="w-4 h-4 text-sky-400" />
          Connection log
        </h2>
        <label className="relative">
          <span className="sr-only">Filter the log</span>
          <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter (e.g. STALL, OFFER)"
            className="bg-slate-950 border border-slate-800 rounded-md pl-8 pr-3 py-1.5 text-xs text-slate-200 w-56 focus:outline-none focus:border-sky-500"
          />
        </label>
      </div>
      {shown.length === 0 ? (
        <p className="text-xs text-slate-400">{entries.length === 0 ? 'Nothing yet. TVs joining and casts starting show up here.' : 'No entries match.'}</p>
      ) : (
        <ol className="space-y-1 max-h-72 overflow-y-auto font-mono text-xs" data-testid="connection-log">
          {shown.map((e) => (
            <li key={e.id} className="flex gap-3 py-1 border-b border-slate-800/40 last:border-0">
              <span className="text-slate-500 tabular-nums shrink-0">{e.timestamp}</span>
              <span className="text-slate-400 shrink-0 w-24 truncate">{e.direction}</span>
              <span className="text-sky-300 shrink-0">{e.type}</span>
              <span className="text-slate-300 min-w-0 break-words">{e.summary}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
};
