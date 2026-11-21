// Plain-language layer for the classic map (v1.1): strength words, short names, name search,
// one-sentence stock summaries, pair themes and the "Start here" stories.
// Copy only: everything here is derived from market_map.json and never changes a number.
// No value imports, so `node --test` can load this file directly (type imports are stripped).
import type { MarketMapData, Pair, Stock } from "./types";

// ----------------------------------------------------------------------------- strength words

export type Strength = "Strong" | "Medium" | "Weak";

// Classified on the value as shown (toFixed(2), like fmt), so the word and the number never disagree.
const shown = (v: number) => Number(v.toFixed(2));

/** Correlation or description similarity → word. Strong ≥ 0.6, Medium 0.4–0.6, Weak < 0.4. */
export function strength(v: number): Strength {
  const r = shown(v);
  return r >= 0.6 ? "Strong" : r >= 0.4 ? "Medium" : "Weak";
}

/** Business overlap in the pair lists, on the same thresholds. */
export function overlapWord(sim: number): "High" | "Medium" | "Low" {
  const s = strength(sim);
  return s === "Strong" ? "High" : s === "Medium" ? "Medium" : "Low";
}

/** "Surprise" for a stock: of its 10 closest price matches, how many are also among its 10 business lookalikes. */
export function surpriseWord(overlap: number): "High" | "Medium" | "Low" {
  const shared = Math.round(overlap * 10);
  return shared <= 1 ? "High" : shared <= 3 ? "Medium" : "Low";
}

// ----------------------------------------------------------------------------- companies and names

// Share classes of one company. v1 keeps both tickers (the data is unchanged); copy treats them as one.
export const SHARE_CLASSES: string[][] = [
  ["GOOGL", "GOOG"],
  ["FOXA", "FOX"],
  ["NWSA", "NWS"],
];
const CLASS_OF = new Map(SHARE_CLASSES.flatMap((g) => g.map((t) => [t, g[0]] as const)));
export const sameCompany = (a: string, b: string) => a === b || (CLASS_OF.get(a) ?? a) === (CLASS_OF.get(b) ?? b);

/** Companies, counting each multi-class company once. */
export function companyCount(stocks: Stock[]): number {
  const have = new Set(stocks.map((s) => s.t));
  const extra = SHARE_CLASSES.reduce((n, g) => n + Math.max(0, g.filter((t) => have.has(t)).length - 1), 0);
  return stocks.length - extra;
}

const NAME_OVERRIDES: Record<string, string> = {
  "BRK-B": "Berkshire Hathaway",
  DIS: "Disney",
  LLY: "Eli Lilly",
  KO: "Coca-Cola",
  F: "Ford",
  SO: "Southern Company",
  HIG: "The Hartford",
  COO: "Cooper Companies",
  PG: "Procter & Gamble",
  JNJ: "Johnson & Johnson",
  AMD: "AMD",
  CMG: "Chipotle",
  LULU: "Lululemon",
  OXY: "Occidental",
  UPS: "UPS",
  ADP: "ADP",
  TMUS: "T-Mobile",
  BKNG: "Booking.com",
  IBM: "IBM",
  EIX: "Edison International",
};

/** "Coca-Cola Company (The)" → "Coca-Cola", "Nike, Inc." → "Nike", "Alphabet Inc. (Class A)" → "Alphabet". */
export function shortName(s: Pick<Stock, "t" | "name">): string {
  if (NAME_OVERRIDES[s.t]) return NAME_OVERRIDES[s.t];
  let n = s.name.replace(/\s*\(Class [A-C]\)$/, "").replace(/\s*\(The\)$/, "");
  n = n.replace(/\s*& (Co\.|Company)$/, "");
  for (let i = 0; i < 2; i++) {
    n = n.replace(/,?\s+(Inc\.?|Incorporated|Corporation|Corp\.?|Company|Companies|plc|PLC|Limited|Ltd\.?)$/, "");
  }
  // Drop generic tails people don't say: "Akamai Technologies" → "Akamai", "Apollo Global Management" → "Apollo".
  n = n.replace(/\s+(Technologies|Platforms|Global Management|Management|International)$/, "");
  return n.trim();
}

// ----------------------------------------------------------------------------- search by name

const norm = (x: string) =>
  x.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Common names, nicknames and famous brands → ticker. Keys are normalised (lower case, letters and digits only).
