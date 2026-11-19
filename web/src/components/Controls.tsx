"use client";

import { useMemo, useState } from "react";
import type { Stock } from "@/lib/types";
import { seq, type Bin } from "@/lib/scales";

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-md border border-line bg-surface-2 p-0.5 text-sm">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={`rounded px-3 py-1 transition-colors focus-visible:outline-2 focus-visible:outline-accent ${
            value === o.value ? "bg-surface font-medium text-ink shadow-sm" : "text-ink-2 hover:text-ink"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function BinLegend({ title, note, bins, counts }: { title: string; note: string; bins: Bin[]; counts: number[] }) {
  return (
    <div className="text-xs text-ink-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="font-medium text-ink">{title}</span>
        {bins.map((b, i) => (
          <span key={b.label} className="inline-flex items-center gap-1.5 tabular-nums">
            <span className="inline-block size-2.5 rounded-full" style={{ background: seq(i) }} />
            {b.label}
            <span className="text-ink-3">({counts[i]})</span>
          </span>
        ))}
      </div>
      <p className="mt-1 text-ink-3">{note}</p>
    </div>
  );
}

export function SectorSelect({
  sectors,
  value,
  onChange,
}: {
  sectors: { name: string; n: number }[];
  value: string | null;
  onChange: (s: string | null) => void;
}) {
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

export function Search({ stocks, onPick }: { stocks: Stock[]; onPick: (t: string) => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    const byTicker = stocks.filter((x) => x.t.toLowerCase().startsWith(s));
    const byName = stocks.filter((x) => !byTicker.includes(x) && x.name.toLowerCase().includes(s));
    return [...byTicker.sort((a, b) => a.t.length - b.t.length), ...byName].slice(0, 8);
  }, [q, stocks]);

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
        placeholder="Find a stock (ticker or name)"
        aria-label="Find a stock"
        role="combobox"
        aria-expanded={open && matches.length > 0}
        aria-controls="search-results"
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
        <ul id="search-results" role="listbox" className="absolute right-0 z-20 mt-1 w-full overflow-hidden rounded-md border border-line bg-surface text-sm shadow-md">
          {matches.map((m) => (
            <li key={m.t} role="option" aria-selected={false}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(m.t)}
                className="flex w-full gap-2 px-3 py-1.5 text-left hover:bg-surface-2"
              >
                <span className="w-12 shrink-0 font-medium text-ink">{m.t}</span>
                <span className="truncate text-ink-2">{m.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
