"use client";

import { useState } from "react";
import type { Asset, NnBeh, NnBiz } from "../lib/types";
import type { PairMatrix } from "../lib/lazy";
import { hedge, hedgeUnstable, splitHedges } from "../lib/math";
import { fmt, money, pctLabel } from "../lib/scales";

const LIQUID_ADV = 20; // $m a day: hedges must be easy to trade
type Corr = ((i: number, j: number) => number) | null;

const Card = ({ children }: { children: React.ReactNode }) => (
  <section className="rounded-lg border border-line bg-surface-2/60 p-4">{children}</section>
);

const Tick = ({ t, onPick, strong }: { t: string; onPick: (t: string) => void; strong?: boolean }) => (
  <button type="button" onClick={() => onPick(t)}
    className={`underline decoration-line underline-offset-2 hover:decoration-ink-2 focus-visible:outline-2 focus-visible:outline-accent ${strong ? "font-semibold" : ""} text-ink`}>
    {t}
  </button>
);

export function RiskCard({ i, a, presetLabel, exposureNames, exposure, nnBeh, nnBiz, firstYear, matrix, raw2, raw1, assets, passes, onPick, onPickPair, onClose }: {
  i: number;
  a: Asset;
  presetLabel: string;
  exposureNames: string[];
  exposure: number[] | null;
  nnBeh: NnBeh[] | null;
  nnBiz: NnBiz[] | null;
  firstYear: number;
  matrix: PairMatrix | null;
  raw2: Corr;
  raw1: Corr;
  assets: Asset[];
  passes: (j: number) => boolean;
  onPick: (t: string) => void;
  onPickPair: (j: number) => void;
  onClose: () => void;
}) {
  const bizSet = new Set((nnBiz ?? []).map(([t]) => t));
  const behSet = new Set((nnBeh ?? []).map(([t]) => t));
  const index = new Map(assets.map((x, j) => [x.t, j]));
  return (
    <Card>
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold leading-tight text-ink">
            {a.t} <span className="font-normal text-ink-2">{a.name}</span>
          </h2>
          <p className="text-xs text-ink-3">{a.cls === "stock" ? `${a.sector} · ${a.sub}` : a.sector}</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="rounded px-1.5 text-ink-3 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent">✕</button>
      </div>

      <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
        <Stat label="Market cap" value={a.cls === "stock" ? money(a.mcap) : "–"} />
        <Stat label="Volatility (1y)" value={a.vol === null ? "–" : `${Math.round(a.vol * 100)}%`} />
        <Stat label="Beta to S&P 500" value={fmt(a.beta)} />
      </dl>

      <h3 className="mt-4 text-xs font-medium text-ink-2">Factor exposures · {presetLabel}</h3>
      {exposure ? (
        <ul className="mt-1.5 space-y-1">
          {exposureNames.map((name, k) => (
            <ExposureBar key={name} name={name} v={exposure[k]} />
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-xs text-ink-3">{a.t} is itself one of this preset&apos;s factors.</p>
      )}

      <div className="mt-4 grid grid-cols-2 gap-4 text-sm">
        <div>
          <ListHead solid title="Trades with" />
          {nnBeh ? (
            <ol className="space-y-0.5">
              {nnBeh.map(([t, c, k, n]) => (
                <li key={t} className="flex items-baseline justify-between gap-1 tabular-nums">
                  <span className="flex items-baseline gap-1">
                    <Tick t={t} onPick={onPick} strong={bizSet.has(t)} />
                    <button type="button" title="Open pair view" onClick={() => onPickPair(index.get(t)!)} className="text-[11px] text-ink-3 hover:text-ink">↗</button>
                  </span>
                  <span className="text-ink-2">
                    {fmt(c)} <span className="text-[11px] text-ink-3" title={`Held (≥0.3) in ${k} of ${n} calendar years`}>{k}/{n}y</span>
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-xs text-ink-3">Not in this preset.</p>
          )}
        </div>
        <div>
          <ListHead title="Reads like" />
          {nnBiz ? (
            <ol className="space-y-0.5">
              {nnBiz.map(([t, pct]) => (
                <li key={t} className="flex items-baseline justify-between gap-1 tabular-nums">
                  <span className="flex items-baseline gap-1">
                    <Tick t={t} onPick={onPick} strong={behSet.has(t)} />
                    <button type="button" title="Open pair view" onClick={() => onPickPair(index.get(t)!)} className="text-[11px] text-ink-3 hover:text-ink">↗</button>
                  </span>
                  <span className="text-[11px] text-ink-2" title={`More similar than ${pct}% of stock pairs`}>{pctLabel(pct)}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-xs text-ink-3">No business text for this asset.</p>
          )}
        </div>
      </div>
      <p className="mt-2 text-[11px] text-ink-3">
        Bold: in both lists. Years held = calendar years since {firstYear} where the correlation was 0.3 or more.
      </p>

      <HedgeFinder i={i} matrix={matrix} raw2={raw2} raw1={raw1} assets={assets} passes={passes} onPickPair={onPickPair} />
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-ink-3">{label}</dt>
      <dd className="tabular-nums text-ink">{value}</dd>
    </div>
  );
}

function ListHead({ title, solid }: { title: string; solid?: boolean }) {
  return (
    <h3 className="mb-1 flex items-center gap-1.5 text-xs font-medium text-ink-2">
      <svg width="18" height="6" aria-hidden="true">
        <line x1="1" y1="3" x2="17" y2="3" stroke={solid ? "var(--ink-2)" : "var(--ink-3)"} strokeWidth={solid ? 1.75 : 1.25} strokeDasharray={solid ? undefined : "3 3"} />
      </svg>
      {title}
    </h3>
  );
}

function ExposureBar({ name, v }: { name: string; v: number }) {
  const lim = 2;
  const w = (Math.min(Math.abs(v), lim) / lim) * 50;
  return (
    <li className="grid grid-cols-[58px_1fr_44px] items-center gap-2 text-xs">
      <span className="text-ink-2">{name}</span>
      <span className="relative h-2.5 rounded-sm bg-surface" aria-hidden="true">
        <span className="absolute inset-y-0 left-1/2 w-px bg-line" />
        <span className="absolute inset-y-0 rounded-sm bg-ink-2" style={v >= 0 ? { left: "50%", width: `${w}%` } : { right: "50%", width: `${w}%` }} />
      </span>
      <span className="text-right tabular-nums text-ink">{fmt(v, 2, true)}</span>
    </li>
  );
}

function HedgeFinder({ i, matrix, raw2, raw1, assets, passes, onPickPair }: {
  i: number; matrix: PairMatrix | null; raw2: Corr; raw1: Corr; assets: Asset[]; passes: (j: number) => boolean; onPickPair: (j: number) => void;
}) {
  const [residual, setResidual] = useState(false);
  const toggle = (
    <button type="button" onClick={() => setResidual(!residual)} aria-pressed={residual}
      className="rounded border border-line px-1.5 py-0.5 text-[11px] text-ink-3 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent">
      {residual ? "Best hedges" : "Residual view"}
    </button>
  );
  const head = (title: string, note: string) => (
    <>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-ink-2">{title}</h3>
        {toggle}
      </div>
      <p className="mt-0.5 text-[11px] text-ink-3">{note}</p>
    </>
  );

  if (residual) {
    if (!matrix) return <div className="mt-4 border-t border-line pt-3">{head("Residual view", "Loading…")}</div>;
    const row = matrix.row(i);
    const cand: number[] = [];
    for (let j = 0; j < row.length; j++) if (j !== i && Number.isFinite(row[j]) && passes(j)) cand.push(j);
    const least = [...cand].sort((x, y) => Math.abs(row[x]) - Math.abs(row[y])).slice(0, 5);
    const neg = [...cand].sort((x, y) => row[x] - row[y]).filter((j) => row[j] < 0).slice(0, 5);
    return (
      <div className="mt-4 border-t border-line pt-3">
        {head("Residual view", "Correlation after removing the preset's factors. For research, not for sizing a hedge.")}
        <div className="mt-2 grid grid-cols-2 gap-4 text-sm">
          <HedgeCol title="Least related" hint="Correlation closest to zero" ids={least} row={row} assets={assets} onPickPair={onPickPair} />
          <HedgeCol title="Most negative" hint="Lowest (most negative) correlation" ids={neg} row={row} assets={assets} onPickPair={onPickPair} />
        </div>
      </div>
    );
  }

  if (!raw2 || !raw1) return <div className="mt-4 border-t border-line pt-3">{head("Best hedges", "Loading…")}</div>;
  const s = assets[i];
  const rows: HedgeRow[] = [];
  for (let j = 0; j < assets.length; j++) {
    const hA = assets[j];
    if (j === i || !passes(j) || (hA.adv ?? 0) < LIQUID_ADV || !hA.sd || !s.sd) continue;
    const rho = raw2(i, j);
    if (!Number.isFinite(rho)) continue;
    const { beta, varCut } = hedge(rho, s.sd, hA.sd);
    const beta1 = s.sd1y && hA.sd1y ? hedge(raw1(i, j), s.sd1y, hA.sd1y).beta : NaN;
    rows.push({ j, beta, varCut, beta1, unstable: hedgeUnstable(beta, beta1) });
  }
  const { etf, peer } = splitHedges(rows, (r) => assets[r.j].cls);
  return (
    <div className="mt-4 border-t border-line pt-3">
      {head("Best hedges", "On daily total returns over 2 years: the hedge ratio β = Cov ÷ Var and the share of variance it removes (ρ²). Liquid assets that pass your filters.")}
      <h4 className="mt-2 text-xs font-medium text-ink-2">ETF hedges</h4>
      {etf.length ? (
        <HedgeRows rows={etf} assets={assets} onPickPair={onPickPair} />
      ) : (
        <p className="mt-1 text-sm text-ink-3">No ETF hedge passes your filters.</p>
      )}
      <h4 className="mt-3 text-xs font-medium text-ink-2">Peer hedges (pair-trade style)</h4>
      {peer.length ? (
        <HedgeRows rows={peer} assets={assets} onPickPair={onPickPair} />
      ) : (
        <p className="mt-1 text-sm text-ink-3">No single stock passes your filters.</p>
      )}
    </div>
  );
}

type HedgeRow = { j: number; beta: number; varCut: number; beta1: number; unstable: boolean };

function HedgeRows({ rows, assets, onPickPair }: { rows: HedgeRow[]; assets: Asset[]; onPickPair: (j: number) => void }) {
  return (
    <ol className="mt-1 space-y-1 text-sm">
      {rows.map((r) => (
        <li key={r.j} className="flex items-baseline justify-between gap-2 tabular-nums">
          <button type="button" onClick={() => onPickPair(r.j)} title={assets[r.j].name}
            className="text-left text-ink hover:underline focus-visible:outline-2 focus-visible:outline-accent">
            {r.beta >= 0 ? "Short" : "Buy"} {fmt(Math.abs(r.beta))}× <span className="font-medium">{assets[r.j].t}</span>
          </button>
          <span className="flex items-baseline gap-2 text-ink-2">
            variance −{Math.round(r.varCut * 100)}%
            {r.unstable && (
              <span className="rounded-full border border-line px-1.5 text-[10px] text-ink-2"
                title={`Last-year ratio ${fmt(r.beta1)} vs ${fmt(r.beta)} over 2 years: sign flipped or moved more than 50%`}>
                unstable
              </span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

function HedgeCol({ title, hint, ids, row, assets, onPickPair }: {
  title: string; hint: string; ids: number[]; row: Float64Array; assets: Asset[]; onPickPair: (j: number) => void;
}) {
  return (
    <div>
      <h4 className="text-xs font-medium text-ink-2" title={hint}>{title}</h4>
      <ol className="mt-1 space-y-0.5">
        {ids.map((j) => (
          <li key={j} className="flex justify-between gap-2 tabular-nums">
            <button type="button" onClick={() => onPickPair(j)} title={assets[j].name}
              className="truncate text-left text-ink underline decoration-line underline-offset-2 hover:decoration-ink-2">
              {assets[j].t}
              {assets[j].cls !== "stock" && <span className="ml-1 text-[10px] text-ink-3">◆</span>}
            </button>
            <span className="text-ink-2">{fmt(row[j], 2, true)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
