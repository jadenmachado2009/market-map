import type { Pair, Stock } from "./types";

// Five-step single-hue ramp (CSS vars --seq-0 … --seq-4, defined per theme in globals.css).
// Step 0 is the strongest: darkest on light surfaces, lightest on dark ones.
export type Bin = { label: string; test: (s: Stock) => boolean };

const shared = (s: Stock) => Math.round(s.overlap * 10);

export const DIVERGENCE_BINS: Bin[] = [
  { label: "0", test: (s) => shared(s) === 0 },
  { label: "1", test: (s) => shared(s) === 1 },
  { label: "2–3", test: (s) => shared(s) >= 2 && shared(s) <= 3 },
  { label: "4–5", test: (s) => shared(s) >= 4 && shared(s) <= 5 },
  { label: "6+", test: (s) => shared(s) >= 6 },
];

export const BETA_BINS: Bin[] = [
  { label: "1.5+", test: (s) => s.beta >= 1.5 },
  { label: "1.2–1.5", test: (s) => s.beta >= 1.2 && s.beta < 1.5 },
  { label: "0.9–1.2", test: (s) => s.beta >= 0.9 && s.beta < 1.2 },
  { label: "0.6–0.9", test: (s) => s.beta >= 0.6 && s.beta < 0.9 },
  { label: "<0.6", test: (s) => s.beta < 0.6 },
];

export const binIndex = (bins: Bin[], s: Stock) => {
  const i = bins.findIndex((b) => b.test(s));
  return i === -1 ? bins.length - 1 : i;
};

export const seq = (i: number) => `var(--seq-${i})`;

// Keep each list readable: one theme (e.g. CEG/VST vs every utility) can otherwise fill all 25 rows.
export function capPairs(pairs: Pair[], maxPerTicker = 2): Pair[] {
  const seen = new Map<string, number>();
  return pairs.filter((p) => {
    const a = seen.get(p.a) ?? 0;
    const b = seen.get(p.b) ?? 0;
    if (a >= maxPerTicker || b >= maxPerTicker) return false;
    seen.set(p.a, a + 1);
    seen.set(p.b, b + 1);
    return true;
  });
}

export const fmt = (v: number, signed = false) =>
  (signed && v > 0 ? "+" : "") + v.toFixed(2).replace("-", "−");
