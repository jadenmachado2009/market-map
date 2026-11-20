// Pure maths for Market Map Pro. No imports, so `node --test web/tests-pro` can load it directly.

/** Position of pair (i, j), i != j, in the row-major strict upper triangle of an n x n matrix. */
export function triIndex(i: number, j: number, n: number): number {
  if (i > j) [i, j] = [j, i];
  return i * n - (i * (i + 1)) / 2 + (j - i - 1);
}

/**
 * Effective number of independent bets: (sum λ)² / sum λ² for the eigenvalues λ of W^½ C W^½.
 * Equals tr(M)² / ||M||²_F, i.e. (Σw)² / Σᵢⱼ wᵢ wⱼ Cᵢⱼ², so no eigen-decomposition is needed.
 * `corr(i, j)` must return 1 on the diagonal.
 */
export function neff(n: number, corr: (i: number, j: number) => number, weights?: number[]): number {
  if (n === 0) return 0;
  const w = weights ?? new Array(n).fill(1);
  let total = 0;
  for (const x of w) total += x;
  let den = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const c = i === j ? 1 : corr(i, j);
      den += (w[i] / total) * (w[j] / total) * c * c;
    }
  }
  return 1 / den;
}

export type Holding = { t: string; w: number };
export type ParsedPortfolio = { holdings: Holding[]; unknown: string[]; weighted: boolean };

/**
 * Parse "NVDA 20, MSFT 15, JPM 10" (commas, semicolons or new lines; weights optional, % allowed).
 * No weights -> equal weight. Some weights -> missing ones get the average of the given ones.
 * Weights are normalised to sum to 1. Duplicate tickers are merged.
 */
export function parsePortfolio(text: string, known: Set<string>): ParsedPortfolio {
  const entries: { t: string; w: number | null }[] = [];
  const unknown: string[] = [];
  for (const raw of text.split(/[,;\n]+/)) {
    const m = raw.trim().match(/^([A-Za-z][A-Za-z0-9.\-]*)\s*[:=]?\s*([0-9]*\.?[0-9]+)?\s*%?$/);
    if (!m) {
      if (raw.trim()) unknown.push(raw.trim());
      continue;
    }
    const t = m[1].toUpperCase().replace(".", "-");
    if (!known.has(t)) {
      unknown.push(t);
      continue;
    }
    const w = m[2] !== undefined ? Number(m[2]) : null;
    const prev = entries.find((e) => e.t === t);
    if (prev) prev.w = prev.w === null || w === null ? (prev.w ?? w) : prev.w + w;
    else entries.push({ t, w });
  }
  const given = entries.filter((e) => e.w !== null && e.w > 0).map((e) => e.w as number);
  const fill = given.length ? given.reduce((a, b) => a + b, 0) / given.length : 1;
  const ws = entries.map((e) => (e.w !== null && e.w > 0 ? e.w : fill));
  const sum = ws.reduce((a, b) => a + b, 0) || 1;
  return {
    holdings: entries.map((e, i) => ({ t: e.t, w: ws[i] / sum })),
    unknown,
    weighted: given.length > 0,
  };
}

/** Pearson correlation of two equal-length arrays over [from, to). NaN if undefined. */
export function pearson(a: ArrayLike<number>, b: ArrayLike<number>, from = 0, to = a.length): number {
  let n = 0, sa = 0, sb = 0;
  for (let i = from; i < to; i++) {
    if (Number.isFinite(a[i]) && Number.isFinite(b[i])) {
      n++;
      sa += a[i];
      sb += b[i];
    }
  }
  if (n < 3) return NaN;
  const ma = sa / n, mb = sb / n;
  let cov = 0, va = 0, vb = 0;
  for (let i = from; i < to; i++) {
    if (Number.isFinite(a[i]) && Number.isFinite(b[i])) {
      const da = a[i] - ma, db = b[i] - mb;
      cov += da * db;
      va += da * da;
      vb += db * db;
    }
  }
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : NaN;
}

/** Trailing rolling correlation; the first (win - 1) values are NaN. */
export function rollingCorr(a: ArrayLike<number>, b: ArrayLike<number>, win: number): number[] {
  const out = new Array(a.length).fill(NaN);
  for (let end = win; end <= a.length; end++) out[end - 1] = pearson(a, b, end - win, end);
  return out;
}

/** Rebase a price series to 100 at its first finite value. */
export function rebase(prices: ArrayLike<number>): number[] {
  let base = NaN;
  for (let i = 0; i < prices.length && !Number.isFinite(base); i++) if (Number.isFinite(prices[i])) base = prices[i];
  return Array.from(prices, (p) => (p / base) * 100);
}

// ---------------------------------------------------------------- v2.1: covariance, risk, hedges

/**
 * N_eff on covariance: eigenvalues λ of M = diag(w) Σ diag(w); (Σλ)² / Σλ² = tr(M)² / ||M||²_F.
 * `cov(i, j)` is the covariance of holdings i and j (daily returns).
 */
export function neffCov(n: number, cov: (i: number, j: number) => number, w: number[]): number {
  let tr = 0, fro = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const m = w[i] * w[j] * cov(i, j);
      fro += m * m;
      if (i === j) tr += m;
    }
  }
  return fro > 0 ? (tr * tr) / fro : NaN;
}

/** Portfolio variance wᵀΣw. */
export function portfolioVar(n: number, cov: (i: number, j: number) => number, w: number[]): number {
  let v = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) v += w[i] * w[j] * cov(i, j);
  return v;
}

/** Risk contribution RC_i = w_i (Σw)_i / wᵀΣw. Sums to 1. */
export function riskContrib(n: number, cov: (i: number, j: number) => number, w: number[]): number[] {
  const sw = Array.from({ length: n }, (_, i) => {
    let s = 0;
    for (let j = 0; j < n; j++) s += cov(i, j) * w[j];
    return s;
  });
  const total = w.reduce((acc, wi, i) => acc + wi * sw[i], 0);
  return w.map((wi, i) => (wi * sw[i]) / total);
}

/**
 * Minimum-variance hedge of s with h: β = Cov(s, h) / Var(h) = ρ σ_s / σ_h.
 * Hedging with β removes ρ² of s's variance.
 */
export function hedge(rho: number, sdS: number, sdH: number): { beta: number; varCut: number } {
  return { beta: (rho * sdS) / sdH, varCut: rho * rho };
}

/** A hedge is unstable if the 1-year ratio flips sign or moves more than 50% from the 2-year one. */
export function hedgeUnstable(beta2y: number, beta1y: number): boolean {
  if (!Number.isFinite(beta1y)) return true;
  return Math.sign(beta1y) !== Math.sign(beta2y) || Math.abs(beta1y - beta2y) > 0.5 * Math.abs(beta2y);
}

/**
 * Fixed-decimal number with a proper minus sign. Rounds first, so tiny values never show as
 * "−0.00": exact zero is "0.00" with no sign. `signed` adds "+" to positive values.
 */
export function formatNum(v: number, digits = 2, signed = false): string {
  if (!Number.isFinite(v)) return "–";
  const f = 10 ** digits;
  const r = Math.round(v * f) / f;
  if (r === 0) return (0).toFixed(digits);
  const s = Math.abs(r).toFixed(digits);
  return r < 0 ? "−" + s : (signed ? "+" : "") + s;
}
