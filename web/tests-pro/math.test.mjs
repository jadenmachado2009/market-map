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

// ---------------------------------------------------------------- v2.1
import { neffCov, riskContrib, portfolioVar, hedge, hedgeUnstable, formatNum } from "../src/pro/lib/math.ts";

test("N_eff (covariance): n uncorrelated assets, equal vol, equal weights -> n", () => {
  for (const n of [2, 9, 15]) {
    const v = 0.02 ** 2;
    close(neffCov(n, (i, j) => (i === j ? v : 0), new Array(n).fill(1 / n)), n);
  }
});

test("N_eff (covariance): all pairs perfectly correlated -> 1", () => {
  const sd = [0.01, 0.02, 0.03, 0.015, 0.025];
  close(neffCov(5, (i, j) => sd[i] * sd[j], [0.3, 0.2, 0.2, 0.15, 0.15]), 1);
});

test("N_eff (covariance): volatility matters (a dominant holding cuts the count)", () => {
  // two uncorrelated holdings, equal weight, one twice as volatile -> 1 < N_eff < 2
  const sd = [0.01, 0.02];
  const n2 = neffCov(2, (i, j) => (i === j ? sd[i] ** 2 : 0), [0.5, 0.5]);
  close(n2, (1 + 4) ** 2 / (1 + 16)); // tr² / ||M||²: (1 + 4)² / (1² + 4²)
  assert.ok(n2 < 2 && n2 > 1);
});

test("risk contributions sum to 1 and match the closed form", () => {
  const C = [[4, 1, 0.5], [1, 9, 2], [0.5, 2, 16]].map((r) => r.map((x) => x / 1e4));
  const w = [0.5, 0.3, 0.2];
  const rc = riskContrib(3, (i, j) => C[i][j], w);
  close(rc.reduce((a, b) => a + b, 0), 1);
  const tot = portfolioVar(3, (i, j) => C[i][j], w);
  close(rc[0], (w[0] * (C[0][0] * w[0] + C[0][1] * w[1] + C[0][2] * w[2])) / tot);
  riskContrib(4, (i, j) => (i === j ? 1 : 0), [0.25, 0.25, 0.25, 0.25]).forEach((x) => close(x, 0.25));
});

test("hedge ratio = Cov/Var(h), variance cut = rho^2, and the stability flag", () => {
  const h = hedge(0.74, 0.024, 0.02); // rho 0.74, sd_s 2.4%, sd_h 2.0%
  close(h.beta, 0.74 * 1.2);
  close(h.varCut, 0.5476);
  assert.equal(hedgeUnstable(1.0, 1.4), false);
  assert.equal(hedgeUnstable(1.0, 1.6), true);   // moved more than 50%
  assert.equal(hedgeUnstable(0.3, -0.1), true);  // sign flip
  assert.equal(hedgeUnstable(1.0, NaN), true);
});

test("sign formatting: round first, no '−0.00', '+' only for positives when asked", () => {
  assert.equal(formatNum(-0.0004), "0.00");
  assert.equal(formatNum(-0.004, 2, true), "0.00");
  assert.equal(formatNum(0.004, 2, true), "0.00");
  assert.equal(formatNum(-0.006), "−0.01");
  assert.equal(formatNum(0.25, 2, true), "+0.25");
  assert.equal(formatNum(-1.234, 1), "−1.2");
  assert.equal(formatNum(NaN), "–");
});

import { splitHedges } from "../src/pro/lib/math.ts";

test("hedge split: a stock never lands in the ETF list; each list ranked by variance cut, top 3", () => {
  const classes = ["stock", "etf", "bond", "fx", "commodity", "crypto"];
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let trial = 0; trial < 200; trial++) {
    const rows = Array.from({ length: 1 + Math.floor(rand() * 40) }, (_, j) => ({ j, cls: classes[Math.floor(rand() * 6)], varCut: rand() }));
    const { etf, peer } = splitHedges(rows, (r) => r.cls);
    assert.ok(etf.every((r) => r.cls === "etf" || r.cls === "bond"));
    assert.ok(etf.every((r) => r.cls !== "stock"));
    assert.ok(peer.every((r) => r.cls === "stock"));
    assert.ok(etf.length <= 3 && peer.length <= 3);
    for (const list of [etf, peer]) for (let k = 1; k < list.length; k++) assert.ok(list[k - 1].varCut >= list[k].varCut);
    const bestEtf = rows.filter((r) => r.cls === "etf" || r.cls === "bond").sort((x, y) => y.varCut - x.varCut)[0];
    if (bestEtf) assert.equal(etf[0], bestEtf);
  }
  // a stock with a bigger variance cut than any ETF still goes to the peer list, and no ETF means an empty list
  const only = splitHedges([{ cls: "stock", varCut: 0.9 }, { cls: "commodity", varCut: 0.8 }], (r) => r.cls);
  assert.deepEqual(only.etf, []);
  assert.equal(only.peer.length, 1);
});
