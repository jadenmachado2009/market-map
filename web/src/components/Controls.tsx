"use client";

import { useMemo, useState } from "react";
import type { Stock } from "@/lib/types";
import { seq, type Bin } from "@/lib/scales";
import { searchStocks, shortName } from "@/lib/plain";
import { ThemeWord } from "./Glossary";

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; title?: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-md border border-line bg-surface-2 p-0.5 text-sm">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          title={o.title}
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

export function BinLegend({ title, note, bins, counts }: { title: React.ReactNode; note: string; bins: Bin[]; counts: number[] }) {
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

/** Legend for the Surprise colouring: the same five steps, described in words. */
export function SurpriseLegend({ counts }: { counts: number[] }) {
  return (
    <div className="text-xs text-ink-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium text-ink">How surprising is this stock?</span>
        <span className="inline-flex items-center gap-1" aria-hidden="true">
          {counts.map((_, i) => (
            <span key={i} className="inline-block size-2.5 rounded-full" style={{ background: seq(i) }} />
          ))}
        </span>
      </div>
      <ul className="mt-1 space-y-0.5">
        <li className="flex items-start gap-1.5">
          <span className="mt-[3px] inline-block size-2.5 shrink-0 rounded-full" style={{ background: seq(0) }} />
          <span>
            <span className="font-medium text-ink">
              <ThemeWord light="Dark blue" dark="Bright" />
            </span>{" "}
            = trades with a different crowd than its business peers
          </span>
        </li>
        <li className="flex items-start gap-1.5">
          <span className="mt-[3px] inline-block size-2.5 shrink-0 rounded-full" style={{ background: seq(counts.length - 1) }} />
          <span>
            <span className="font-medium text-ink">
              <ThemeWord light="Light blue" dark="Faded" />
            </span>{" "}
            = trades with the companies you&apos;d expect
          </span>
        </li>
      </ul>
      <p className="mt-1 text-ink-3">
        Based on how many of each stock&apos;s 10 closest price matches are also among the 10 businesses it most resembles
        ({counts[0]} stocks share none or one; {counts[counts.length - 1]} share six or more).
      </p>
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
      aria-label="Industry to highlight"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      className="rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink focus:outline-2 focus:outline-accent"
    >
      <option value="">Pick an industry…</option>
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
  const matches = useMemo(() => searchStocks(q, stocks), [q, stocks]);

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
        placeholder="Find a company (name or ticker)"
        aria-label="Find a company"
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
                className="flex w-full items-baseline justify-between gap-2 px-3 py-1.5 text-left hover:bg-surface-2"
              >
                <span className="truncate text-ink">{shortName(m)}</span>
                <span className="shrink-0 text-xs font-medium text-ink-3">{m.t}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
