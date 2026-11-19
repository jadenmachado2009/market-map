// Shape of market_map.json, as written by market_map.ipynb (step 9).
export type Neighbour = [ticker: string, value: number];

export type Stock = {
  t: string;
  name: string;
  sector: string;
  sub: string;
  beh: [number, number]; // behaviour-map position, inside [-1, 1]
  biz: [number, number]; // business-map position, rotated to line up with beh
  overlap: number; // share of top-10 behaviour neighbours that are also top-10 business neighbours
  beta: number;
  nnBeh: Neighbour[]; // top 5 by residual correlation
  nnBiz: Neighbour[]; // top 5 by description similarity
};

export type Pair = { a: string; b: string; corr: number; sim: number };

export type MarketMapData = {
  asof: string;
  start: string;
  window: string;
  days: number;
  stocks: Stock[];
  apart: Pair[];
  hidden: Pair[];
};

export type View = "beh" | "biz";
export type ColorMode = "divergence" | "sector" | "beta";