export const ALIASES: Record<string, string> = {
  google: "GOOGL", alphabet: "GOOGL", youtube: "GOOGL", android: "GOOGL", gmail: "GOOGL",
  facebook: "META", instagram: "META", whatsapp: "META",
  coke: "KO", cocacola: "KO",
  pepsi: "PEP", gatorade: "PEP", doritos: "PEP",
  jpmorgan: "JPM", jpmorganchase: "JPM", chase: "JPM",
  bofa: "BAC", bankofamerica: "BAC",
  amex: "AXP",
  exxon: "XOM", mobil: "XOM",
  berkshire: "BRK-B", buffett: "BRK-B", geico: "BRK-B",
  jj: "JNJ", johnsonandjohnson: "JNJ",
  elililly: "LLY", lilly: "LLY", mounjaro: "LLY",
  disney: "DIS", espn: "DIS", hulu: "DIS", marvel: "DIS", pixar: "DIS",
  mcdonalds: "MCD", mcdonald: "MCD",
  iphone: "AAPL",
  windows: "MSFT", xbox: "MSFT", linkedin: "MSFT", github: "MSFT",
  aws: "AMZN", wholefoods: "AMZN",
  generalmotors: "GM", chevrolet: "GM", chevy: "GM", cadillac: "GM",
  ford: "F",
  att: "T",
  tmobile: "TMUS",
  goldman: "GS",
  kfc: "YUM", tacobell: "YUM", pizzahut: "YUM",
  olivegarden: "DRI",
  tjmaxx: "TJX", marshalls: "TJX",
  oreo: "MDLZ", cadbury: "MDLZ",
  gillette: "PG", pampers: "PG", tide: "PG",
  kleenex: "KMB", huggies: "KMB",
  foxnews: "FOXA",
  wsj: "NWSA", wallstreetjournal: "NWSA",
  bookingcom: "BKNG", priceline: "BKNG",
  hp: "HPQ",
  dominos: "DPZ",
};

/** Ranked matches for the search box: exact ticker, then aliases, ticker prefixes, then names. */
export function searchStocks(query: string, stocks: Stock[], limit = 8): Stock[] {
  const q = norm(query);
  if (!q) return [];
  const qt = query.trim().toUpperCase();
  const aliasHits = new Set(
    Object.entries(ALIASES)
      .filter(([k]) => k === q || (q.length >= 3 && k.startsWith(q)))
      .map(([, t]) => t),
  );
  const score = (s: Stock): number => {
    const name = shortName(s);
    if (s.t === qt) return 0;
    if (ALIASES[q] === s.t) return 1;
    if (norm(name) === q) return 2;
    if (aliasHits.has(s.t)) return 3;
    if (s.t.startsWith(qt) || norm(s.t).startsWith(q)) return 4;
    const words = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (words.some((_, i) => words.slice(i).join("").startsWith(q))) return 5;
    const full = norm(s.name);
    if (q.length >= 3 && full.includes(q)) return 6;
    return 99;
  };
  return stocks
    .map((s) => ({ s, k: score(s) }))
    .filter((x) => x.k < 99)
    .sort((a, b) => a.k - b.k || a.s.t.length - b.s.t.length || a.s.t.localeCompare(b.s.t))
    .slice(0, limit)
    .map((x) => x.s);
}

// ----------------------------------------------------------------------------- business families

type Family = { one: string; many: string; subs: string[]; bet?: string };

