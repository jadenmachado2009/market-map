#!/usr/bin/env python3
"""Market Map Pro (v2) data pipeline.

Builds everything the /pro route needs: three factor presets, winsorised residual
correlations, yearly stability counts, a decoupling list, business-text similarity
(EDGAR 10-K Item 1 when SEC_USER_AGENT is set, Yahoo summaries otherwise), a
cross-asset universe, HDBSCAN clusters, and compact lazy-loaded binaries.

Usage:
    python pipeline_v2.py                  # full run
    python pipeline_v2.py --cached-prices  # reuse pro_cache/prices.pkl (fast reruns)

Env:
    SEC_USER_AGENT  "Name contact@email" as required by SEC fair access. Without it,
                    business text falls back to Yahoo summaries.

The math lives in small pure-numpy functions at the top (tested in tests_v2/).
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import re
import sys
import time
import warnings
from io import StringIO
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / "pro_cache"
OUT_JSON = ROOT / "web" / "src" / "data-pro" / "market_map_v2.json"
OUT_BIN = ROOT / "web" / "public" / "pro-data"
LABELS_FILE = ROOT / "cluster_labels_v2.json"

SEED = 42
START = "2016-01-01"
MAP_DAYS = 504          # 2 trading years, same window as v1
RECENT_DAYS = 60
WINSOR_K = 5.0
HOLD_THR = 0.3          # a yearly window "holds" if residual corr >= 0.3
STABLE_MIN = 5          # decoupling candidates must have held in >= 5 windows
DECOUPLE_DROP = 0.3
TOP_Q = 0.99
N_LIST = 25
K_OVERLAP = 10

FACTORS = {
    "mkt": ["SPY"],
    "mkt_rates": ["SPY", "TLT"],
    "full": ["SPY", "TLT", "IWM", "IWD", "IWF"],
}
PRESET_LABEL = {"mkt": "Market", "mkt_rates": "+ Rates", "full": "+ Rates, size, value"}
# Exposures shown on the risk card. For "full" the five ETFs are re-expressed as
# market / rates / size (IWM-SPY) / value (IWD-IWF): same fit, readable betas.
EXPOSURE_NAMES = {"mkt": ["Market"], "mkt_rates": ["Market", "Rates"], "full": ["Market", "Rates", "Size", "Value"]}

CROSS = {
    "etf": ["XLB", "XLC", "XLE", "XLF", "XLI", "XLK", "XLP", "XLRE", "XLU", "XLV", "XLY", "QQQ", "IWM", "EFA", "EEM"],
    "fx": ["UUP", "FXE", "FXY", "FXB", "FXA"],
    "commodity": ["GLD", "SLV", "USO"],
    "bond": ["TLT", "IEF", "HYG"],
    "crypto": ["BTC-USD", "ETH-USD"],
}
CROSS_NAMES = {
    "XLB": "Materials Select Sector SPDR", "XLC": "Communication Services Select Sector SPDR",
    "XLE": "Energy Select Sector SPDR", "XLF": "Financial Select Sector SPDR", "XLI": "Industrial Select Sector SPDR",
    "XLK": "Technology Select Sector SPDR", "XLP": "Consumer Staples Select Sector SPDR",
    "XLRE": "Real Estate Select Sector SPDR", "XLU": "Utilities Select Sector SPDR",
    "XLV": "Health Care Select Sector SPDR", "XLY": "Consumer Discretionary Select Sector SPDR",
    "QQQ": "Invesco QQQ (Nasdaq-100)", "IWM": "iShares Russell 2000", "EFA": "iShares MSCI EAFE",
    "EEM": "iShares MSCI Emerging Markets", "UUP": "US Dollar Index Bullish", "FXE": "Euro Trust",
    "FXY": "Japanese Yen Trust", "FXB": "British Pound Trust", "FXA": "Australian Dollar Trust",
    "GLD": "SPDR Gold", "SLV": "iShares Silver", "USO": "US Oil Fund", "TLT": "iShares 20+ Year Treasury",
    "IEF": "iShares 7-10 Year Treasury", "HYG": "iShares High Yield Corporate Bond",
    "BTC-USD": "Bitcoin", "ETH-USD": "Ether",
}
CLASS_LABEL = {"etf": "Equity ETFs", "fx": "Currencies", "commodity": "Commodities", "bond": "Bonds", "crypto": "Crypto"}


# ----------------------------------------------------------------------------- math

def residualize(R: np.ndarray, F: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """OLS of every column of R (T x N) on [1, F] (F is T x K).

    Returns (residuals T x N, betas K x N). Intercepts are dropped from the betas.
    """
    F = np.asarray(F, float).reshape(len(R), -1)
    X = np.column_stack([np.ones(len(F)), F])
    coef, *_ = np.linalg.lstsq(X, R, rcond=None)
    return R - X @ coef, coef[1:]


def winsorize(E: np.ndarray, k: float = WINSOR_K) -> np.ndarray:
    """Clip each column at its mean +/- k sample standard deviations (NaN-aware)."""
    mu = np.nanmean(E, axis=0, keepdims=True)
    sd = np.nanstd(E, axis=0, ddof=1, keepdims=True)
    return np.clip(E, mu - k * sd, mu + k * sd)


def corr_matrix(E: np.ndarray) -> np.ndarray:
    """Pearson correlation of the columns of a complete (no-NaN) matrix."""
    Z = E - E.mean(axis=0)
    sd = Z.std(axis=0, ddof=1)
    with np.errstate(invalid="ignore", divide="ignore"):
        Z = Z / sd
        C = (Z.T @ Z) / (len(E) - 1)
    np.fill_diagonal(C, 1.0)
    return np.clip(C, -1, 1)


def stability_counts(mats: list[np.ndarray], thr: float = HOLD_THR) -> tuple[np.ndarray, np.ndarray]:
    """For a list of N x N correlation matrices (NaN = pair not available in that window),
    return (k, n): windows where the pair held (corr >= thr) and windows where it existed."""
    stack = np.stack(mats)
    valid = ~np.isnan(stack)
    k = ((np.nan_to_num(stack, nan=-np.inf) >= thr) & valid).sum(axis=0)
    return k, valid.sum(axis=0)


def neff(C: np.ndarray, w: np.ndarray | None = None) -> float:
    """Effective number of independent bets from eigenvalues of W^1/2 C W^1/2.

    (sum lambda)^2 / sum lambda^2 = tr(M)^2 / ||M||_F^2, so no eigen-decomposition is needed.
    """
    n = len(C)
    w = np.full(n, 1.0 / n) if w is None else np.asarray(w, float) / np.sum(w)
    num = np.sum(w) ** 2
    den = np.sum(np.outer(w, w) * C ** 2)
    return float(num / den)


def tri_index(i: int, j: int, n: int) -> int:
    """Position of pair (i, j), i != j, in the row-major strict upper triangle of an n x n matrix."""
    if i > j:
        i, j = j, i
    return i * n - i * (i + 1) // 2 + (j - i - 1)


def upper(M: np.ndarray) -> np.ndarray:
    return M[np.triu_indices(len(M), 1)]


def exposures(preset: str, betas: np.ndarray) -> np.ndarray:
    """Risk-card exposures from raw factor betas (K x N) for a preset."""
    if preset != "full":
        return betas
    spy, tlt, iwm, iwd, iwf = betas
    # IWM = size + mkt, IWD = tilt + mkt + value/2, IWF = tilt + mkt - value/2
    return np.vstack([spy + iwm + iwd + iwf, tlt, iwm, (iwd - iwf) / 2])


# ----------------------------------------------------------------------------- helpers

def log(*a):
    print(*a, flush=True)


def q16(x: np.ndarray) -> np.ndarray:
    """Correlations to int16 (x 10000), NaN -> -32768."""
    out = np.round(np.nan_to_num(x, nan=0.0) * 10000).astype(np.int16)
    out[np.isnan(x)] = -32768
    return out


def r3(v) -> float:
    return round(float(v), 3)


# ----------------------------------------------------------------------------- data

def load_universe():
    import pandas as pd
    import requests

    html = requests.get("https://en.wikipedia.org/wiki/List_of_S%26P_500_companies",
                        headers={"User-Agent": "Mozilla/5.0"}, timeout=30).text
    t = pd.read_html(StringIO(html))[0]
    t["Symbol"] = t["Symbol"].str.replace(".", "-", regex=False)
    t = t.set_index("Symbol")
    meta = {}
    for sym, row in t.iterrows():
        meta[sym] = {"name": row["Security"], "cls": "stock", "sector": row["GICS Sector"],
                     "sub": row["GICS Sub-Industry"], "cik": int(row["CIK"]) if not pd.isna(row["CIK"]) else None}
    for cls, ticks in CROSS.items():
        for sym in ticks:
            meta[sym] = {"name": CROSS_NAMES[sym], "cls": cls, "sector": CLASS_LABEL[cls], "sub": CLASS_LABEL[cls], "cik": None}
    return meta


def download_prices(tickers: list[str], cached: bool):
    import pandas as pd
    import yfinance as yf

    path = CACHE / "prices.pkl"
    if cached and path.exists():
        log(f"prices: using cache {path.name}")
        return pd.read_pickle(path)

    def chunk(ts, tries=3):
        for k in range(tries):
            try:
                df = yf.download(ts, start=START, auto_adjust=True, progress=False, threads=True)
                if not df.empty:
                    return df[["Close", "Volume"]]
            except Exception as e:  # noqa: BLE001
                log(f"  retry {ts[0]}…: {type(e).__name__}")
            time.sleep(10 * (k + 1))
        raise RuntimeError(f"download failed for chunk starting {ts[0]}")

    parts = [chunk(tickers[i:i + 100]) for i in range(0, len(tickers), 100)]
    px = pd.concat([p["Close"] for p in parts], axis=1, sort=True)
    vol = pd.concat([p["Volume"] for p in parts], axis=1, sort=True)
    data = {"close": px, "volume": vol}
    CACHE.mkdir(exist_ok=True)
    pd.to_pickle(data, path)
    return data


class Polite:
    """At most ~8 requests/second (SEC limit is 10)."""

    def __init__(self, ua: str):
        import requests
        self.s = requests.Session()
        self.s.headers.update({"User-Agent": ua, "Accept-Encoding": "gzip, deflate"})
        self.last = 0.0

    def get(self, url: str, **kw):
        wait = 0.125 - (time.time() - self.last)
        if wait > 0:
            time.sleep(wait)
        self.last = time.time()
        r = self.s.get(url, timeout=90, **kw)
        r.raise_for_status()
        return r


ITEM1 = re.compile(r"item\s*1\s*[\.:\-–—]?\s*business\b", re.I)
ITEM1A = re.compile(r"item\s*1a\s*[\.:\-–—]?\s*risk\s*factors", re.I)


def html_to_text(html: bytes) -> str:
    import lxml.html

    doc = lxml.html.fromstring(html)
    for bad in doc.xpath("//script|//style|//*[local-name()='header']"):
        bad.drop_tree()
    for el in doc.iter("p", "div", "tr", "br", "li", "h1", "h2", "h3", "h4", "td"):
        el.tail = ("\n" + el.tail) if el.tail else "\n"
    text = doc.text_content()
    text = re.sub(r"[ \t ]+", " ", text)
    return re.sub(r"\n\s*\n+", "\n", text)


def extract_item1(text: str) -> str | None:
    """Longest span between an 'Item 1. Business' heading and the next 'Item 1A. Risk Factors'."""
    best = ""
    ends = [m.start() for m in ITEM1A.finditer(text)]
    for m in ITEM1.finditer(text):
        nxt = [e for e in ends if e > m.end()]
        if not nxt:
            continue
        span = text[m.end():nxt[0]]
        if len(span) > len(best):
            best = span
    best = best.strip()
    return best[:200_000] if len(best) >= 2000 else None


def edgar_texts(meta: dict, stocks: list[str], ua: str) -> dict[str, str]:
    """Item 1 of each company's latest 10-K, cached per accession number."""
    d = CACHE / "edgar"
    d.mkdir(parents=True, exist_ok=True)
    http = Polite(ua)
    out, fails = {}, []
    for n, t in enumerate(stocks, 1):
        cik = meta[t]["cik"]
        if not cik:
            fails.append(t)
            continue
        try:
            sub = http.get(f"https://data.sec.gov/submissions/CIK{cik:010d}.json").json()
            rec = sub["filings"]["recent"]
            i = next(i for i, f in enumerate(rec["form"]) if f in ("10-K", "10-KT"))
            acc, doc = rec["accessionNumber"][i], rec["primaryDocument"][i]
            f = d / f"{cik}_{acc}.txt.gz"
            if f.exists():
                out[t] = gzip.decompress(f.read_bytes()).decode()
                continue
            html = http.get(f"https://www.sec.gov/Archives/edgar/data/{cik}/{acc.replace('-', '')}/{doc}").content
            item1 = extract_item1(html_to_text(html))
            if item1:
                f.write_bytes(gzip.compress(item1.encode()))
                out[t] = item1
            else:
                fails.append(t)
        except Exception as e:  # noqa: BLE001
            log(f"  EDGAR {t}: {type(e).__name__}")
            fails.append(t)
        if n % 50 == 0:
            log(f"  EDGAR {n}/{len(stocks)}")
    log(f"EDGAR: Item 1 for {len(out)} companies, {len(fails)} fell back: {fails[:20]}{'…' if len(fails) > 20 else ''}")
    return out


