// Lazy loaders for the compact binaries in /public/pro-data (written by pipeline_v2.py).
// Each file is fetched once per page and shared.
import type { PresetId } from "./types";
import { triIndex } from "./math";

const BASE = "/pro-data/";
const cache = new Map<string, Promise<ArrayBuffer>>();

function load(name: string): Promise<ArrayBuffer> {
  let p = cache.get(name);
  if (!p) {
    p = fetch(BASE + name).then((r) => {
      if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
      return r.arrayBuffer();
    });
    p.catch(() => cache.delete(name));
    cache.set(name, p);
  }
  return p;
}

const pairs = (n: number) => (n * (n - 1)) / 2;
const corr16 = (v: number) => (v === -32768 ? NaN : v / 10000);

/** Residual correlations for a factor preset: map window, long-run, and yearly stability. */
export type PairMatrix = {
  n: number;
  corr: (i: number, j: number) => number;
  longRun: (i: number, j: number) => number;
  held: (i: number, j: number) => number;
  windows: (i: number, j: number) => number;
  row: (i: number) => Float64Array;
};

export async function loadMatrix(preset: PresetId, n: number): Promise<PairMatrix> {
  const buf = await load(`matrix_${preset}.bin`);
  const M = pairs(n);
  const c = new Int16Array(buf, 0, M);
  const l = new Int16Array(buf, 2 * M, M);
  const k = new Uint8Array(buf, 4 * M, M);
  const w = new Uint8Array(buf, 5 * M, M);
  const at = (arr: ArrayLike<number>, i: number, j: number, diag: number) => (i === j ? diag : arr[triIndex(i, j, n)]);
  return {
    n,
    corr: (i, j) => (i === j ? 1 : corr16(c[triIndex(i, j, n)])),
    longRun: (i, j) => (i === j ? 1 : corr16(l[triIndex(i, j, n)])),
    held: (i, j) => at(k, i, j, 0),
    windows: (i, j) => at(w, i, j, 0),
    row: (i) => {
      const out = new Float64Array(n);
      for (let j = 0; j < n; j++) out[j] = i === j ? 1 : corr16(c[triIndex(i, j, n)]);
      return out;
    },
  };
}

/** Total-return correlation (no factors removed) over the map window. */
export async function loadRawCorr(n: number): Promise<(i: number, j: number) => number> {
  const c = new Int16Array(await load("matrix_raw.bin"), 0, pairs(n));
  return (i, j) => (i === j ? 1 : corr16(c[triIndex(i, j, n)]));
}

/** Text-similarity percentile among all stock pairs (NaN for non-stocks). */
export async function loadSimPct(n: number): Promise<(i: number, j: number) => number> {
  const s = new Uint16Array(await load("sim_pct.bin"), 0, pairs(n));
  return (i, j) => {
    if (i === j) return NaN;
    const v = s[triIndex(i, j, n)];
    return v === 65535 ? NaN : v / 100;
  };
}

/** Daily series, asset-major Float32 (n x days). */
export async function loadSeries(kind: "close" | PresetId, n: number, days: number) {
  const name = kind === "close" ? "series_close.f32" : `series_resid_${kind}.f32`;
  const all = new Float32Array(await load(name), 0, n * days);
  return (i: number) => all.subarray(i * days, (i + 1) * days);
}