// GICS sub-industries grouped into families with plain names. Every sub-industry in the data has one.
export const FAMILIES: Record<string, Family> = {
  chips: { one: "chipmaker", many: "chipmakers", subs: ["Semiconductors", "Semiconductor Materials & Equipment"] },
  hardware: {
    one: "tech-hardware maker", many: "tech-hardware makers",
    subs: ["Technology Hardware, Storage & Peripherals", "Communications Equipment", "Electronic Components",
      "Electronic Manufacturing Services", "Electronic Equipment & Instruments", "Technology Distributors", "Consumer Electronics"],
  },
  software: {
    one: "software company", many: "software and IT companies",
    subs: ["Application Software", "Systems Software", "IT Consulting & Other Services", "Internet Services & Infrastructure",
      "Data Processing & Outsourced Services", "Health Care Technology"],
  },
  internet: {
    one: "internet company", many: "internet companies",
    subs: ["Interactive Media & Services", "Interactive Home Entertainment", "Advertising", "Broadline Retail"],
  },
  media: { one: "media company", many: "media companies", subs: ["Movies & Entertainment", "Broadcasting", "Cable & Satellite", "Publishing"] },
  telecom: { one: "phone carrier", many: "phone carriers", subs: ["Integrated Telecommunication Services", "Wireless Telecommunication Services"] },
  power: {
    one: "power or data-centre company", many: "power and data-centre companies", bet: "an AI-infrastructure bet",
    subs: ["Electrical Components & Equipment", "Heavy Electrical Equipment", "Construction & Engineering",
      "Independent Power Producers & Energy Traders", "Data Center REITs"],
  },
  utilities: {
    one: "utility", many: "utilities", bet: "a safe, steady bet",
    subs: ["Electric Utilities", "Multi-Utilities", "Gas Utilities", "Water Utilities"],
  },
  property: {
    one: "property company", many: "property companies",
    subs: ["Health Care REITs", "Hotel & Resort REITs", "Industrial REITs", "Multi-Family Residential REITs", "Office REITs",
      "Other Specialized REITs", "Retail REITs", "Self-Storage REITs", "Single-Family Residential REITs", "Telecom Tower REITs",
      "Real Estate Services"],
  },
  banks: { one: "bank", many: "banks", subs: ["Diversified Banks", "Regional Banks"] },
  investing: {
    one: "investment firm", many: "investment firms",
    subs: ["Investment Banking & Brokerage", "Asset Management & Custody Banks", "Financial Exchanges & Data"],
  },
  payments: {
    one: "payments company", many: "payments and credit companies",
    subs: ["Transaction & Payment Processing Services", "Consumer Finance"],
  },
  insurers: {
    one: "insurer", many: "insurers",
    subs: ["Property & Casualty Insurance", "Multi-line Insurance", "Life & Health Insurance", "Reinsurance", "Insurance Brokers",
      "Multi-Sector Holdings"],
  },
  oil: {
    one: "oil and gas company", many: "oil and gas companies", bet: "an oil bet",
    subs: ["Integrated Oil & Gas", "Oil & Gas Equipment & Services", "Oil & Gas Exploration & Production",
      "Oil & Gas Refining & Marketing", "Oil & Gas Storage & Transportation"],
  },
  chemicals: {
    one: "chemical maker", many: "chemical makers",
    subs: ["Commodity Chemicals", "Specialty Chemicals", "Fertilizers & Agricultural Chemicals", "Industrial Gases"],
  },
  packaging: { one: "packaging maker", many: "packaging makers", subs: ["Paper & Plastic Packaging Products & Materials", "Metal, Glass & Plastic Containers"] },
  metals: { one: "miner or steelmaker", many: "miners and steelmakers", subs: ["Steel", "Copper", "Gold"] },
  housing: {
    one: "housing-related company", many: "housing-related companies", bet: "a housing bet",
    subs: ["Homebuilding", "Building Products", "Home Improvement Retail", "Homefurnishing Retail", "Construction Materials", "Timber REITs"],
  },
  industrial: {
    one: "industrial company", many: "industrial companies",
    subs: ["Industrial Machinery & Supplies & Components", "Construction Machinery & Heavy Transportation Equipment",
      "Agricultural & Farm Machinery", "Industrial Conglomerates", "Trading Companies & Distributors", "Distributors",
      "Automotive Parts & Equipment"],
  },
  aerospace: { one: "aerospace or defence company", many: "aerospace and defence companies", subs: ["Aerospace & Defense"] },
  freight: { one: "freight company", many: "freight companies", subs: ["Rail Transportation", "Air Freight & Logistics", "Cargo Ground Transportation"] },
  travel: {
    one: "travel company", many: "travel companies",
    subs: ["Hotels, Resorts & Cruise Lines", "Passenger Airlines", "Casinos & Gaming", "Passenger Ground Transportation"],
  },
  restaurants: { one: "restaurant chain", many: "restaurant chains", subs: ["Restaurants"] },
  retail: {
    one: "retailer", many: "retailers",
    subs: ["Apparel Retail", "Other Specialty Retail", "Automotive Retail", "Computer & Electronics Retail"],
  },
  brands: {
    one: "consumer brand", many: "consumer brands",
    subs: ["Apparel, Accessories & Luxury Goods", "Footwear", "Leisure Products", "Specialized Consumer Services"],
  },
  autos: { one: "carmaker", many: "carmakers", subs: ["Automobile Manufacturers"] },
  staples: {
    one: "everyday-goods company", many: "everyday-goods companies", bet: "a safe, steady bet",
    subs: ["Agricultural Products & Services", "Consumer Staples Merchandise Retail", "Distillers & Vintners", "Food Distributors",
      "Food Retail", "Household Products", "Packaged Foods & Meats", "Personal Care Products",
      "Soft Drinks & Non-alcoholic Beverages", "Tobacco"],
  },
  drugs: { one: "drugmaker", many: "drugmakers", subs: ["Pharmaceuticals", "Biotechnology"] },
  medtech: {
    one: "medical-device or lab company", many: "medical-device and lab companies",
    subs: ["Health Care Equipment", "Health Care Supplies", "Life Sciences Tools & Services"],
  },
  care: {
    one: "healthcare services company", many: "healthcare services companies",
    subs: ["Managed Health Care", "Health Care Services", "Health Care Facilities", "Health Care Distributors"],
  },
  services: {
    one: "business-services firm", many: "business-services firms",
    subs: ["Environmental & Facilities Services", "Diversified Support Services", "Human Resource & Employment Services",
      "Research & Consulting Services"],
  },
};