def yahoo_texts(stocks: list[str]) -> dict[str, str]:
    import yfinance as yf

    path = CACHE / "yahoo_desc.json"
    desc = json.loads(path.read_text()) if path.exists() else {}
    seed = ROOT / "desc_cache.json"  # v1 notebook cache, if present locally
    if seed.exists():
        for k, v in json.loads(seed.read_text()).items():
            desc.setdefault(k, v)
    todo = [t for t in stocks if desc.get(t) is None]
    for t in todo:
        try:
            desc[t] = yf.Ticker(t).info.get("longBusinessSummary") or ""
        except Exception:  # noqa: BLE001
            desc[t] = None
        time.sleep(0.25)
    CACHE.mkdir(exist_ok=True)
    path.write_text(json.dumps(desc))
    return {t: desc[t] for t in stocks if desc.get(t)}


BOILER = re.compile(r"[^.]*\b(incorporated|founded|headquartered|formerly known as|changed its name)\b[^.]*\.\s*", re.I)
SUFFIX = re.compile(r"\s*\(.*?\)|,?\s+(Inc\.?|Corp\.?|Corporation|Company|Co\.|plc|Ltd\.?|Limited|Holdings?|Group|N\.V\.|The)$", re.I)


def core_name(n: str) -> str:
    prev = None
    while prev != n:
        prev, n = n, SUFFIX.sub("", n).strip(" ,")
    return n


