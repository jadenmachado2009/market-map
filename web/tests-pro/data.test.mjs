// Checks on the exported data itself (runs after the nightly pipeline). Run from web/:  node --test tests-pro/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const data = JSON.parse(readFileSync(new URL("../src/data-pro/market_map_v2.json", import.meta.url), "utf8"));
const N = data.assets.length;
const pairKey = (p) => [p.a, p.b].sort().join("|");

test("noise assignment: every plotted point is in a cluster, on every preset and both maps", () => {
  for (const [p, P] of Object.entries(data.data)) {
    for (const view of ["beh", "biz"]) {
      const { ids, labels, assigned } = P.clusters[view];
      assert.equal(ids.length, N);
      assert.equal(assigned.length, N);
      const known = new Set(labels.map((l) => l.id));
      P[view].forEach((pt, i) => {
        if (pt === null) {
          assert.equal(assigned[i], false, `${p}/${view}: ${data.assets[i].t} is not plotted but flagged assigned`);
          return;
        }
        assert.notEqual(ids[i], -1, `${p}/${view}: ${data.assets[i].t} is unclustered`);
        assert.ok(known.has(ids[i]), `${p}/${view}: ${data.assets[i].t} has cluster ${ids[i]} with no label`);
      });
      assert.ok(!labels.some((l) => /not in a cluster/i.test(l.label)));
    }
  }
});

test("decoupling watchlist: never repeats a significant pair; most negative z first; only falling pairs", () => {
  for (const [p, P] of Object.entries(data.data)) {
    const sig = new Set(P.decouple.map(pairKey));
    assert.ok(P.watch.every((w) => !sig.has(pairKey(w))), `${p}: watchlist repeats a significant pair`);
    for (let k = 1; k < P.watch.length; k++) assert.ok(P.watch[k - 1].z <= P.watch[k].z, `${p}: watchlist not sorted by z`);
    assert.ok(P.watch.every((w) => w.z < 0 && w.q >= 0.05), `${p}: watchlist has a rising or significant pair`);
    assert.ok(P.watch.length <= P.decoupleTested - P.decouple.length);
  }
});

test("hedge universe has index and factor ETFs, and factors are never plotted in their own preset", () => {
  const t = new Set(data.assets.filter((a) => a.cls === "etf").map((a) => a.t));
  for (const s of ["SPY", "QQQ", "IWM", "USMV", "IWD", "IWF", "XLF"]) assert.ok(t.has(s), `${s} missing`);
  for (const pr of data.presets) {
    for (const f of pr.notPlotted) {
      const i = data.assets.findIndex((a) => a.t === f);
      assert.equal(data.data[pr.id].beh[i], null, `${f} is plotted in ${pr.id}`);
    }
  }
});

test("mixed-source rule: no list pair mixes text sources; Reads like stays within a source and needs readsLikeMinPool peers", () => {
  const src = Object.fromEntries(data.assets.map((a) => [a.t, a.text]));
  for (const [p, P] of Object.entries(data.data)) {
    for (const list of ["hidden", "apart"]) {
      for (const r of P[list]) assert.equal(src[r.a], src[r.b], `${p}/${list}: ${r.a} (${src[r.a]}) vs ${r.b} (${src[r.b]})`);
    }
  }
  const minPool = data.readsLikeMinPool ?? 5;
  assert.ok(minPool >= 5);
  const count = {};
  data.assets.forEach((a) => { if (a.cls === "stock") count[a.text] = (count[a.text] ?? 0) + 1; });
  data.nnBiz.forEach((nb, i) => {
    const a = data.assets[i];
    if (a.cls !== "stock") return assert.equal(nb, null);
    const pool = count[a.text] - 1;
    if (nb.length === 0) return assert.ok(pool < minPool, `${a.t}: empty Reads like but ${pool} comparable stocks`);
    assert.ok(pool >= minPool && nb.length === 5, `${a.t}: ${nb.length} Reads like entries from a pool of ${pool}`);
    for (const [t] of nb) assert.equal(src[t], a.text, `${a.t} (${a.text}) reads like ${t} (${src[t]})`);
  });
});