const FAMILY_OF = new Map(Object.entries(FAMILIES).flatMap(([k, f]) => f.subs.map((s) => [s, k] as const)));
export const familyOf = (sub: string): string | undefined => FAMILY_OF.get(sub);

// ----------------------------------------------------------------------------- one sentence per stock

type Lookup = Map<string, Stock>;
const LONE_WOLF = 0.3; // closest price match below this: the stock follows no crowd

const andList = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

/** Neighbours with share classes folded: the stock's own other class goes, and each company appears once. */
export const ownList = (s: Stock, which: "nnBeh" | "nnBiz") =>
  s[which].filter(([t], i, all) => !sameCompany(t, s.t) && !all.slice(0, i).some(([u]) => sameCompany(u, t)));

// The family that most neighbours share (ties go to the higher-ranked neighbour), its size and its members.
function crowd(list: [string, number][], by: Lookup) {
  const count = new Map<string, string[]>();
  for (const [t] of list) {
    const f = familyOf(by.get(t)?.sub ?? "");
    if (!f) continue;
    count.set(f, [...(count.get(f) ?? []), t]);
  }
  let best: { fam: string; members: string[] } | null = null;
  for (const [fam, members] of count) if (!best || members.length > best.members.length) best = { fam, members };
  return best;
}

/**
 * One plain sentence per stock, filled only from its own two neighbour lists.
 * It names a group only when 3 of the 5 neighbours share it, says "loosely" when the links are weak,
 * and only reads a "bet" into the price crowd when that link is at least medium.
 */