def clean_text(t: str, name: str) -> str:
    t, c = BOILER.sub("", t), core_name(name)
    for w in sorted({c, c.split()[0]}, key=len, reverse=True):
        if len(w) >= 3:
            t = re.sub(rf"\b{re.escape(w)}\b", "The company", t)
    return t


def embed(texts: list[str], words: int = 200, max_chunks: int = 40) -> np.ndarray:
    """Mean of chunk embeddings, so long Item 1 sections aren't cut at 256 tokens."""
    from sentence_transformers import SentenceTransformer

    model = SentenceTransformer("all-MiniLM-L6-v2", device="cpu")
    chunks, owner = [], []
    for i, t in enumerate(texts):
        w = t.split()
        pieces = [" ".join(w[k:k + words]) for k in range(0, max(len(w), 1), words)][:max_chunks] or [t]
        chunks += pieces
        owner += [i] * len(pieces)
    E = model.encode(chunks, normalize_embeddings=True, batch_size=64, show_progress_bar=False).astype(np.float64)
    owner = np.array(owner)
    out = np.vstack([E[owner == i].mean(0) for i in range(len(texts))])
    out -= out.mean(0)  # remove the average description
    return out / np.linalg.norm(out, axis=1, keepdims=True)


def shares_outstanding(ua: str) -> dict[int, float]:
    """Latest dei:EntityCommonStockSharesOutstanding per CIK from the EDGAR frames API."""
    http = Polite(ua)
    out: dict[int, tuple[str, float]] = {}
    y = time.gmtime().tm_year
    for year in (y - 1, y):
        for q in (1, 2, 3, 4):
            url = f"https://data.sec.gov/api/xbrl/frames/dei/EntityCommonStockSharesOutstanding/shares/CY{year}Q{q}I.json"
            try:
                for row in http.get(url).json()["data"]:
                    prev = out.get(row["cik"])
                    if prev is None or row["end"] > prev[0]:
                        out[row["cik"]] = (row["end"], float(row["val"]))
            except Exception:  # noqa: BLE001 - future quarters 404
                continue
    return {k: v[1] for k, v in out.items()}


