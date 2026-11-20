"use client";

// Tabs and table pattern copied from v1 components/Sidebar.tsx (PairLists); columns and the third tab are new.
import { useState } from "react";
import type { DecoupleRow, PairRow } from "../lib/types";
import { capPairs, fmt, pctNum } from "../lib/scales";

type Tab = "hidden" | "apart" | "decouple";
const STABLE = "Only pairs whose correlation held at 0.3+ in at least 6 of 11 calendar years (or 60% of a shorter history, minimum 4 years).";
const COPY: Record<Tab, { tab: string; blurb: string }> = {
  hidden: {
    tab: "Hidden twins",
    blurb: `Among the 1% most correlated stock pairs, the ones with the least similar businesses: a shared exposure the descriptions don't mention. ${STABLE}`,
  },
  apart: {
    tab: "Lookalikes",
    blurb: `Among the 1% most similar businesses, the pairs trading least alike over the last 2 years. ${STABLE} A risk signal, not a trade: betting on convergence didn't pay in testing.`,
  },
  decouple: {
    tab: "Decoupling now",
    blurb: "Durable pairs (long-run residual correlation 0.5+, held in 7+ of 11 years) whose last 60 days fell significantly: one-sided Fisher z-test, Benjamini–Hochberg at q = 0.05 across every pair tested.",
  },
};

const WATCH_N = 5;

export function ProLists({ hidden, apart, decouple, watch, tested, ok, active, onPick }: {
  hidden: PairRow[]; apart: PairRow[]; decouple: DecoupleRow[]; watch: DecoupleRow[]; tested: number;
  ok: (t: string) => boolean;
  active: { a: string; b: string } | null;
  onPick: (a: string, b: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("hidden");
  const src = tab === "hidden" ? hidden : tab === "apart" ? apart : decouple;
  const filtered = src.filter((p) => ok(p.a) && ok(p.b));
  const rows = tab === "decouple" ? filtered : capPairs(filtered);
  const isOn = (p: { a: string; b: string }) => active?.a === p.a && active?.b === p.b;
  const watchRows = watch.filter((p) => ok(p.a) && ok(p.b)).slice(0, WATCH_N);
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

      {tab === "decouple" && rows.length === 0 ? (
        <p className="mt-4 rounded-md border border-line bg-surface px-3 py-3 text-sm text-ink-2">
          No significant decouplings today.
          <span className="mt-1 block text-xs text-ink-3">{tested} durable pairs tested; none fell further than chance would explain.</span>
        </p>
      ) : (
        <table className="mt-3 w-full text-sm tabular-nums">
          <thead>
            {tab === "decouple" ? (
              <tr className="text-left text-xs text-ink-3">
                <th className="pb-1 font-normal">Pair</th>
                <th className="pb-1 text-right font-normal">Long-run</th>
                <th className="pb-1 text-right font-normal">Last 60d</th>
                <th className="pb-1 text-right font-normal" title="Benjamini–Hochberg adjusted p-value">Sig.</th>
              </tr>
            ) : (
              <tr className="text-left text-xs text-ink-3">
                <th className="pb-1 font-normal">Pair</th>
                <th className="pb-1 text-right font-normal">Corr</th>
                <th className="pb-1 text-right font-normal" title="Business-text similarity percentile among all stock pairs">Text sim pctl</th>
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
                    <td className="py-0.5 text-right text-ink" title={`z = ${fmt(p.z)}, adjusted p = ${p.q}`}>
                      {p.q < 0.001 ? "▼▼▼" : p.q < 0.01 ? "▼▼" : "▼"}
                    </td>
                  </tr>
                ))
              : (rows as PairRow[]).map((p) => (
                  <tr key={`${p.a}-${p.b}`} className={`align-top ${isOn(p) ? "bg-surface" : ""}`}>
                    <PairCell p={p} on={isOn(p)} onPick={onPick} theme={p.theme} />
                    <td className="py-0.5 text-right text-ink-2">{fmt(p.corr)}</td>
                    <td className="py-0.5 text-right text-ink-2" title={`More similar than ${p.simPct}% of stock pairs`}>
                      {pctNum(p.simPct)}
                    </td>
                    <td className="py-0.5 text-right text-ink-3">{p.k}/{p.n}</td>
                  </tr>
                ))}
          </tbody>
        </table>
      )}
      <p className="mt-2 text-xs text-ink-3">
        {tab === "decouple"
          ? rows.length > 0 && `${rows.length} of ${tested} durable pairs pass. ▼ adjusted p < 0.05, ▼▼ < 0.01, ▼▼▼ < 0.001.`
          : `Showing ${rows.length} of ${src.length} pairs: at most 2 per stock${filtered.length < src.length ? ", within your filters" : ""}.`}
      </p>
      {tab === "decouple" && watchRows.length > 0 && <Watchlist rows={watchRows} isOn={isOn} onPick={onPick} />}
    </section>
  );
}

function Watchlist({ rows, isOn, onPick }: {
  rows: DecoupleRow[]; isOn: (p: { a: string; b: string }) => boolean; onPick: (a: string, b: string) => void;
}) {
  return (
    <div className="mt-4 border-t border-line pt-3 text-ink-3">
      <h3 className="text-xs font-medium text-ink-3">Closest to breaking (not significant yet)</h3>
      <p className="mt-0.5 text-[11px]">Watch only. These haven&apos;t fallen further than chance would explain.</p>
      <table className="mt-2 w-full text-sm tabular-nums">
        <thead>
          <tr className="text-left text-xs">
            <th className="pb-1 font-normal">Pair</th>
            <th className="pb-1 text-right font-normal">Long-run</th>
            <th className="pb-1 text-right font-normal">Last 60d</th>
            <th className="pb-1 text-right font-normal" title="Fisher z of the fall: more negative = bigger fall relative to chance">z</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={`${p.a}-${p.b}`} className={isOn(p) ? "bg-surface" : ""}>
              <td className="py-0.5">
                <button type="button" onClick={() => onPick(p.a, p.b)} aria-pressed={isOn(p)} aria-label={`${p.a} and ${p.b}`}
                  className={`text-left text-ink-2 hover:underline focus-visible:outline-2 focus-visible:outline-accent ${isOn(p) ? "font-semibold" : ""}`}>
                  {p.a} <span className="text-ink-3">↔</span> {p.b}
                </button>
              </td>
              <td className="py-0.5 text-right">{fmt(p.longRun)}</td>
              <td className="py-0.5 text-right">{fmt(p.recent)}</td>
              <td className="py-0.5 text-right" title={`adjusted p = ${p.q}`}>{fmt(p.z)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PairCell({ p, on, onPick, theme }: { p: { a: string; b: string }; on: boolean; onPick: (a: string, b: string) => void; theme?: string }) {
  return (
    <td className="py-0.5">
      <button type="button" onClick={() => onPick(p.a, p.b)} aria-pressed={on} aria-label={`${p.a} and ${p.b}`}
        className={`text-left hover:underline focus-visible:outline-2 focus-visible:outline-accent ${on ? "font-semibold" : ""} text-ink`}>
        {p.a} <span className="text-ink-3">↔</span> {p.b}
      </button>
      {theme && (
        <span className="ml-1.5 inline-block whitespace-nowrap rounded-full border border-line bg-surface px-1.5 align-middle text-[10px] leading-4 text-ink-2">
          {theme}
        </span>
      )}
    </td>
  );
}