export function stockSentence(s: Stock, by: Lookup): string {
  const name = shortName(s);
  const nm = (t: string) => shortName(by.get(t) ?? { t, name: t });
  const fam = (t: string) => familyOf(by.get(t)?.sub ?? "");
  const beh = ownList(s, "nnBeh");
  const biz = ownList(s, "nnBiz");
  const corr = new Map(beh);
  const cb = crowd(biz, by);
  const ch = crowd(beh, by);
  const shared = Math.round(s.overlap * 10);

  const bizGroup = cb && cb.members.length >= 3 ? cb : null;
  const bizNamed = bizGroup ? bizGroup.members.slice(0, 2) : biz.slice(0, 2).map(([t]) => t);
  const bizPart = bizGroup
    ? `reads like ${FAMILIES[bizGroup.fam].many} (${andList(bizNamed.map(nm))})`
    : `reads most like ${andList(bizNamed.map(nm))}`;

  if (beh.length && beh[0][1] < LONE_WOLF) {
    return `${name} ${bizPart}, but its price follows no crowd: even its closest match, ${nm(beh[0][0])}, is only a weak link.`;
  }
  if (shared >= 6) {
    const both = beh.filter(([t]) => biz.some(([u]) => u === t)).map(([t]) => nm(t));
    const ex = (both.length >= 2 ? both : beh.map(([t]) => nm(t))).slice(0, 2);
    return `No surprise here: ${name} trades with its business peers, like ${andList(ex)}.`;
  }

  const behGroup = ch && ch.members.length >= 3 ? ch : null;
  const behNamed = behGroup ? behGroup.members.slice(0, 2) : beh.slice(0, 2).map(([t]) => t);
  const loosely = strength(corr.get(behNamed[0]) ?? 0) === "Weak" ? "loosely " : "";
  const ex = andList(behNamed.map(nm));

  if (behGroup && bizGroup && behGroup.fam === bizGroup.fam) {
    const different = !behNamed.some((t) => biz.some(([u]) => u === t));
    return `${name} ${bizPart} and ${loosely}trades with them too${different ? ", just different ones" : ""} (${ex}).`;
  }
  const behPart = behGroup ? `${FAMILIES[behGroup.fam].many} (${ex})` : ex;
  const most = behGroup ? "" : "most ";
  // "but" only when none of the price crowd is in a business family the lookalikes are in.
  const bizFams = new Set([...(bizGroup ? [bizGroup.fam] : []), ...bizNamed.map(fam)]);
  const contrast = !behNamed.some((t) => bizFams.has(fam(t)));
  const bet = behGroup && !loosely && familyOf(s.sub) !== behGroup.fam ? FAMILIES[behGroup.fam].bet : undefined;
  const suffix = bet && contrast ? `: the market seems to treat it as ${bet}` : "";
  return contrast
    ? `${name} ${bizPart}, but its price ${loosely}moves ${most}with ${behPart}${suffix}.`
    : `${name} ${bizPart}, and its price ${loosely}moves ${most}with ${behPart}.`;
}

// ----------------------------------------------------------------------------- pair themes

// Same rules as /pro's pair_themes_v2.json (copied, so v1 never reads /pro files), with plain names.
// One v1 change: Timber REITs count as housing (Weyerhaeuser sells lumber for homes).
const SETS: Record<string, string[]> = {
  UTIL: FAMILIES.utilities.subs,
  REIT: [...FAMILIES.property.subs.filter((x) => x.endsWith("REITs")), "Data Center REITs"],
  INSURANCE: FAMILIES.insurers.subs,
  OIL: FAMILIES.oil.subs,
  CHEM: FAMILIES.chemicals.subs,
  HOUSING: FAMILIES.housing.subs,
  AI: [...FAMILIES.chips.subs, "Electronic Components", "Electrical Components & Equipment", "Heavy Electrical Equipment",
    "Construction & Engineering", "Communications Equipment", "Technology Hardware, Storage & Peripherals",
    "Electronic Manufacturing Services", "Independent Power Producers & Energy Traders", "Data Center REITs",
    "Internet Services & Infrastructure"],
  BANKS: [...FAMILIES.banks.subs, ...FAMILIES.investing.subs, ...FAMILIES.payments.subs],
  STAPLES: FAMILIES.staples.subs,
  TELCO: [...FAMILIES.telecom.subs, "Cable & Satellite"],
  CYCLICAL: [...FAMILIES.industrial.subs, "Steel", "Copper", "Diversified Support Services", ...FAMILIES.freight.subs,
    ...FAMILIES.packaging.subs],
  TRAVEL: [...FAMILIES.travel.subs, "Restaurants", "Leisure Products"],
  HEALTH: [...FAMILIES.drugs.subs, ...FAMILIES.medtech.subs, ...FAMILIES.care.subs, "Health Care Technology"],
};
const RULES: [theme: string, a: string[], b: string[] | "*"][] = [
  ["Steady income", ["UTIL"], ["REIT"]],
  ["Steady income", ["UTIL"], ["INSURANCE"]],
  ["Safe havens", ["UTIL", "REIT"], ["STAPLES", "TELCO"]],
  ["Utilities", ["UTIL"], ["UTIL"]],
  ["Landlords", ["REIT"], ["REIT"]],
  ["Housing", ["HOUSING"], "*"],
  ["Oil → chemicals", ["OIL"], ["CHEM"]],
  ["Oil & gas", ["OIL"], ["OIL"]],
  ["AI build-out", ["AI"], ["AI"]],
  ["Insurance", ["INSURANCE"], ["INSURANCE"]],
  ["Banks & markets", ["BANKS"], ["BANKS", "INSURANCE"]],
  ["Software & data", ["SOFTDATA"], ["SOFTDATA"]],
  ["Industrial cycle", ["CYCLICAL"], ["CYCLICAL", "CHEM", "AI"]],
  ["Travel & leisure", ["TRAVEL"], ["TRAVEL"]],
  ["Health care", ["HEALTH"], ["HEALTH"]],
  ["Everyday goods", ["STAPLES"], ["STAPLES"]],
];
SETS.SOFTDATA = [...FAMILIES.software.subs, "Financial Exchanges & Data", "Research & Consulting Services",
  "Human Resource & Employment Services", "Electronic Equipment & Instruments", "Transaction & Payment Processing Services"];

