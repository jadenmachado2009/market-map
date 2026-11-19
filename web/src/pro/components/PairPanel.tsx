"use client";

import { useEffect, useState } from "react";
import type { Asset, PresetId } from "../lib/types";
import { loadSeries, loadSimPct, type PairMatrix } from "../lib/lazy";
import { rebase, rollingCorr } from "../lib/math";
import { fmt, pctLabel } from "../lib/scales";

type Loaded = { pa: number[]; pb: number[]; roll: number[]; sim: number };

export function PairPanel({ a, b, assets, preset, presetLabel, dates, matrix, onPick, onClose }: {
  a: number; b: number; assets: Asset[]; preset: PresetId; presetLabel: string; dates: string[];
  matrix: PairMatrix | null; onPick: (t: string) => void; onClose: () => void;
}) {
  const [data, setData] = useState<{ key: string; v: Loaded } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = `${a}-${b}-${preset}`;
  const n = assets.length;
  const days = dates.length;

  useEffect(() => {
    let live = true;
    Promise.all([loadSeries("close", n, days), loadSeries(preset, n, days), loadSimPct(n)])
      .then(([close, resid, sim]) => {
        if (!live) return;
        setData({
          key,
          v: { pa: rebase(close(a)), pb: rebase(close(b)), roll: rollingCorr(resid(a), resid(b), 60), sim: sim(a, b) },
        });
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [a, b, preset, n, days, key]);

  const A = assets[a], B = assets[b];
  const v = data?.key === key ? data.v : null;
  const corr = matrix?.corr(a, b) ?? NaN;
  const longRun = matrix?.longRun(a, b) ?? NaN;
  const held = matrix ? `${matrix.held(a, b)} of ${matrix.windows(a, b)}` : "…";

  return (
    <section className="rounded-lg border border-line bg-surface-2/60 p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-ink">
            <button type="button" onClick={() => onPick(A.t)} className="hover:underline">{A.t}</button>
            <span className="mx-1.5 text-ink-3">↔</span>
            <button type="button" onClick={() => onPick(B.t)} className="hover:underline">{B.t}</button>
          </h2>
          <p className="text-xs text-ink-3">{A.name} · {B.name}</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close pair view" className="rounded px-1.5 text-ink-3 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent">✕</button>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
        <Stat label={`Residual corr, 2y (${presetLabel})`} value={fmt(corr)} />
        <Stat label="Long-run level (since 2016)" value={fmt(longRun)} />
        <Stat label="Held ≥0.3, calendar years" value={held} />
        <Stat
          label="Business-text similarity"
          value={!v ? "…" : Number.isFinite(v.sim) ? pctLabel(v.sim) : "n/a"}
          hint={v && Number.isFinite(v.sim) ? `More similar than ${v.sim.toFixed(1)}% of stock pairs` : "Only stocks have business text"}
        />
        <Stat label={`β ${A.t} to S&P 500`} value={fmt(A.beta)} />
        <Stat label={`β ${B.t} to S&P 500`} value={fmt(B.beta)} />
      </dl>

      {error && <p className="mt-3 text-xs text-ink-3">Couldn&apos;t load the series ({error}).</p>}
      {!v && !error && <p className="mt-3 text-xs text-ink-3">Loading prices…</p>}
      {v && (
        <>
          <h3 className="mt-4 text-xs font-medium text-ink-2">Price, rebased to 100</h3>
          <LineChart
            dates={dates}
            series={[
              { label: A.t, values: v.pa, color: "var(--pro-line-a)" },
              { label: B.t, values: v.pb, color: "var(--pro-line-b)" },
            ]}
            fmtY={(x) => x.toFixed(0)}
          />
          <h3 className="mt-3 text-xs font-medium text-ink-2">Rolling 60-day residual correlation</h3>
          <LineChart
            dates={dates}
            series={[{ label: "60-day", values: v.roll, color: "var(--pro-line-a)" }]}
            refs={Number.isFinite(longRun) ? [{ y: longRun, label: "long-run" }] : []}
            fmtY={(x) => x.toFixed(2)}
            domain={[-1, 1]}
          />
        </>
      )}
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div title={hint}>
      <dt className="text-[11px] leading-tight text-ink-3">{label}</dt>
      <dd className="tabular-nums text-ink">{value}</dd>
    </div>
  );
}

type Series = { label: string; values: number[]; color: string };

function LineChart({ dates, series, refs = [], fmtY, domain }: {
  dates: string[]; series: Series[]; refs?: { y: number; label: string }[]; fmtY: (v: number) => string; domain?: [number, number];
}) {
  const [hi, setHi] = useState<number | null>(null);
  const W = 320, H = 110, L = 30, R = 6, T = 6, B = 16;
  const n = dates.length;
  const finite = series.flatMap((s) => s.values.filter(Number.isFinite));
  let [lo, top] = domain ?? [Math.min(...finite, ...refs.map((r) => r.y)), Math.max(...finite, ...refs.map((r) => r.y))];
  if (!domain) {
    const pad = (top - lo) * 0.06 || 1;
    lo -= pad;
    top += pad;
  }
  const x = (i: number) => L + (i / (n - 1)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - lo) / (top - lo)) * (H - T - B);
  const path = (vals: number[]) => {
    let d = "", pen = false;
    vals.forEach((v, i) => {
      if (!Number.isFinite(v)) return void (pen = false);
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const ticks = domain ? [domain[0], 0, domain[1]] : [lo + (top - lo) * 0.1, (lo + top) / 2, top - (top - lo) * 0.1];
  const at = hi ?? n - 1;

  return (
    <div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 text-[11px] tabular-nums text-ink-2">
        <span className="text-ink-3">{dates[at]}</span>
        {series.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1">
            <span className="inline-block h-0.5 w-3 rounded" style={{ background: s.color }} />
            {s.label} <span className="text-ink">{Number.isFinite(s.values[at]) ? fmtY(s.values[at]) : "–"}</span>
          </span>
        ))}
        {refs.map((r) => (
          <span key={r.label} className="inline-flex items-center gap-1 text-ink-3">
            <span className="inline-block w-3 border-t border-dashed border-ink-3" /> {r.label} {fmtY(r.y)}
          </span>
        ))}
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="mt-1 block w-full"
        role="img"
        aria-label={series.map((s) => s.label).join(" and ")}
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          setHi(Math.max(0, Math.min(n - 1, Math.round(((px - L) / (W - L - R)) * (n - 1)))));
        }}
        onPointerLeave={() => setHi(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            <text x={L - 4} y={y(t) + 3} fontSize={9} textAnchor="end" style={{ fill: "var(--ink-3)" }}>{fmtY(t)}</text>
          </g>
        ))}
        {refs.map((r) => (
          <line key={r.label} x1={L} x2={W - R} y1={y(r.y)} y2={y(r.y)} stroke="var(--ink-3)" strokeWidth={1.25} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
        ))}
        {series.map((s) => (
          <path key={s.label} d={path(s.values)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        ))}
        <text x={L} y={H - 3} fontSize={9} style={{ fill: "var(--ink-3)" }}>{dates[0].slice(0, 7)}</text>
        <text x={W - R} y={H - 3} fontSize={9} textAnchor="end" style={{ fill: "var(--ink-3)" }}>{dates[n - 1].slice(0, 7)}</text>
        {hi !== null && (
          <g>
            <line x1={x(hi)} x2={x(hi)} y1={T} y2={H - B} stroke="var(--ink-3)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            {series.map((s) =>
              Number.isFinite(s.values[hi]) ? (
                <circle key={s.label} cx={x(hi)} cy={y(s.values[hi])} r={3} fill={s.color} stroke="var(--surface)" strokeWidth={1.5} />
              ) : null,
            )}
          </g>
        )}
      </svg>
    </div>
  );
}
