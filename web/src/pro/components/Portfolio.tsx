"use client";

import type { Asset, ClusterLabel } from "../lib/types";
import type { PairMatrix } from "../lib/lazy";
import { neffCov, portfolioVar, riskContrib } from "../lib/math";
import { fmt } from "../lib/scales";

export type PortfolioView = {
  text: string;
  holdings: { i: number; w: number }[];
  unknown: string[];
  weighted: boolean;
};

const EXAMPLE = "NVDA 20, MSFT 15, AVGO 10, JPM 10, BAC 5, XOM 10, DUK 10, NEE 10, O 10";
const pct = (x: number) => `${Math.round(x * 100)}%`;

export function Portfolio({ pf, onText, assets, factorText, matrix, rawCorr, sdRes, clusterIds, clusterLabels, onPickPair, onPick }: {
  pf: PortfolioView;
  onText: (t: string) => void;
  assets: Asset[];
  factorText: string;
  matrix: PairMatrix | null;
  rawCorr: ((i: number, j: number) => number) | null;
  sdRes: (number | null)[];
  clusterIds: number[];
  clusterLabels: ClusterLabel[];
  onPickPair: (a: number, b: number) => void;
  onPick: (t: string) => void;
}) {
  const h = pf.holdings;
  const ready = matrix !== null && rawCorr !== null;
  const w = h.map((x) => x.w);

  // Covariance of daily total returns (2 years, winsorised): Σ_ij = ρ_ij σ_i σ_j
  const sd = (i: number) => assets[i].sd ?? NaN;
  const covT = (a: number, b: number) => (a === b ? 1 : rawCorr!(a, b)) * sd(a) * sd(b);
  const cT = (p: number, q: number) => covT(h[p].i, h[q].i);
  const nTot = ready && h.length ? neffCov(h.length, cT, w) : NaN;
  const rc = ready && h.length ? riskContrib(h.length, cT, w) : [];
  const vol = ready && h.length ? Math.sqrt(portfolioVar(h.length, cT, w) * 252) : NaN;
  const beta = h.reduce((acc, x) => acc + x.w * assets[x.i].beta, 0);

  // Same thing on residual covariance for the active preset. Factor instruments drop out.
  const inP = h.filter((x) => sdRes[x.i] !== null);
  const out = h.filter((x) => sdRes[x.i] === null);
  const covR = (a: number, b: number) => (a === b ? 1 : matrix!.corr(a, b)) * sdRes[a]! * sdRes[b]!;
  const nRes = ready && inP.length ? neffCov(inP.length, (p, q) => covR(inP[p].i, inP[q].i), inP.map((x) => x.w)) : NaN;

  // Capital share vs risk share by cluster, sorted by risk
  const groups = new Map<string, { label: string; cap: number; risk: number; members: string[] }>();
  h.forEach((x, k) => {
    // Every plotted point has a cluster. A holding this preset uses as a factor (SPY; TLT, USMV; …) isn't plotted,
    // so it is grouped by asset class: "Equity ETFs", "Bonds".
    const label = clusterLabels.find((l) => l.id === clusterIds[x.i])?.label ?? assets[x.i].sector;
    const g = groups.get(label) ?? { label, cap: 0, risk: 0, members: [] };
    g.cap += x.w;
    g.risk += rc[k] ?? 0;
    g.members.push(assets[x.i].t);
    groups.set(label, g);
  });
  const grouped = [...groups.values()].sort((a, b) => b.risk - a.risk);

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
      {pf.unknown.length > 0 && <p className="mt-1 text-xs text-ink-3">Not on the map: {pf.unknown.join(", ")}</p>}

      {h.length > 0 && (
        <div className="mt-3">
          {!ready ? (
            <p className="text-sm text-ink-3">Crunching covariances…</p>
          ) : (
            <>
              <p className="text-base leading-snug text-ink">
                Your {h.length} holding{h.length === 1 ? "" : "s"} {h.length === 1 ? "is" : "are"} really{" "}
                <span className="text-2xl font-semibold tabular-nums">~{fmt(nTot, 1)}</span> independent bet
                {Math.abs(nTot - 1) < 0.05 ? "" : "s"}.
              </p>
              <p className="mt-1 text-xs text-ink-3">
                After removing {factorText}: <span className="tabular-nums text-ink-2">~{fmt(nRes, 1)}</span>.
                {out.length > 0 &&
                  ` ${out.map((x) => assets[x.i].t).join(", ")} ${out.length === 1 ? "is a factor" : "are factors"} here, so left out of that number.`}
              </p>
              <dl className="mt-2 flex gap-5 text-sm">
                <div>
                  <dt className="text-xs text-ink-3">Volatility</dt>
                  <dd className="tabular-nums text-ink">{pct(vol)} a year</dd>
                </div>
                <div>
                  <dt className="text-xs text-ink-3">Beta to S&amp;P 500</dt>
                  <dd className="tabular-nums text-ink">{fmt(beta)}</dd>
                </div>
              </dl>

              <h3 className="mt-3 text-xs font-medium text-ink-2">What it&apos;s betting on</h3>
              <table className="mt-1 w-full text-sm tabular-nums">
                <thead>
                  <tr className="text-left text-xs text-ink-3">
                    <th className="pb-1 font-normal">Cluster</th>
                    <th className="pb-1 text-right font-normal">% of capital</th>
                    <th className="pb-1 text-right font-normal">% of risk</th>
                  </tr>
                </thead>
                <tbody>
                  {grouped.map((g) => {
                    const heavy = g.risk - g.cap >= 0.1;
                    return (
                      <tr key={g.label} className={`align-top ${heavy ? "bg-surface" : ""}`}>
                        <td className="py-1 pr-2">
                          <span className={heavy ? "font-semibold text-ink" : "text-ink"}>{g.label}</span>
                          {heavy && (
                            <span className="ml-1.5 whitespace-nowrap text-[11px] text-ink-2" title="Risk share exceeds capital share by 10+ points">
                              ▲ risk-heavy
                            </span>
                          )}
                          <span className="block text-[11px] text-ink-3">{g.members.join(", ")}</span>
                        </td>
                        <td className="py-1 text-right text-ink-2">{pct(g.cap)}</td>
                        <td className={`py-1 text-right ${heavy ? "font-semibold text-ink" : "text-ink-2"}`}>{pct(g.risk)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

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
                Uses the covariance of daily returns over 2 years, so volatility counts: one wild holding outweighs several calm ones.
                Bets = (Σλ)² / Σλ² for the eigenvalues of diag(w) Σ diag(w). Risk share = wᵢ(Σw)ᵢ / wᵀΣw. Saved in this browser only.{" "}
                <button type="button" onClick={() => onPick(assets[h[0].i].t)} className="underline hover:text-ink">Show first holding</button>
              </p>
            </>
          )}
        </div>
      )}
    </section>
  );
}
