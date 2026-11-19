// Run from web/:  node --test tests-pro
import { test } from "node:test";
import assert from "node:assert/strict";
import { neff, triIndex, parsePortfolio, rollingCorr, pearson, rebase } from "../src/pro/lib/math.ts";

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("N_eff: identity matrix gives n", () => {
  for (const n of [1, 4, 15]) close(neff(n, (i, j) => (i === j ? 1 : 0)), n);
});

test("N_eff: all-ones matrix gives 1", () => {
  close(neff(12, () => 1), 1);
});

test("N_eff: weights matter and scale doesn't", () => {
  const ident = (i, j) => (i === j ? 1 : 0);
  close(neff(2, ident, [3, 1]), 1 / (0.75 ** 2 + 0.25 ** 2)); // 1.6
  close(neff(3, ident, [2, 2, 2]), neff(3, ident, [1, 1, 1]));
});

test("N_eff: two blocks of clones give 2", () => {
  const block = (i, j) => (Math.floor(i / 3) === Math.floor(j / 3) ? 1 : 0);
  close(neff(6, block), 2);
});

test("N_eff: matches the eigenvalue definition for a 2x2 case", () => {
  // eigenvalues of [[1, r], [r, 1]] / 2 are (1 ± r) / 2
  const r = 0.6;
  const l1 = (1 + r) / 2, l2 = (1 - r) / 2;
  close(neff(2, (i, j) => (i === j ? 1 : r)), (l1 + l2) ** 2 / (l1 ** 2 + l2 ** 2));
});

test("triIndex matches row-major upper-triangle order", () => {
  const n = 6;
  let pos = 0;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      assert.equal(triIndex(i, j, n), pos);
      assert.equal(triIndex(j, i, n), pos);
      pos++;
    }
});

test("parsePortfolio: weights, defaults, unknowns", () => {
  const known = new Set(["NVDA", "MSFT", "JPM", "BRK-B"]);
  const p = parsePortfolio("NVDA 20, MSFT 15; JPM 10%\nFOO 5", known);
  assert.deepEqual(p.holdings.map((h) => h.t), ["NVDA", "MSFT", "JPM"]);
  close(p.holdings[0].w, 20 / 45);
  assert.deepEqual(p.unknown, ["FOO"]);
  const eq = parsePortfolio("nvda, msft, brk.b", known);
  assert.equal(eq.weighted, false);
  for (const h of eq.holdings) close(h.w, 1 / 3);
  assert.equal(eq.holdings[2].t, "BRK-B");
});

test("rolling correlation and rebase", () => {
  const a = [1, 2, 3, 4, 5, 6], b = [2, 4, 6, 8, 10, 12];
  const r = rollingCorr(a, b, 3);
  assert.ok(Number.isNaN(r[1]));
  close(r[2], 1);
  close(pearson([1, 2, 3], [3, 2, 1]), -1);
  rebase([50, 55, 45]).forEach((v, i) => close(v, [100, 110, 90][i]));
});
