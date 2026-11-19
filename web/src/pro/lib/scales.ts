// Colour bins for Market Map Pro (copied from v1's scales.ts and changed).
import type { Asset, AssetClass, Filters } from "./types";

export type Bin = { label: string; color: string };

// 3 buckets of "neighbours shared between the maps (of 10)". Most divergent = strongest orange;
// consistent stocks fade to the neutral point colour. Values in pro.css, validated per theme.
export const DIVERGENCE_BINS: Bin[] = [
  { label: "0–1 shared", color: "var(--pro-div-0)" },
  { label: "2–3", color: "var(--pro-div-1)" },
  { label: "4+", color: "var(--pro-div-2)" },
];
export const divergenceBin = (overlap: number | null) => {
  if (overlap === null) return -1;
  const k = Math.round(overlap * 10);
  return k <= 1 ? 0 : k <= 3 ? 1 : 2;
};

export const BETA_BINS: Bin[] = [
  { label: "1.5+", color: "var(--seq-0)" },
  { label: "1.2–1.5", color: "var(--seq-1)" },
  { label: "0.9–1.2", color: "var(--seq-2)" },
  { label: "0.6–0.9", color: "var(--seq-3)" },
  { label: "<0.6", color: "var(--seq-4)" },
];
export const betaBin = (b: number) => (b >= 1.5 ? 0 : b >= 1.2 ? 1 : b >= 0.9 ? 2 : b >= 0.6 ? 3 : 4);

export const CLASS_LABEL: Record<AssetClass, string> = {
  stock: "Stocks",
  etf: "Equity ETFs",
  fx: "FX",
  commodity: "Commodities",
  bond: "Bonds",
  crypto: "Crypto",
};

export const DEFAULT_FILTERS: Filters = {
  mcapMin: 0,
  volMin: 0,
  volMax: Infinity,
  advMin: 0,
  classes: { stock: true, etf: true, fx: true, commodity: true, bond: true, crypto: true },
};

/** Market cap applies to stocks only; missing values never exclude an asset. */
export function passes(a: Asset, f: Filters): boolean {
  if (!f.classes[a.cls]) return false;
  if (a.cls === "stock" && f.mcapMin > 0 && a.mcap !== null && a.mcap < f.mcapMin) return false;
  if (a.vol !== null && (a.vol < f.volMin || a.vol > f.volMax)) return false;
  if (f.advMin > 0 && a.adv !== null && a.adv < f.advMin) return false;
  return true;
}

export const activeFilterCount = (f: Filters) =>
  (f.mcapMin > 0 ? 1 : 0) +
  (f.volMin > 0 || Number.isFinite(f.volMax) ? 1 : 0) +
  (f.advMin > 0 ? 1 : 0) +
  (Object.values(f.classes).some((v) => !v) ? 1 : 0);

export const fmt = (v: number, d = 2, signed = false) =>
  Number.isFinite(v) ? (signed && v > 0 ? "+" : "") + v.toFixed(d).replace("-", "−") : "–";

export const money = (bn: number | null) =>
  bn === null ? "–" : bn >= 1000 ? `$${(bn / 1000).toFixed(2)}T` : bn >= 10 ? `$${bn.toFixed(0)}B` : `$${bn.toFixed(1)}B`;

export const moneyM = (m: number | null) =>
  m === null ? "–" : m >= 1000 ? `$${(m / 1000).toFixed(1)}B` : `$${m.toFixed(0)}M`;

/** "more similar than 99.6% of pairs" -> 99.6; shown as a percentile. */
export const pctLabel = (p: number) => (Number.isFinite(p) ? `${p >= 99.95 ? "99.9" : p.toFixed(p >= 99 ? 1 : 0)}th pct` : "–");

export const capPairs = <T extends { a: string; b: string }>(pairs: T[], maxPerTicker = 2): T[] => {
  const seen = new Map<string, number>();
  return pairs.filter((p) => {
    const a = seen.get(p.a) ?? 0;
    const b = seen.get(p.b) ?? 0;
    if (a >= maxPerTicker || b >= maxPerTicker) return false;
    seen.set(p.a, a + 1);
    seen.set(p.b, b + 1);
    return true;
  });
};
