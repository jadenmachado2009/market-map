// Shape of market_map_v2.json, written by pipeline_v2.py.
export type AssetClass = "stock" | "etf" | "fx" | "commodity" | "bond" | "crypto";
export type PresetId = "mkt" | "mkt_rates" | "full";
export type View = "beh" | "biz";
export type ColorMode = "divergence" | "sector" | "beta";

export type Asset = {
  t: string;
  name: string;
  cls: AssetClass;
  sector: string;
  sub: string;
  mcap: number | null; // $bn
  vol: number | null; // 1-year annualised
  adv: number | null; // 3-month average daily dollar volume, $m
  beta: number; // to SPY over the map window
  text: "edgar" | "yahoo" | "name" | null;
};

export type NnBeh = [ticker: string, corr: number, held: number, windows: number];
export type NnBiz = [ticker: string, simPct: number];
export type ClusterLabel = { id: number; label: string; auto: string; share: number; n: number; x: number; y: number };
export type PairRow = { a: string; b: string; corr: number; simPct: number; k: number; n: number };
export type DecoupleRow = { a: string; b: string; longRun: number; recent: number; k: number; n: number };
export type Pt = [number, number];

export type PresetData = {
  beh: (Pt | null)[];
  biz: (Pt | null)[];
  overlap: (number | null)[];
  exposure: (number[] | null)[];
  nnBeh: (NnBeh[] | null)[];
  clusters: Record<View, { ids: number[]; labels: ClusterLabel[] }>;
  hidden: PairRow[];
  apart: PairRow[];
  decouple: DecoupleRow[];
};

export type ProData = {
  version: number;
  asof: string;
  start: string;
  mapStart: string;
  dates: string[];
  years: number[];
  textSource: "edgar" | "yahoo";
  presets: { id: PresetId; label: string; factors: string[]; exposures: string[] }[];
  assets: Asset[];
  nnBiz: (NnBiz[] | null)[];
  data: Record<PresetId, PresetData>;
};

export type Filters = {
  mcapMin: number; // $bn, 0 = any (stocks only)
  volMin: number; // annualised, 0 = any
  volMax: number; // annualised, Infinity = any
  advMin: number; // $m, 0 = any
  classes: Record<AssetClass, boolean>;
};

export type Selection =
  | { kind: "stock"; i: number }
  | { kind: "pair"; a: number; b: number }
  | null;
