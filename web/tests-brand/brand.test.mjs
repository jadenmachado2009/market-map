// Brand assets (spec brand-1). Run from web/:  node --test tests-brand/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p, enc) => readFileSync(new URL(`../${p}`, import.meta.url), enc);
const SVGS = ["mm-lockup.svg", "mm-lockup-pro.svg", "mm-horizontal.svg", "mm-horizontal-pro.svg", "favicon.svg"];

test("logos are outlined paths: no text, no fonts, only the brand colours", () => {
  for (const f of SVGS) {
    const s = read(`public/brand/${f}`, "utf8");
    assert.doesNotMatch(s, /<text|font-family|@font-face|<image/, f);
    const colours = new Set(s.match(/#[0-9a-f]{6}/gi).map((c) => c.toLowerCase()));
    const allowed = f === "favicon.svg" ? ["#f0efec", "#0e0e0e"] : ["#f0efec"];
    assert.deepEqual([...colours].sort(), allowed.sort(), f);
  }
  assert.match(read("public/brand/mm-lockup.svg", "utf8"), /viewBox="0 0 100 80"/);
});

test("the inline header logo is generated paths in currentColor", () => {
  const ts = read("src/brand/logo-paths.ts", "utf8");
  assert.match(ts, /export const HORIZONTAL = /);
  assert.match(ts, /export const HORIZONTAL_PRO = /);
  const tsx = read("src/brand/Logo.tsx", "utf8");
  assert.match(tsx, /fill="currentColor"/);
  assert.match(tsx, /aria-label=\{label\}/);
});

const pngSize = (buf) => [buf.readUInt32BE(16), buf.readUInt32BE(20)];

test("link previews are 1200×630 and the touch icon is 180×180", () => {
  assert.deepEqual(pngSize(read("public/brand/og-classic.png")), [1200, 630]);
  assert.deepEqual(pngSize(read("public/brand/og-pro.png")), [1200, 630]);
  assert.deepEqual(pngSize(read("public/brand/apple-touch-icon.png")), [180, 180]);
});

test("favicon.ico holds 16, 32 and 48 px, and the app serves the same file", () => {
  const ico = read("public/brand/favicon.ico");
  const n = ico.readUInt16LE(4);
  const sizes = Array.from({ length: n }, (_, i) => ico[6 + 16 * i] || 256);
  assert.deepEqual(sizes, [16, 32, 48]);
  assert.ok(read("src/app/favicon.ico").equals(ico));
});

test("titles, previews and theme colour are wired into both routes", () => {
  const home = read("src/app/page.tsx", "utf8");
  const pro = read("src/app/pro/page.tsx", "utf8");
  const layout = read("src/app/layout.tsx", "utf8");
  assert.ok(home.includes('"Market Map: which stocks are secretly connected"'));
  assert.ok(pro.includes('"Market Map Pro: what your portfolio is really betting on"'));
  assert.ok(home.includes("/brand/og-classic.png") && pro.includes("/brand/og-pro.png"));
  for (const p of [home, pro]) assert.match(p, /card: "summary_large_image"/);
  assert.match(layout, /themeColor: "#0e0e0e"/);
  assert.match(layout, /metadataBase: new URL\("https:\/\/stock-market-map\.vercel\.app"\)/);
  assert.ok(home.includes("<Logo ") && pro.includes("<Logo pro "));
  assert.ok(pro.includes("← Classic map") && home.includes("Try Pro →"));
});
