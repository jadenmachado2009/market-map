// Tests for the classic map's plain-language layer (v1.1). Run from web/:  node --test tests-v1
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  ALIASES, GLOSSARY, buildStories, companyCount, familyOf, overlapWord, ownList, pairTheme, searchStocks, shortName,
  stockSentence, strength, surpriseWord,
} from "../src/lib/plain.ts";

const DATA = JSON.parse(readFileSync(new URL("../src/data/market_map.json", import.meta.url), "utf8"));
const clone = () => structuredClone(DATA);
const lookup = (d) => new Map(d.stocks.map((s) => [s.t, s]));
const BY = lookup(DATA);
const fmt2 = (v) => v.toFixed(2); // what the page shows next to the word

// ----------------------------------------------------------------------------- strength words

test("strength words: Strong ≥ 0.6, Medium 0.4–0.6, Weak < 0.4", () => {
  const cases = [
    [0.9, "Strong"], [0.6, "Strong"], [0.6049, "Strong"], [0.5949, "Medium"], [0.5, "Medium"], [0.4, "Medium"],
    [0.3949, "Weak"], [0.2, "Weak"], [0, "Weak"], [-0.22, "Weak"],
  ];
  for (const [v, w] of cases) assert.equal(strength(v), w, `${v}`);
});

test("strength words never disagree with the 2-decimal number shown beside them", () => {
  // 0.598 is shown as 0.60, so it must read Strong; 0.396 shows as 0.40, so Medium.
  assert.equal(strength(0.598), "Strong");
  assert.equal(strength(0.396), "Medium");
  const all = [
    ...DATA.stocks.flatMap((s) => [...s.nnBeh, ...s.nnBiz].map(([, v]) => v)),
    ...DATA.hidden.map((p) => p.corr), ...DATA.apart.map((p) => p.corr),
  ];
  for (const v of all) {
    const shown = Number(fmt2(v));
    const expect = shown >= 0.6 ? "Strong" : shown >= 0.4 ? "Medium" : "Weak";
    assert.equal(strength(v), expect, `${v} shown as ${fmt2(v)}`);
  }
});

test("business overlap and surprise words", () => {
  assert.equal(overlapWord(-0.18), "Low");
  assert.equal(overlapWord(0.45), "Medium");
  assert.equal(overlapWord(0.64), "High");
  for (const p of DATA.hidden) assert.equal(overlapWord(p.sim), "Low", `${p.a}-${p.b}`); // spec: "Business overlap: Low"
  for (const p of DATA.hidden) assert.ok(["Strong", "Medium"].includes(strength(p.corr)), `${p.a}-${p.b} ${p.corr}`);
  assert.deepEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.9].map(surpriseWord), ["High", "High", "Medium", "Medium", "Low", "Low", "Low", "Low"]);
});

// ----------------------------------------------------------------------------- names and search

test("495 companies: the three two-class companies count once", () => {
  assert.equal(DATA.stocks.length, 498);
  assert.equal(companyCount(DATA.stocks), 495);
});