# ----------------------------------------------------------------------------- layout

def umap_layout(D=None, X=None):
    import umap

    warnings.filterwarnings("ignore")
    if D is not None:
        return umap.UMAP(metric="precomputed", n_neighbors=15, min_dist=0.1, random_state=SEED).fit_transform(D)
    return umap.UMAP(metric="cosine", n_neighbors=15, min_dist=0.1, random_state=SEED).fit_transform(X)


def norm2d(a: np.ndarray) -> np.ndarray:
    a = a - a.mean(0)
    return a / np.abs(a).max()


def hdbscan_labels(Y: np.ndarray) -> np.ndarray:
    from sklearn.cluster import HDBSCAN

    return HDBSCAN(min_cluster_size=6, min_samples=3).fit_predict(Y)


def label_clusters(ids: np.ndarray, Y: np.ndarray, tick: list[str], meta: dict, overrides: list[dict]):
    """Auto label = most common GICS sub-industry (or asset class); manual overrides by member overlap."""
    from collections import Counter

    out = []
    for c in sorted(set(ids) - {-1}):
        m = np.where(ids == c)[0]
        members = [tick[i] for i in m]
        subs = Counter(meta[t]["sub"] for t in members).most_common()
        secs = Counter(meta[t]["sector"] for t in members).most_common()
        if subs[0][1] / len(members) >= 0.4:          # a sub-industry that covers the cluster
            auto, cnt = subs[0]
        elif secs[0][1] / len(members) >= 0.5:        # otherwise the dominant sector
            auto, cnt = secs[0]
        else:                                         # otherwise say it's mixed
            auto, cnt = "Mixed: " + " / ".join(s for s, _ in secs[:2]), secs[0][1]
        out.append({"id": int(c), "label": auto, "auto": auto, "share": round(cnt / len(members), 2), "n": len(members),
                    "x": r3(np.median(Y[m, 0])), "y": r3(np.median(Y[m, 1])), "members": members})
    for ov in overrides:  # each override names at most one cluster: the best-matching one
        match = set(ov.get("tickers", []))
        match |= {t for t in tick if meta[t]["sector"] in ov.get("sectors", []) or meta[t]["sub"] in ov.get("subs", [])}
        best, score = None, 0.0
        for cl in out:
            share = len(match & set(cl["members"])) / cl["n"]
            if cl["n"] >= 4 and share >= 0.6 and share * cl["n"] > score:
                best, score = cl, share * cl["n"]
        if best:
            best["label"] = ov["label"]
    for cl in out:
        del cl["members"]
    return out