export const THEME_WHY: Record<string, string> = {
  "Steady income": "Both pay steady dividends, and investors buy them as safe holdings when markets get nervous.",
  "Safe havens": "Both sell things people need in good times and bad, so investors hide in them together.",
  Housing: "Both depend on people building, buying or fixing up homes.",
  "Oil → chemicals": "Chemicals and plastics are made from oil and gas, so both ride the energy cycle.",
  "AI build-out": "Both sell into the rush to build AI data centres.",
  Insurance: "Both earn money from insurance, even if they describe it differently.",
  "Industrial cycle": "Both rise and fall with factory orders and the wider economy.",
};

const inSets = (sub: string, names: string[]) => names.some((n) => SETS[n]?.includes(sub));

/** Theme tag for a pair, e.g. "Housing". Unmatched pairs get their two sectors. */
export function pairTheme(a: Stock, b: Stock): string {
  for (const [theme, A, B] of RULES) {
    const hit = (x: Stock, y: Stock) => inSets(x.sub, A) && (B === "*" || inSets(y.sub, B));
    if (hit(a, b) || hit(b, a)) return theme;
  }
  return a.sector === b.sector ? a.sector : `${a.sector} + ${b.sector}`;
}

// ----------------------------------------------------------------------------- "Start here" stories

export type Story = {
  id: string;
  title: string;
  caption: string;
  focus: { kind: "stock"; t: string } | { kind: "pair"; p: Pair };
};

type Draft = { id: string; title: string; build: (d: MarketMapData, by: Lookup) => Omit<Story, "id" | "title"> | null };

const lower = (w: Strength) => w.toLowerCase();

