"use client";

// Tabs and table pattern copied from v1 components/Sidebar.tsx (PairLists); columns and the third tab are new.
import { useState } from "react";
import type { DecoupleRow, PairRow } from "../lib/types";
import { capPairs, fmt } from "../lib/scales";

type Tab = "hidden" | "apart" | "decouple";
const COPY: Record<Tab, { tab: string; blurb: string }> = {
  hidden: {
    tab: "Hidden twins",
    blurb: "Among the 1% most correlated stock pairs, the ones with the least similar businesses. Out of sample, these kept ~70% of their extra correlation the next year: a real shared exposure.",
  },
  apart: {
    tab: "Lookalikes",
    blurb: "Among the 1% most similar businesses, the pairs with the lowest correlation. They tend to re-couple, but betting on prices converging didn't pay in testing. A risk signal, not a trade.",
  },
  decouple: {
    tab: "Decoupling now",
    blurb: "Pairs that held a residual correlation of 0.3+ in at least 5 calendar years, but whose last 60 days sit more than 0.3 below their long-run level.",
  },
};

export function ProLists({ hidden, apart, decouple, ok, active, onPick }: {
  hidden: PairRow[]; apart: PairRow[]; decouple: DecoupleRow[];
  ok: (t: string) => boolean;
  active: { a: string; b: string } | null;
  onPick: (a: string, b: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("hidden");
  const src = tab === "hidden" ? hidden : tab === "apart" ? apart : decouple;
  const filtered = src.filter((p) => ok(p.a) && ok(p.b));
  const rows = capPairs(filtered);
  const isOn = (p: { a: string; b: string }) => active?.a === p.a && active?.b === p.b;
  return (
    <section className="rounded-lg border border-line bg-surface-2/60 p-4">
      <div role="tablist" aria-label="Pair lists" className="flex gap-4 border-b border-line text-sm">
        {(Object.keys(COPY) as Tab[]).map((k) => (
          <button key={k} role="tab" type="button" aria-selected={tab === k} onClick={() => setTab(k)}
            className={`-mb-px whitespace-nowrap border-b-2 pb-2 focus-visible:outline-2 focus-visible:outline-accent ${
              tab === k ? "border-ink font-medium text-ink" : "border-transparent text-ink-2 hover:text-ink"
            }`}>
            {COPY[k].tab}
          </button>
        ))}
      </div>
      <p className="mt-3 text-xs text-ink-2">{COPY[tab].blurb}</p>
      <table className="mt-3 w-full text-sm tabular-nums">
        <thead>
          {tab === "decouple" ? (
            <tr className="text-left text-xs text-ink-3">
              <th className="pb-1 font-normal">Pair</th>
              <th className="pb-1 text-right font-normal">Long-run</th>
              <th className="pb-1 text-right font-normal">Last 60d</th>
              <th className="pb-1 text-right font-normal">Held</th>
            </tr>
          ) : (
            <tr className="text-left text-xs text-ink-3">
              <th className="pb-1 font-normal">Pair</th>
              <th className="pb-1 text-right font-normal">Corr</th>
              <th className="pb-1 text-right font-normal" title="Business-text similarity percentile among all stock pairs">Text sim</th>
              <th className="pb-1 text-right font-normal" title="Calendar years with correlation of 0.3 or more">Held</th>
            </tr>
          )}
        </thead>
        <tbody>
          {tab === "decouple"
            ? (rows as DecoupleRow[]).map((p) => (
                <tr key={`${p.a}-${p.b}`} className={isOn(p) ? "bg-surface" : ""}>
                  <PairCell p={p} on={isOn(p)} onPick={onPick} />
                  <td className="py-0.5 text-right text-ink-2">{fmt(p.longRun)}</td>
                  <td className="py-0.5 text-right text-ink-2">{fmt(p.recent)}</td>
                  <td className="py-0.5 text-right text-ink-3">{p.k}/{p.n}</td>
                </tr>
              ))
            : (rows as PairRow[]).map((p) => (
                <tr key={`${p.a}-${p.b}`} className={isOn(p) ? "bg-surface" : ""}>
                  <PairCell p={p} on={isOn(p)} onPick={onPick} />
                  <td className="py-0.5 text-right text-ink-2">{fmt(p.corr)}</td>
                  <td className="py-0.5 text-right text-ink-2" title={`More similar than ${p.simPct}% of stock pairs`}>
                    {p.simPct >= 99.95 ? "99.9" : p.simPct.toFixed(p.simPct >= 99 ? 1 : 0)}th
                  </td>
                  <td className="py-0.5 text-right text-ink-3">{p.k}/{p.n}</td>
                </tr>
              ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-ink-3">
        Showing {rows.length} of {src.length} pairs: at most 2 per stock{filtered.length < src.length ? ", within your filters" : ""}.
      </p>
    </section>
  );
}

function PairCell({ p, on, onPick }: { p: { a: string; b: string }; on: boolean; onPick: (a: string, b: string) => void }) {
  return (
    <td className="py-0.5">
      <button type="button" onClick={() => onPick(p.a, p.b)} aria-pressed={on} aria-label={`${p.a} and ${p.b}`}
        className={`text-left hover:underline focus-visible:outline-2 focus-visible:outline-accent ${on ? "font-semibold" : ""} text-ink`}>
        {p.a} <span className="text-ink-3">↔</span> {p.b}
      </button>
    </td>
  );
}