test("short names drop legal suffixes", () => {
  const want = { KO: "Coca-Cola", NKE: "Nike", GOOGL: "Alphabet", DIS: "Disney", LLY: "Eli Lilly", KKR: "KKR", DE: "Deere", MRK: "Merck", HD: "Home Depot", APO: "Apollo", PLTR: "Palantir", META: "Meta", TSLA: "Tesla", AAPL: "Apple" };
  for (const [t, n] of Object.entries(want)) assert.equal(shortName(BY.get(t)), n, t);
  for (const s of DATA.stocks) assert.doesNotMatch(shortName(s), /(,? Inc\.?$|\(The\)|\(Class|Corporation$| plc$)/, s.t);
});

test("name search: at least 20 common names resolve to the right ticker first", () => {
  const cases = {
    Google: "GOOGL", Facebook: "META", "Coca-Cola": "KO", Coke: "KO", Apple: "AAPL", Amazon: "AMZN", Microsoft: "MSFT",
    Netflix: "NFLX", Nike: "NKE", Tesla: "TSLA", Disney: "DIS", "McDonald's": "MCD", mcdonalds: "MCD", Starbucks: "SBUX",
    Walmart: "WMT", Costco: "COST", "Home Depot": "HD", "JP Morgan": "JPM", "Bank of America": "BAC", Exxon: "XOM",
    Berkshire: "BRK-B", "Eli Lilly": "LLY", Pepsi: "PEP", Visa: "V", Mastercard: "MA", Intel: "INTC", Boeing: "BA",
    Ford: "F", "General Motors": "GM", Uber: "UBER", Airbnb: "ABNB", Instagram: "META", YouTube: "GOOGL",
    "Johnson & Johnson": "JNJ", "AT&T": "T", "Goldman Sachs": "GS", Chipotle: "CMG", Nvidia: "NVDA", Pfizer: "PFE",
    Verizon: "VZ", PayPal: "PYPL", Alphabet: "GOOGL", "T-Mobile": "TMUS", Chevron: "CVX", "American Express": "AXP",
  };
  let ok = 0;
  for (const [q, t] of Object.entries(cases)) {
    const got = searchStocks(q, DATA.stocks)[0]?.t;
    assert.equal(got, t, `"${q}" → ${got}`);
    ok++;
  }
  assert.ok(ok >= 20);
  assert.equal(searchStocks("nvda", DATA.stocks)[0].t, "NVDA"); // tickers still work
  assert.equal(searchStocks("V", DATA.stocks)[0].t, "V"); // an exact ticker beats name matches
});

test("every alias points at a ticker in the data", () => {
  for (const [k, t] of Object.entries(ALIASES)) assert.ok(BY.has(t), `${k} → ${t}`);
});

// ----------------------------------------------------------------------------- one sentence per stock

test("every sub-industry has a plain family", () => {
  for (const s of DATA.stocks) assert.ok(familyOf(s.sub), `${s.t}: ${s.sub}`);
});

test("stock sentences: one per stock, only names from the stock's own lists", () => {
  const others = DATA.stocks.map((s) => ({ t: s.t, n: shortName(s) })).filter((x) => x.n.length >= 4);
  for (const s of DATA.stocks) {
    const text = stockSentence(s, BY);
    assert.ok(text.length > 40 && text.length <= 240, `${s.t}: ${text.length} chars`);
    assert.match(text, /\.$/);
    assert.doesNotMatch(text, /undefined|NaN|\(\)/, s.t);
    const allowed = [s.t, ...s.nnBeh.map(([t]) => t), ...s.nnBiz.map(([t]) => t)].map((t) => shortName(BY.get(t)));
    // Blank out the allowed names (longest first), then no other company's name may be left.
    let rest = text;
    for (const n of [...new Set(allowed)].sort((a, b) => b.length - a.length)) rest = rest.split(n).join(" ");
    for (const o of others) {
      const re = new RegExp(`(^|[^A-Za-z])${o.n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z]|$)`);
      assert.ok(!re.test(rest), `${s.t} mentions ${o.n} (${o.t}), not in its lists: ${text}`);
    }
  }
});

test("stock sentences: Nvidia matches the spec's example, and high-overlap stocks say no surprise", () => {
  assert.equal(
    stockSentence(BY.get("NVDA"), BY),
    "Nvidia reads like chipmakers (AMD and Intel), but its price moves with power and data-centre companies (Vertiv and GE Vernova): the market seems to treat it as an AI-infrastructure bet.",
  );
  for (const s of DATA.stocks) {
    const text = stockSentence(s, BY);
    const lone = ownList(s, "nnBeh")[0][1] < 0.3;
    if (Math.round(s.overlap * 10) >= 6 && !lone) assert.match(text, /^No surprise here: /, s.t);
    if (text.includes("seems to treat it as")) assert.notEqual(strength(ownList(s, "nnBeh")[0][1]), "Weak", s.t);
  }
});

test("share classes never appear twice in a sentence", () => {
  const s = stockSentence(BY.get("AMZN"), BY);
  assert.doesNotMatch(s, /Alphabet and Alphabet/);
  assert.doesNotMatch(stockSentence(BY.get("DIS"), BY), /Fox and Fox/);
});

// ----------------------------------------------------------------------------- pair themes

test("every Secret twin gets a theme tag", () => {
  for (const p of DATA.hidden) {
    const theme = pairTheme(BY.get(p.a), BY.get(p.b));
    assert.doesNotMatch(theme, / \+ /, `${p.a}-${p.b} fell back to sectors: ${theme}`);
  }
  assert.equal(pairTheme(BY.get("DUK"), BY.get("VICI")), "Steady income");
  assert.equal(pairTheme(BY.get("PHM"), BY.get("PPG")), "Housing");
});

// ----------------------------------------------------------------------------- "Start here" stories

const STORY_IDS = ["nvda-power", "oil-plastics", "utility-landlords", "pe-pack", "coke-colgate"];

test("stories: all five patterns hold in today's data", () => {
  assert.deepEqual(buildStories(DATA).map((s) => s.id), STORY_IDS);
  for (const s of buildStories(DATA)) {
    assert.ok(s.caption.split(/(?<=[.!?])\s+/).length <= 2, `${s.id}: more than 2 sentences`);
    if (s.focus.kind === "stock") assert.ok(BY.has(s.focus.t), s.id);
  }
});

test("stories: every caption matches the data it was built from", () => {
  const st = Object.fromEntries(buildStories(DATA).map((s) => [s.id, s]));
  const fam = (t) => familyOf(BY.get(t).sub);
  const nm = (t) => shortName(BY.get(t));

  // Nvidia: names are its first power/utility price matches; none of its price matches is a chipmaker.
  const nv = ownList(BY.get("NVDA"), "nnBeh");
  assert.ok(nv.every(([t]) => fam(t) !== "chips"));
  const power = nv.filter(([t]) => ["power", "utilities"].includes(fam(t))).slice(0, 3);
  assert.match(st["nvda-power"].caption, new RegExp(`They're ${power.map(([t]) => nm(t)).slice(0, -1).join(", ")} and ${nm(power.at(-1)[0])},`));
  assert.equal(st["nvda-power"].caption.includes("none of the links is strong"), power.every(([, v]) => strength(v) !== "Strong"));

  // Dow: the count of oil producers among its 5 price matches.
  const dowOil = ownList(BY.get("DOW"), "nnBeh").filter(([t]) => fam(t) === "oil");
  assert.match(st["oil-plastics"].caption, new RegExp(`yet ${dowOil.length} of its 5 closest price matches are oil`));
  for (const [t] of dowOil.slice(0, 3)) assert.ok(st["oil-plastics"].caption.includes(nm(t)), t);

  // Utilities ↔ landlords: the pair is on the Secret twins list, with the right word.
  const up = st["utility-landlords"].focus.p;
  assert.ok(DATA.hidden.some((p) => p.a === up.a && p.b === up.b));
  assert.ok(st["utility-landlords"].caption.includes(`(a ${strength(up.corr).toLowerCase()} link)`));
  assert.ok(st["utility-landlords"].caption.startsWith(nm(up.a)) || st["utility-landlords"].caption.startsWith(nm(up.b)));

  // KKR: its top 3 price matches, all strong.
  const kkr = ownList(BY.get("KKR"), "nnBeh").slice(0, 3);
  assert.ok(kkr.every(([, v]) => strength(v) === "Strong"));
  assert.ok(st["pe-pack"].caption.includes(`${nm(kkr[0][0])}, ${nm(kkr[1][0])} and ${nm(kkr[2][0])}`));

  // Coca-Cola: Colgate is its top price match, PepsiCo ranks below it, and Colgate is no business lookalike.
  const ko = BY.get("KO");
  assert.equal(ko.nnBeh[0][0], "CL");
  assert.ok(!ko.nnBiz.some(([t]) => t === "CL"));
  assert.ok(st["coke-colgate"].caption.includes(`(a ${strength(ko.nnBeh[0][1]).toLowerCase()} link)`));
  assert.equal(st["coke-colgate"].caption.includes("isn't PepsiCo"), ko.nnBeh.findIndex(([t]) => t === "PEP") > 0);
});

test("stories: a chip whose pattern no longer holds is hidden", () => {
  const without = (mutate) => {
    const d = clone();
    mutate(lookup(d), d);
    return buildStories(d).map((s) => s.id);
  };
  const others = (id) => STORY_IDS.filter((x) => x !== id);
  // Nvidia's top price match becomes a chipmaker.
  assert.deepEqual(without((by) => by.get("NVDA").nnBeh.unshift(["AMD", 0.5])), others("nvda-power"));
  // Dow stops trading with oil producers.
  assert.deepEqual(
    without((by) => (by.get("DOW").nnBeh = [["LYB", 0.89], ["PPG", 0.5], ["SHW", 0.5], ["APD", 0.5], ["ECL", 0.5]])),
    others("oil-plastics"),
  );
  // No utility–landlord pair left on the Secret twins list.
  assert.deepEqual(without((_by, d) => (d.hidden = d.hidden.filter((p) => !["VICI", "O"].includes(p.a) && !["VICI", "O"].includes(p.b)))), others("utility-landlords"));
  // Blackstone drops to a medium link with KKR.
  assert.deepEqual(without((by) => (by.get("KKR").nnBeh.find(([t]) => t === "BX")[1] = 0.5)), others("pe-pack"));
  // PepsiCo overtakes Colgate.
  assert.deepEqual(without((by) => by.get("KO").nnBeh.reverse()), others("coke-colgate"));
  // Nvidia missing altogether.
  assert.deepEqual(without((_by, d) => (d.stocks = d.stocks.filter((s) => s.t !== "NVDA"))), others("nvda-power"));
});

// ----------------------------------------------------------------------------- glossary and /pro

test("glossary covers the remaining jargon", () => {
  for (const t of ["S&P 500", "ETF", "sector", "correlation", "similarity", "swinginess"]) {
    assert.ok(GLOSSARY[t] && GLOSSARY[t].length < 140, t);
  }
  assert.equal(GLOSSARY.swinginess, "How much the stock moves when the whole market moves. 1 = moves with the market; 2 = moves twice as much.");
});

test("/pro is byte-for-byte unchanged (pro_meta/pro_checksums.sha256)", () => {
  const root = new URL("../../", import.meta.url);
  const lines = readFileSync(new URL("pro_meta/pro_checksums.sha256", root), "utf8").trim().split("\n");
  assert.ok(lines.length >= 40);
  for (const line of lines) {
    const [hash, path] = line.split(/\s+/, 2);
    const got = createHash("sha256").update(readFileSync(new URL(path, root))).digest("hex");
    assert.equal(got, hash, path);
  }
});