// Each story checks its own pattern against the data and fills its caption from it.
// A story whose pattern no longer holds returns null and its chip is hidden.
export const STORY_DRAFTS: Draft[] = [
  {
    id: "nvda-power",
    title: "Why Nvidia trades like a power company",
    build: (_d, by) => {
      const s = by.get("NVDA");
      if (!s) return null;
      const beh = ownList(s, "nnBeh");
      const fam = (t: string) => familyOf(by.get(t)?.sub ?? "");
      if (beh.some(([t]) => fam(t) === "chips")) return null; // its price twins must not be chipmakers
      if (ownList(s, "nnBiz").filter(([t]) => fam(t) === "chips").length < 2) return null; // but it reads like one
      const power = beh.filter(([t]) => fam(t) === "power" || fam(t) === "utilities").slice(0, 3);
      if (power.length < 2) return null;
      const names = andList(power.map(([t]) => shortName(by.get(t)!)));
      const anyStrong = power.some(([, v]) => strength(v) === "Strong");
      return {
        focus: { kind: "stock", t: "NVDA" },
        caption:
          `Nvidia's closest price matches aren't other chipmakers. They're ${names}, which build and power data centres: ` +
          (anyStrong
            ? "the market seems to trade Nvidia as part of one AI-infrastructure bet."
            : "none of the links is strong, but together they suggest the market trades Nvidia as part of one AI-infrastructure bet."),
      };
    },
  },
  {
    id: "oil-plastics",
    title: "Oil and plastics: secret twins",
    build: (_d, by) => {
      const s = by.get("DOW");
      if (!s || familyOf(s.sub) !== "chemicals") return null;
      const fam = (t: string) => familyOf(by.get(t)?.sub ?? "");
      const oil = ownList(s, "nnBeh").filter(([t]) => fam(t) === "oil");
      if (oil.length < 3) return null;
      if (ownList(s, "nnBiz").some(([t]) => fam(t) === "oil")) return null; // none of them is a business lookalike
      const names = andList(oil.slice(0, 3).map(([t]) => shortName(by.get(t)!)));
      return {
        focus: { kind: "stock", t: "DOW" },
        caption:
          `Dow makes chemicals and plastics, yet ${oil.length} of its 5 closest price matches are oil and gas producers, ` +
          `like ${names}. Plastics are made from oil and gas, so Dow and the drillers tend to rise and fall together.`,
      };
    },
  },
  {
    id: "utility-landlords",
    title: "Utilities that trade like landlords",
    build: (d, by) => {
      // Recognisable utility–landlord pairs, in order of preference; the first one on the Secret twins list wins.
      const LANDLORD: Record<string, string> = { VICI: "owns casino buildings", O: "rents buildings to shops" };
      const candidates: [utility: string, landlord: string][] = [["DUK", "VICI"], ["SO", "O"], ["SO", "VICI"], ["XEL", "O"]];
      for (const [a, b] of candidates) {
        const p = d.hidden.find((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a));
        const A = by.get(a), B = by.get(b);
        if (!p || !A || !B || familyOf(A.sub) !== "utilities" || !B.sub.endsWith("REITs")) continue;
        return {
          focus: { kind: "pair", p },
          caption:
            `${shortName(A)} sells electricity and ${shortName(B)} ${LANDLORD[b]}, yet their prices move together ` +
            `(a ${lower(strength(p.corr))} link). Investors seem to treat both as ` +
            `steady income for nervous markets, so they rise and fall as one bet.`,
        };
      }
      return null;
    },
  },
  {
    id: "pe-pack",
    title: "The private equity pack",
    build: (_d, by) => {
      const s = by.get("KKR");
      if (!s) return null;
      const PACK = new Set(["BX", "APO", "ARES", "CG", "OWL", "BLK"]);
      const top = ownList(s, "nnBeh").slice(0, 3);
      if (top.length < 3 || !top.every(([t, v]) => PACK.has(t) && strength(v) === "Strong")) return null;
      if (!top.some(([t]) => t === "BX") || !top.some(([t]) => t === "APO")) return null;
      const names = andList(top.map(([t]) => shortName(by.get(t)!)));
      return {
        focus: { kind: "stock", t: "KKR" },
        caption:
          `KKR's three closest price matches are ${names}, and all three links are strong. ` +
          `Owning several of them is close to owning one big bet on private equity, not several separate ones.`,
      };
    },
  },
  {
    id: "coke-colgate",
    title: "Coca-Cola's secret twin sells toothpaste",
    build: (_d, by) => {
      const s = by.get("KO");
      if (!s) return null;
      const beh = ownList(s, "nnBeh");
      if (!beh.length || beh[0][0] !== "CL" || strength(beh[0][1]) === "Weak") return null;
      if (ownList(s, "nnBiz").some(([t]) => t === "CL")) return null; // Colgate must not be a business lookalike
      const pep = beh.findIndex(([t]) => t === "PEP");
      return {
        focus: { kind: "stock", t: "KO" },
        caption:
          `Coca-Cola's closest price match ${pep > 0 ? "isn't PepsiCo: it's" : "is"} Colgate-Palmolive, the toothpaste maker ` +
          `(a ${lower(strength(beh[0][1]))} link). People buy both in good times and bad, so investors treat them as the same kind of safe bet.`,
      };
    },
  },
];

/** The stories whose pattern holds in this data, with captions filled from it. */
export function buildStories(d: MarketMapData): Story[] {
  const by: Lookup = new Map(d.stocks.map((s) => [s.t, s]));
  return STORY_DRAFTS.flatMap((x) => {
    const r = x.build(d, by);
    return r ? [{ id: x.id, title: x.title, ...r }] : [];
  });
}

// ----------------------------------------------------------------------------- glossary

export const GLOSSARY: Record<string, string> = {
  "S&P 500": "An index of about 500 of the biggest US companies. People use it as shorthand for “the market”.",
  ETF: "A fund you buy and sell like a single share, which holds a whole basket of stocks. SPY holds the whole S&P 500.",
  sector: "One of 11 broad industry groups, like Energy or Health Care, that every big US company is sorted into.",
  correlation:
    "A score from −1 to 1 for how closely two prices move together. 1 means always in step, 0 means no link at all.",
  similarity: "A score for how alike two companies’ business descriptions are. 0 is a typical pair; 0.4 and up is close.",
  swinginess:
    "How much the stock moves when the whole market moves. 1 = moves with the market; 2 = moves twice as much.",
};
