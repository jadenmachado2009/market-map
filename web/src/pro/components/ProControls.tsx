"use client";

// Segmented / Search / SectorSelect copied from v1 components/Controls.tsx; FilterBar and Legend are new.
import { useMemo, useState } from "react";
import type { Asset, AssetClass, Filters } from "../lib/types";
import { CLASS_LABEL, DEFAULT_FILTERS, activeFilterCount, type Bin } from "../lib/scales";

export function Segmented<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-md border border-line bg-surface-2 p-0.5 text-sm">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={`whitespace-nowrap rounded px-2.5 py-1 transition-colors focus-visible:outline-2 focus-visible:outline-accent ${
            value === o.value ? "bg-surface font-medium text-ink shadow-sm" : "text-ink-2 hover:text-ink"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Legend({ title, note, bins, counts, extra }: { title: string; note: string; bins: Bin[]; counts: number[]; extra?: React.ReactNode }) {
  return (
    <div className="text-xs text-ink-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="font-medium text-ink">{title}</span>
        {bins.map((b, i) => (
          <span key={b.label} className="inline-flex items-center gap-1.5 tabular-nums">
            <span className="inline-block size-2.5 rounded-full" style={{ background: b.color }} />
            {b.label}
            <span className="text-ink-3">({counts[i] ?? 0})</span>
          </span>
        ))}
        {extra}
      </div>
      <p className="mt-1 text-ink-3">{note}</p>
    </div>
  );
}

export const DiamondKey = () => (
  <span className="inline-flex items-center gap-1.5">
    <svg width="10" height="10" aria-hidden="true"><path d="M5 0L10 5L5 10L0 5Z" fill="var(--pro-point)" /></svg>
    ETFs, FX, commodities, bonds, crypto (behaviour map only)
  </span>
);

export function SectorSelect({ sectors, value, onChange }: { sectors: { name: string; n: number }[]; value: string | null; onChange: (s: string | null) => void }) {
  return (
    <select
      aria-label="Sector to highlight"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      className="rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink focus:outline-2 focus:outline-accent"
    >
      <option value="">Pick a sector…</option>
      {sectors.map((s) => (
        <option key={s.name} value={s.name}>
          {s.name} ({s.n})
        </option>
      ))}
    </select>
  );
}

const MCAP = [0, 10, 50, 200];
const ADV = [0, 25, 100, 500];
const VOL: [string, number, number][] = [
  ["Any", 0, Infinity],
  ["Under 25%", 0, 0.25],
  ["25–40%", 0.25, 0.4],
  ["40–60%", 0.4, 0.6],
  ["Over 60%", 0.6, Infinity],
];

export function FilterBar({ filters, onChange, shown, total }: { filters: Filters; onChange: (f: Filters) => void; shown: number; total: number }) {
  const [open, setOpen] = useState(false);
  const n = activeFilterCount(filters);
  const volKey = VOL.findIndex(([, lo, hi]) => lo === filters.volMin && hi === filters.volMax);
  const sel = "rounded-md border border-line bg-surface px-2 py-1 text-sm text-ink focus:outline-2 focus:outline-accent";
  return (
    <div className="text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="rounded-md border border-line bg-surface-2 px-2.5 py-1 text-ink-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
        >
          Filters{n ? ` · ${n} on` : ""} {open ? "▴" : "▾"}
        </button>
        <span className="text-xs tabular-nums text-ink-3">
          {shown} of {total} assets shown
        </span>
        {n > 0 && (
          <button type="button" onClick={() => onChange(DEFAULT_FILTERS)} className="text-xs text-ink-3 underline hover:text-ink">
            Clear
          </button>
        )}
      </div>
      {open && (
        <div className="mt-2 grid gap-3 rounded-md border border-line bg-surface-2/60 p-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="flex flex-col gap-1 text-xs text-ink-3">
            Market cap (stocks)
            <select className={sel} value={filters.mcapMin} onChange={(e) => onChange({ ...filters, mcapMin: Number(e.target.value) })}>
              {MCAP.map((v) => (
                <option key={v} value={v}>{v ? `$${v}B or more` : "Any"}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-3">
            Volatility (1 year)
            <select className={sel} value={Math.max(0, volKey)} onChange={(e) => {
              const [, lo, hi] = VOL[Number(e.target.value)];
              onChange({ ...filters, volMin: lo, volMax: hi });
            }}>
              {VOL.map(([l], i) => (
                <option key={l} value={i}>{l}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-3">
            Daily dollar volume (3 months)
            <select className={sel} value={filters.advMin} onChange={(e) => onChange({ ...filters, advMin: Number(e.target.value) })}>
              {ADV.map((v) => (
                <option key={v} value={v}>{v ? `$${v}M or more` : "Any"}</option>
              ))}
            </select>
          </label>
          <fieldset className="flex flex-col gap-1 text-xs text-ink-3">
            <legend className="mb-1">Asset class</legend>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {(Object.keys(CLASS_LABEL) as AssetClass[]).map((c) => (
                <label key={c} className="inline-flex items-center gap-1 text-ink-2">
                  <input
                    type="checkbox"
                    checked={filters.classes[c]}
                    onChange={(e) => onChange({ ...filters, classes: { ...filters.classes, [c]: e.target.checked } })}
                    className="accent-[var(--accent)]"
                  />
                  {CLASS_LABEL[c]}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      )}
    </div>
  );
}

export function Search({ assets, onPick }: { assets: Asset[]; onPick: (t: string) => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    const byTicker = assets.filter((x) => x.t.toLowerCase().startsWith(s));
    const byName = assets.filter((x) => !byTicker.includes(x) && x.name.toLowerCase().includes(s));
    return [...byTicker.sort((a, b) => a.t.length - b.t.length), ...byName].slice(0, 8);
  }, [q, assets]);
  const pick = (t: string) => {
    onPick(t);
    setQ("");
    setOpen(false);
  };
  return (
    <div className="relative w-full">
      <input
        type="search"
        value={q}
        placeholder="Find a stock or asset"
        aria-label="Find a stock or asset"
        role="combobox"
        aria-expanded={open && matches.length > 0}
        aria-controls="pro-search-results"
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && matches[0]) pick(matches[0].t);
          if (e.key === "Escape") {
            setQ("");
            setOpen(false);
          }
        }}
        className="w-full rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-ink placeholder:text-ink-3 focus:outline-2 focus:outline-accent"
      />
      {open && matches.length > 0 && (
        <ul id="pro-search-results" role="listbox" className="absolute right-0 z-20 mt-1 w-full overflow-hidden rounded-md border border-line bg-surface text-sm shadow-md">
          {matches.map((m) => (
            <li key={m.t} role="option" aria-selected={false}>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(m.t)}
                className="flex w-full gap-2 px-3 py-1.5 text-left hover:bg-surface-2">
                <span className="w-16 shrink-0 font-medium text-ink">{m.t}</span>
                <span className="truncate text-ink-2">{m.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
