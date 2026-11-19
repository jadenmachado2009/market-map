"use client";

import type { Asset, ClusterLabel } from "../lib/types";
import type { PairMatrix } from "../lib/lazy";
import { neff } from "../lib/math";
import { fmt } from "../lib/scales";

export type PortfolioView = {
  text: string;
  holdings: { i: number; w: number }[];
  unknown: string[];
  weighted: boolean;
};

const EXAMPLE = "NVDA 20, MSFT 15, AVGO 10, JPM 10, BAC 5, XOM 10, DUK 10, NEE 10, O 10";

export function Portfolio({ pf, onText, assets, presetLabel, matrix, rawCorr, clusterIds, clusterLabels, onPickPair, onPick }: {
  pf: PortfolioView;
  onText: (t: string) => void;
  assets: Asset[];
  presetLabel: string;
  matrix: PairMatrix | null;
  rawCorr: ((i: number, j: number) => number) | null;
  clusterIds: number[];
  clusterLabels: ClusterLabel[];
  onPickPair: (a: number, b: number) => void;
  onPick: (t: string) => void;
}) {
  const h = pf.holdings;
  // Holdings that are a factor in this preset have no residual series: they drop out of the residual maths.
  const inPreset = matrix ? h.filter((x) => h.every((y) => x === y || Number.isFinite(matrix.corr(x.i, y.i)))) : [];
  const out = matrix ? h.filter((x) => !inPreset.includes(x)) : [];
  const nRes = matrix && inPreset.length ? neff(inPreset.length, (p, q) => matrix.corr(inPreset[p].i, inPreset[q].i), inPreset.map((x) => x.w)) : NaN;
  const nTot = rawCorr && h.length ? neff(h.length, (p, q) => rawCorr(h[p].i, h[q].i), h.map((x) => x.w)) : NaN;

  // Grouped by cluster name: two clusters can share a name, and the reader only sees the name.
  const groups = new Map<string, { label: string; w: number; members: string[] }>();
  for (const x of h) {
    const c = clusterIds[x.i] ?? -1;
    const label = c === -1 ? "Not in a cluster" : clusterLabels.find((l) => l.id === c)?.label ?? `Cluster ${c}`;
    const g = groups.get(label) ?? { label, w: 0, members: [] };
    g.w += x.w;
    g.members.push(assets[x.i].t);
    groups.set(label, g);
  }
  const grouped = [...groups.values()].sort((a, b) => b.w - a.w);

  const flags: { a: number; b: number; c: number }[] = [];
  if (matrix)
    for (let p = 0; p < h.length; p++)
      for (let q = p + 1; q < h.length; q++) {
        const c = matrix.corr(h[p].i, h[q].i);
        if (c >= 0.5) flags.push({ a: h[p].i, b: h[q].i, c });
      }
  flags.sort((x, y) => y.c - x.c);

  return (
    <section className="rounded-lg border border-line bg-surface-2/60 p-4" aria-labelledby="xray">
      <h2 id="xray" className="text-sm font-semibold text-ink">Portfolio X-ray</h2>
      <label className="mt-2 block text-xs text-ink-3" htmlFor="pf-input">
        Tickers with optional weights. No weights means equal weight.
      </label>
      <textarea
        id="pf-input"
        rows={2}
        value={pf.text}
        onChange={(e) => onText(e.target.value)}
        placeholder={EXAMPLE}
        spellCheck={false}
        className="mt-1 w-full resize-y rounded-md border border-line bg-surface px-2.5 py-1.5 font-mono text-xs text-ink placeholder:text-ink-3 focus:outline-2 focus:outline-accent"
      />
      {!pf.text && (
        <button type="button" onClick={() => onText(EXAMPLE)} className="mt-1 text-xs text-ink-3 underline hover:text-ink">
          Try an example
        </button>
      )}
      {pf.unknown.length > 0 && (
        <p className="mt-1 text-xs text-ink-3">Not on the map: {pf.unknown.join(", ")}</p>
      )}

      {h.length > 0 && (
        <div className="mt-3">
          {!matrix ? (
            <p className="text-sm text-ink-3">Crunching correlations…</p>
          ) : (
            <>
              <p className="text-base leading-snug text-ink">
                Your {h.length} holding{h.length === 1 ? "" : "s"} {h.length === 1 ? "is" : "are"} really{" "}
                <span className="text-2xl font-semibold tabular-nums">~{fmt(nRes, 1)}</span> independent bet{Math.abs(nRes - 1) < 0.05 ? "" : "s"}.
              </p>
              <p className="mt-1 text-xs text-ink-3">
                After removing {presetLabel === "Market" ? "the market" : presetLabel.replace("+", "market +").toLowerCase()}.
                Counting the market too (total returns): <span className="tabular-nums text-ink-2">~{fmt(nTot, 1)}</span>.
                {out.length > 0 && ` ${out.map((x) => assets[x.i].t).join(", ")} ${out.length === 1 ? "is a factor" : "are factors"} in this preset, so left out.`}
              </p>

              <h3 className="mt-3 text-xs font-medium text-ink-2">What it&apos;s betting on (by cluster)</h3>
              <ul className="mt-1 space-y-1 text-sm">
                {grouped.map((g) => (
                  <li key={g.label} className="grid grid-cols-[1fr_auto] gap-x-2">
                    <span className="truncate text-ink" title={g.label}>{g.label}</span>
                    <span className="tabular-nums text-ink-2">{Math.round(g.w * 100)}%</span>
                    <span className="col-span-2 -mt-0.5 text-[11px] text-ink-3">{g.members.join(", ")}</span>
                  </li>
                ))}
              </ul>

              <h3 className="mt-3 text-xs font-medium text-ink-2">Pairs moving together (residual corr ≥ 0.5)</h3>
              {flags.length ? (
                <ul className="mt-1 flex flex-wrap gap-1.5 text-xs">
                  {flags.map((f) => (
                    <li key={`${f.a}-${f.b}`}>
                      <button type="button" onClick={() => onPickPair(f.a, f.b)}
                        className="rounded border border-line bg-surface px-1.5 py-0.5 tabular-nums text-ink hover:border-ink-3">
                        {assets[f.a].t} ↔ {assets[f.b].t} <span className="text-ink-2">{fmt(f.c)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-xs text-ink-3">None. No two holdings are that tightly linked.</p>
              )}
              <p className="mt-3 text-[11px] text-ink-3">
                Effective bets = (Σλ)² / Σλ² for the eigenvalues of the weighted correlation matrix. 1 = one bet, n = fully independent. Saved in this browser only.{" "}
                <button type="button" onClick={() => onPick(assets[h[0].i].t)} className="underline hover:text-ink">Show first holding</button>
              </p>
            </>
          )}
        </div>
      )}
    </section>
  );
}