# ----------------------------------------------------------------------------- main

def window_resid(Rw: np.ndarray, Fw: np.ndarray):
    E, B = residualize(Rw, Fw)
    return winsorize(E), B


def main():
    import pandas as pd
    from scipy.linalg import orthogonal_procrustes
    from scipy.stats import rankdata

    ap = argparse.ArgumentParser()
    ap.add_argument("--cached-prices", action="store_true")
    args = ap.parse_args()
    t0 = time.time()
    CACHE.mkdir(exist_ok=True)

    meta = load_universe()
    factor_only = sorted({f for fs in FACTORS.values() for f in fs} - set(meta))
    data = download_prices(list(meta) + factor_only, args.cached_prices)
    close, volume = data["close"], data["volume"]
    cal = close["SPY"].dropna().index                       # equity trading calendar
    close = close.reindex(cal).ffill(limit=3)               # crypto weekends fold into Monday
    volume = volume.reindex(cal)
    lr = np.log(close).diff().iloc[1:]
    log(f"prices: {close.shape[1]} tickers, {len(cal)} days, {cal[0].date()} to {cal[-1].date()}")

    # map window and universe: complete data over the last 2 years (after small-gap fill)
    win = lr.iloc[-MAP_DAYS:]
    assets = [t for t in meta if t in win and win[t].notna().all()]
    dropped = [t for t in meta if t not in assets]
    log(f"universe: {len(assets)} assets ({sum(meta[t]['cls'] == 'stock' for t in assets)} stocks); dropped {len(dropped)}: {dropped}")
    N = len(assets)
    ix = {t: i for i, t in enumerate(assets)}
    is_stock = np.array([meta[t]["cls"] == "stock" for t in assets])
    stock_idx = np.where(is_stock)[0]

    # ---- filter metadata
    ann_vol = lr[assets].iloc[-252:].std() * np.sqrt(252)
    dollar_vol = close[assets] * volume[assets]
    crypto = [t for t in assets if meta[t]["cls"] == "crypto"]
    dollar_vol[crypto] = volume[crypto]                 # Yahoo quotes crypto volume in USD already
    adv = dollar_vol.iloc[-63:].mean()
    ua = os.environ.get("SEC_USER_AGENT", "").strip()
    mcap = {}
    try:
        shares = shares_outstanding(ua or "MarketMapPro/2.0 (research script)")
        last = close[assets].iloc[-1]
        for t in assets:
            cik = meta[t]["cik"]
            if cik and cik in shares:
                mcap[t] = shares[cik] * last[t]
        log(f"market cap: {len(mcap)} of {int(is_stock.sum())} stocks from EDGAR frames")
    except Exception as e:  # noqa: BLE001
        log(f"market cap: EDGAR frames failed ({type(e).__name__})")
    import yfinance as yf
    for t in [a for a in assets if meta[a]["cls"] == "stock" and a not in mcap]:
        try:
            mcap[t] = float(yf.Ticker(t).fast_info["marketCap"])
        except Exception:  # noqa: BLE001
            pass
        time.sleep(0.2)
    log(f"market cap: {len(mcap)} of {int(is_stock.sum())} stocks after Yahoo fallback")

    # ---- business text (stocks only)
    stocks = [assets[i] for i in stock_idx]
    source = "yahoo"
    texts = {}
    if ua and "@" in ua:
        texts = edgar_texts(meta, stocks, ua)
        source = "edgar"
    missing = [t for t in stocks if t not in texts]
    if missing:
        yt = yahoo_texts(missing)
        texts.update(yt)
        log(f"business text: {len(stocks) - len(missing)} from EDGAR, {len(yt)} from Yahoo, "
            f"{len(missing) - len(yt)} name-only")
    text_src = {t: ("edgar" if source == "edgar" and t not in missing else "yahoo" if t in texts else "name") for t in stocks}
    raw = [texts.get(t) or f"{meta[t]['name']}: {meta[t]['sub']}" for t in stocks]
    emb = embed([clean_text(x, meta[t]["name"]) for x, t in zip(raw, stocks)])
    S_st = emb @ emb.T
    S = np.full((N, N), np.nan)
    S[np.ix_(stock_idx, stock_idx)] = S_st
    iu_st = np.triu_indices(len(stocks), 1)
    pct_up = rankdata(S_st[iu_st]) / len(iu_st[0]) * 100
    P_st = np.full_like(S_st, np.nan)
    P_st[iu_st] = pct_up
    P_st.T[iu_st] = pct_up
    P = np.full((N, N), np.nan)
    P[np.ix_(stock_idx, stock_idx)] = P_st
    log(f"text similarity: {len(stocks)} stocks, source={source}")

    biz_raw = umap_layout(X=emb)

    # ---- yearly windows since 2016
    years = sorted({d.year for d in lr.index})
    year_rows = {y: np.where(lr.index.year == y)[0] for y in years}
    years = [y for y in years if len(year_rows[y]) >= 120]

    overrides = json.loads(LABELS_FILE.read_text()) if LABELS_FILE.exists() else []
    R2 = win[assets].to_numpy()
    out_presets, report = {}, {}
    OUT_BIN.mkdir(parents=True, exist_ok=True)
    M = N * (N - 1) // 2

    # total-return (no factors) correlation over the map window, winsorised the same way
    C_raw = corr_matrix(winsorize(R2))
    q16(upper(C_raw)).tofile(OUT_BIN / "matrix_raw.bin")
    np.where(np.isnan(upper(P)), 65535, np.round(np.nan_to_num(upper(P)) * 100)).astype(np.uint16).tofile(OUT_BIN / "sim_pct.bin")
    close[assets].iloc[-MAP_DAYS:].to_numpy().T.astype(np.float32).tofile(OUT_BIN / "series_close.f32")

    for p, fac in FACTORS.items():
        tp = time.time()
        inp = np.array([t not in fac for t in assets])        # a factor ETF can't be explained by itself
        F2 = win[fac].to_numpy()
        E2, B2 = window_resid(R2, F2)
        E2[:, ~inp] = np.nan
        C = np.full((N, N), np.nan)
        C[np.ix_(inp, inp)] = corr_matrix(E2[:, inp])
        expo = exposures(p, B2)

        # yearly stability
        mats = []
        for y in years:
            rows = year_rows[y]
            Ry = lr[assets].iloc[rows].to_numpy()
            Fy = lr[fac].iloc[rows].to_numpy()
            ok = inp & ~np.isnan(Ry).any(0) & ~np.isnan(Fy).any()
            Cy = np.full((N, N), np.nan)
            if ok.sum() > 2:
                Ey, _ = window_resid(Ry[:, ok], Fy)
                Cy[np.ix_(ok, ok)] = corr_matrix(Ey)
            mats.append(Cy)
        K, Nw = stability_counts(mats)

        # long-run level: whole history, each asset regressed on its own available rows
        Rl = lr[assets].to_numpy()
        Fl = lr[fac].to_numpy()
        El = np.full_like(Rl, np.nan)
        for j in np.where(inp)[0]:
            m = ~np.isnan(Rl[:, j]) & ~np.isnan(Fl).any(1)
            if m.sum() > 250:
                e, _ = residualize(Rl[m, j:j + 1], Fl[m])
                El[m, j] = e[:, 0]
        El = winsorize(El)
        CL = pd.DataFrame(El).corr(min_periods=250).to_numpy()

        # recent 60 days, from the 2-year residuals
        C60 = np.full((N, N), np.nan)
        C60[np.ix_(inp, inp)] = corr_matrix(E2[-RECENT_DAYS:, inp])

        # behaviour layout + business layout aligned to it
        sub = np.where(inp)[0]
        D = np.sqrt(2 * (1 - np.clip(C[np.ix_(sub, sub)], -1, 1)))
        beh = np.full((N, 2), np.nan)
        beh[sub] = norm2d(umap_layout(D=D))
        common = np.array([i for i in stock_idx if inp[i]])
        bz = norm2d(biz_raw)
        bz_full = np.full((N, 2), np.nan)
        bz_full[stock_idx] = bz
        Rot, _ = orthogonal_procrustes(bz_full[common], beh[common])
        bz_full[stock_idx] = bz_full[stock_idx] @ Rot
        s = np.nanmax(np.abs(np.vstack([beh, bz_full])))
        beh, bz_full = beh / s, bz_full / s

        # clusters
        clusters = {}
        for view, Y in (("beh", beh), ("biz", bz_full)):
            has = np.where(~np.isnan(Y[:, 0]))[0]
            lab = np.full(N, -1)
            lab[has] = hdbscan_labels(Y[has])
            clusters[view] = {"ids": [int(v) for v in lab],
                              "labels": label_clusters(lab[has], Y[has], [assets[i] for i in has], meta, overrides)}

        # neighbours and overlap
        def topk(row, k, pool):
            row = row.copy()
            mask = np.zeros(N, bool)
            mask[pool] = True
            row[~mask | np.isnan(row)] = -np.inf
            return [j for j in np.argsort(-row)[:k] if np.isfinite(row[j])]

        st_in = np.array([i for i in stock_idx if inp[i]])
        all_in = np.where(inp)[0]
        nn_beh, overlap = [], []
        for i in range(N):
            if not inp[i]:
                nn_beh.append(None)
                overlap.append(None)
                continue
            pool = st_in if is_stock[i] else all_in
            row = C[i].copy()
            row[i] = np.nan
            nb = topk(row, 5, pool)
            nn_beh.append([[assets[j], r3(C[i, j]), int(K[i, j]), int(Nw[i, j])] for j in nb])
            if is_stock[i]:
                rs = S[i].copy()
                rs[i] = np.nan
                a = set(topk(row, K_OVERLAP, st_in))
                b = set(topk(rs, K_OVERLAP, stock_idx))
                overlap.append(round(len(a & b) / K_OVERLAP, 1))
            else:
                overlap.append(None)

        # lists (stock pairs only; they need business text)
        si, sj = np.triu_indices(N, 1)
        both = is_stock[si] & is_stock[sj] & inp[si] & inp[sj]
        pc, ps, pp = C[si, sj], S[si, sj], P[si, sj]
        cand = np.where(both)[0]
        hc = cand[pc[cand] > np.quantile(pc[cand], TOP_Q)]
        hidden = hc[np.argsort(ps[hc])[:N_LIST]]
        hs = cand[ps[cand] > np.quantile(ps[cand], TOP_Q)]
        apart = hs[np.argsort(pc[hs])[:N_LIST]]
        pair = lambda q: {"a": assets[si[q]], "b": assets[sj[q]], "corr": r3(pc[q]), "simPct": round(float(pp[q]), 1),
                          "k": int(K[si[q], sj[q]]), "n": int(Nw[si[q], sj[q]])}
        no_etf = np.array([meta[t]["cls"] != "etf" for t in assets])
        anyp = np.where(inp[si] & inp[sj] & no_etf[si] & no_etf[sj])[0]
        drop = CL[si, sj] - C60[si, sj]
        dc = anyp[(K[si[anyp], sj[anyp]] >= STABLE_MIN) & (drop[anyp] > DECOUPLE_DROP)]
        dc = dc[np.argsort(-drop[dc])][:N_LIST]

        out_presets[p] = {
            "beh": [None if np.isnan(v[0]) else [r3(v[0]), r3(v[1])] for v in beh],
            "biz": [None if np.isnan(v[0]) else [r3(v[0]), r3(v[1])] for v in bz_full],
            "overlap": overlap,
            "exposure": [None if not inp[i] else [round(float(x), 2) for x in expo[:, i]] for i in range(N)],
            "nnBeh": nn_beh,
            "clusters": clusters,
            "hidden": [pair(q) for q in hidden],
            "apart": [pair(q) for q in apart],
            "decouple": [{"a": assets[si[q]], "b": assets[sj[q]], "longRun": r3(CL[si[q], sj[q]]),
                          "recent": r3(C60[si[q], sj[q]]), "k": int(K[si[q], sj[q]]), "n": int(Nw[si[q], sj[q]])} for q in dc],
        }
        report[p] = out_presets[p]["hidden"][:10]

        # lazy binaries: residual series, and the pair matrices
        E2.T.astype(np.float32).tofile(OUT_BIN / f"series_resid_{p}.f32")
        with open(OUT_BIN / f"matrix_{p}.bin", "wb") as f:
            q16(upper(C)).tofile(f)
            q16(upper(CL)).tofile(f)
            upper(K).astype(np.uint8).tofile(f)
            upper(Nw).astype(np.uint8).tofile(f)
        log(f"preset {p}: {int(inp.sum())} assets, {len(years)} yearly windows, "
            f"{len(out_presets[p]['decouple'])} decoupling pairs ({time.time() - tp:.0f}s)")

    nn_biz = []
    for i in range(N):
        if not is_stock[i]:
            nn_biz.append(None)
            continue
        row = S[i].copy()
        row[i] = -np.inf
        row[~is_stock] = -np.inf
        nn_biz.append([[assets[j], round(float(P[i, j]), 1)] for j in np.argsort(-row)[:5]])

    beta_mkt = residualize(R2, win[["SPY"]].to_numpy())[1][0]
    doc = {
        "version": 2,
        "asof": str(cal[-1].date()),
        "start": str(lr.index[0].date()),
        "mapStart": str(win.index[0].date()),
        "dates": [str(d.date()) for d in win.index],
        "years": years,
        "textSource": source,
        "presets": [{"id": p, "label": PRESET_LABEL[p], "factors": FACTORS[p], "exposures": EXPOSURE_NAMES[p]} for p in FACTORS],
        "assets": [{"t": t, "name": meta[t]["name"], "cls": meta[t]["cls"], "sector": meta[t]["sector"], "sub": meta[t]["sub"],
                    "mcap": round(mcap[t] / 1e9, 1) if t in mcap and np.isfinite(mcap[t]) else None,
                    "vol": round(float(ann_vol[t]), 3) if np.isfinite(ann_vol[t]) else None,
                    "adv": round(float(adv[t]) / 1e6, 1) if np.isfinite(adv[t]) else None,
                    "beta": round(float(beta_mkt[ix[t]]), 2),
                    "text": text_src.get(t)} for t in assets],
        "nnBiz": nn_biz,
        "data": out_presets,
    }
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(doc, separators=(",", ":"), allow_nan=False))
    log(f"wrote {OUT_JSON.relative_to(ROOT)} ({OUT_JSON.stat().st_size / 1024:.0f} KB) and "
        f"{len(list(OUT_BIN.iterdir()))} binaries in {OUT_BIN.relative_to(ROOT)} (N={N}, pairs={M})")

    # ---- report
    log("\nTOP 10 HIDDEN TWINS BY PRESET")
    for p, rows in report.items():
        log(f"  [{PRESET_LABEL[p]}]")
        for r in rows:
            log(f"    {r['a']:>6} {r['b']:<6} corr {r['corr']:.2f}  less similar than {100 - r['simPct']:.0f}% of pairs"
                f"  held {r['k']}/{r['n']}  ({meta[r['a']]['sub']} / {meta[r['b']]['sub']})")
    test = ["NVDA", "AMD", "AVGO", "MSFT", "GOOGL", "JPM", "BAC", "XOM", "CVX", "DUK", "NEE", "O"]
    ti = [ix[t] for t in test if t in ix]
    log("\nN_eff, test portfolio (equal weight): " + ", ".join(test))
    log(f"  total return (no factors): {neff(C_raw[np.ix_(ti, ti)]):.2f}")
    for p in FACTORS:
        Cp = matrix_from_bin(p, N)[0]
        log(f"  residual, {PRESET_LABEL[p]}: {neff(Cp[np.ix_(ti, ti)]):.2f}")
    log(f"\ndone in {time.time() - t0:.0f}s")


def matrix_from_bin(p: str, N: int):
    M = N * (N - 1) // 2
    raw = np.fromfile(OUT_BIN / f"matrix_{p}.bin", dtype=np.uint8)
    c = raw[:2 * M].view(np.int16)
    out = np.full((N, N), np.nan)
    iu = np.triu_indices(N, 1)
    v = np.where(c == -32768, np.nan, c / 10000)
    out[iu] = v
    out.T[iu] = v
    np.fill_diagonal(out, 1.0)
    return out, None


if __name__ == "__main__":
    sys.exit(main())
