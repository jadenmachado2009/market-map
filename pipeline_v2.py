#!/usr/bin/env python3
"""Market Map Pro (v2.1) data pipeline.

Builds everything the /pro route needs: three factor presets (market; + rates & defensives;
+ size & value), winsorised residual correlations, yearly stability counts, stable pair lists
with theme tags, a Fisher-z / Benjamini-Hochberg decoupling list, business-text similarity
(SEC 10-K Item 1 when SEC_USER_AGENT is set, Yahoo summaries otherwise), a cross-asset universe,
HDBSCAN clusters, covariance inputs for the portfolio X-ray and hedge finder, and compact
lazy-loaded binaries.

Usage:
    python pipeline_v2.py                  # full run
    python pipeline_v2.py --cached-prices  # reuse pro_cache/prices.pkl (fast reruns)

Env:
    SEC_USER_AGENT  "Market Map you@example.com" as SEC fair access requires. Without it,
                    business text falls back to Yahoo summaries (and the log says so).

The maths lives in small pure-numpy functions at the top (tested in tests_v2/).
"""
from __future__ import annotations

import argparse
import gzip
import json
import math
import os
import re
import sys
import time
import warnings
from collections import Counter
from io import StringIO
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / "pro_cache"
OUT_JSON = ROOT / "web" / "src" / "data-pro" / "market_map_v2.json"
OUT_BIN = ROOT / "web" / "public" / "pro-data"
LABELS_FILE = ROOT / "cluster_labels_v2.json"
THEMES_FILE = ROOT / "pair_themes_v2.json"

SEED = 42
START = "2016-01-01"
MAP_DAYS = 504          # 2 trading years, same window as v1
YEAR_DAYS = 252
RECENT_DAYS = 60
WINSOR_K = 5.0
HOLD_THR = 0.3          # a calendar year "holds" if residual corr >= 0.3
TOP_Q = 0.99
N_LIST = 25
K_OVERLAP = 10
ITEM1_WORDS = 3000
DECOUPLE_MIN_LR = 0.5   # decoupling: only pairs with a long-run residual corr of 0.5+ ...
DECOUPLE_HELD = 7 / 11  # ... that held in at least 7 of 11 calendar years
FDR_Q = 0.05
CLUSTER_MERGE_EPS = 0.05  # merge same-sector clusters whose nearest members are this close

# Factor instruments per preset, and the regression basis that spans exactly the same space
# but gives readable betas (spreads instead of collinear ETFs).
FACTOR_INSTRUMENTS = {
    "mkt": ["SPY"],
    "rates_def": ["SPY", "TLT", "USMV"],
    "full": ["SPY", "TLT", "USMV", "IWM", "IWD", "IWF"],
}
FACTOR_COLS = {
    "mkt": ["MKT"],
    "rates_def": ["MKT", "RATES", "DEF"],
    "full": ["MKT", "RATES", "DEF", "SIZE", "VALUE", "TILT"],
}
EXPOSURE_NAMES = {
    "mkt": ["Market"],
    "rates_def": ["Market", "Rates", "Defensive"],
    "full": ["Market", "Rates", "Defensive", "Size", "Value", "Large-cap tilt"],
}
PRESET_LABEL = {"mkt": "Market", "rates_def": "+ Rates & defensives", "full": "+ Rates, defensives, size, value"}

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


# ----------------------------------------------------------------------------- maths

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


def stable_pair(k, n, n_full: int):
    """Hidden-twin / lookalike stability rule.

    Full history: held in at least 6 of 11 calendar years (scaled if there are more years).
    Shorter history: held in at least 60% of the available years, and in at least 4 of them.
    """
    k, n = np.asarray(k), np.asarray(n)
    need_full = math.ceil(n_full * 6 / 11)
    return np.where(n >= n_full, k >= need_full, (k >= np.ceil(0.6 * n)) & (k >= 4))


def fisher_z(r_recent, r_longrun, n: int = RECENT_DAYS):
    """Z = (atanh(r_recent) - atanh(r_longrun)) / (1 / sqrt(n - 3)). Negative = decoupled."""
    clip = lambda r: np.clip(np.asarray(r, float), -0.999999, 0.999999)
    return (np.arctanh(clip(r_recent)) - np.arctanh(clip(r_longrun))) * np.sqrt(n - 3)


def bh_reject(p, q: float = FDR_Q):
    """Benjamini-Hochberg. Returns (rejected mask, adjusted p-values) at false discovery rate q."""
    p = np.asarray(p, float)
    m = len(p)
    if m == 0:
        return np.zeros(0, bool), np.zeros(0)
    order = np.argsort(p)
    ranked = p[order] * m / np.arange(1, m + 1)
    adj_sorted = np.minimum(np.minimum.accumulate(ranked[::-1])[::-1], 1.0)
    adj = np.empty(m)
    adj[order] = adj_sorted
    return adj <= q, adj


def neff(C: np.ndarray, w: np.ndarray | None = None) -> float:
    """Old (v2.0) definition: eigenvalues of W^1/2 C W^1/2 for a correlation matrix C."""
    n = len(C)
    w = np.full(n, 1.0 / n) if w is None else np.asarray(w, float) / np.sum(w)
    return float(np.sum(w) ** 2 / np.sum(np.outer(w, w) * C ** 2))


def neff_cov(S: np.ndarray, w: np.ndarray) -> float:
    """v2.1: eigenvalues λ of M = diag(w) Σ diag(w); N_eff = (Σλ)² / Σλ² = tr(M)² / ||M||_F²."""
    w = np.asarray(w, float)
    M = np.outer(w, w) * S
    return float(np.trace(M) ** 2 / np.sum(M ** 2))


def risk_contrib(S: np.ndarray, w: np.ndarray) -> np.ndarray:
    """RC_i = w_i (Σw)_i / wᵀΣw. Sums to 1."""
    w = np.asarray(w, float)
    Sw = S @ w
    return w * Sw / (w @ Sw)


def tri_index(i: int, j: int, n: int) -> int:
    """Position of pair (i, j), i != j, in the row-major strict upper triangle of an n x n matrix."""
    if i > j:
        i, j = j, i
    return i * n - i * (i + 1) // 2 + (j - i - 1)


def upper(M: np.ndarray) -> np.ndarray:
    return M[np.triu_indices(len(M), 1)]


def factor_returns(lr):
    """Spread basis: same span as the instruments in FACTOR_INSTRUMENTS, readable betas."""
    import pandas as pd

    return pd.DataFrame({
        "MKT": lr["SPY"],
        "RATES": lr["TLT"],
        "DEF": lr["USMV"] - lr["SPY"],
        "SIZE": lr["IWM"] - lr["SPY"],
        "VALUE": lr["IWD"] - lr["IWF"],
        "TILT": (lr["IWD"] + lr["IWF"]) / 2 - lr["SPY"],
    })


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


def sig5(v) -> float | None:
    return None if v is None or not np.isfinite(v) else float(f"{float(v):.5g}")


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
        data = pd.read_pickle(path)
        if all(t in data["close"].columns for t in tickers):
            log(f"prices: using cache {path.name}")
            return data
        log("prices: cache is missing tickers, downloading")

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

    # yfinance's threaded download can fail single tickers (e.g. "database is locked" on its
    # SQLite cache in CI). Retry anything that came back empty, serially, so no stock silently drops.
    def empty():
        return [t for t in tickers if t not in px.columns or px[t].isna().all()]
    for attempt in range(3):
        miss = empty()
        if not miss:
            break
        log(f"  re-downloading {len(miss)} empty tickers (attempt {attempt + 1}): {miss[:12]}")
        time.sleep(5 * (attempt + 1))
        try:
            df = yf.download(miss, start=START, auto_adjust=True, progress=False, threads=False)
        except Exception as e:  # noqa: BLE001
            log(f"  retry failed: {type(e).__name__}")
            continue
        if df.empty:
            continue
        for t in miss:
            if t in df["Close"].columns and df["Close"][t].notna().any():
                px[t] = df["Close"][t].reindex(px.index)
                vol[t] = df["Volume"][t].reindex(vol.index)
    if empty():
        log(f"  still empty after retries: {empty()}")
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
    text = re.sub(r"[ \t ]+", " ", text)
    return re.sub(r"\n\s*\n+", "\n", text)


def extract_item1(text: str, max_words: int = ITEM1_WORDS) -> str | None:
    """Longest span between an 'Item 1. Business' heading and the next 'Item 1A. Risk Factors',
    capped at max_words. None if nothing substantial is found (table-of-contents hits are short)."""
    best = ""
    ends = [m.start() for m in ITEM1A.finditer(text)]
    for m in ITEM1.finditer(text):
        nxt = [e for e in ends if e > m.end()]
        if not nxt:
            continue
        span = text[m.end():nxt[0]]
        if len(span) > len(best):
            best = span
    words = best.split()
    return " ".join(words[:max_words]) if len(words) >= 300 else None


def edgar_texts(meta: dict, stocks: list[str], ua: str) -> tuple[dict[str, str], list[str]]:
    """Item 1 of each company's latest 10-K, cached per accession number. Returns (texts, failed)."""
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
    return out, fails


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


def embed(texts: list[str], words: int = 200, max_chunks: int = 20) -> np.ndarray:
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


# ----------------------------------------------------------------------------- layout, clusters, themes

def umap_layout(D=None, X=None, init=None):
    import umap

    warnings.filterwarnings("ignore")
    if D is not None:
        return umap.UMAP(metric="precomputed", n_neighbors=15, min_dist=0.1, random_state=SEED,
                         init="spectral" if init is None else init).fit_transform(D)
    return umap.UMAP(metric="cosine", n_neighbors=15, min_dist=0.1, random_state=SEED).fit_transform(X)


def norm2d(a: np.ndarray) -> np.ndarray:
    a = a - a.mean(0)
    return a / np.abs(a).max()


def align_to(A: np.ndarray, B: np.ndarray, rows: np.ndarray) -> np.ndarray:
    """Rotate/reflect and shift A so its `rows` best match B's (orthogonal Procrustes)."""
    from scipy.linalg import orthogonal_procrustes

    ma, mb = A[rows].mean(0), B[rows].mean(0)
    R, _ = orthogonal_procrustes(A[rows] - ma, B[rows] - mb)
    return (A - ma) @ R + mb


def anchored_layout(base: np.ndarray, C_new: np.ndarray, C_base: np.ndarray, keep_new: np.ndarray,
                    k: int = 10, keep_at: int = 5) -> tuple[np.ndarray, list[int]]:
    """Positions for another preset that only move stocks whose neighbourhood really changed.

    A stock that still shares at least `keep_at` of its top-k residual-correlation neighbours with
    the base (Market) preset keeps its base position. Otherwise it moves to the median base position
    of its new neighbours (plus a small deterministic offset so movers don't stack). Rows not in
    `keep_new` (factor instruments) are NaN.
    """
    N = len(base)
    pool = keep_new & ~np.isnan(base[:, 0])
    Y = np.full_like(base, np.nan)
    moved = []

    def top(C, i):
        r = C[i].copy()
        r[i] = -np.inf
        r[~pool | np.isnan(r)] = -np.inf
        return set(np.argsort(-r)[:k])
    for i in np.where(keep_new)[0]:
        n_new = top(C_new, i)
        if len(n_new & top(C_base, i)) >= keep_at:
            Y[i] = base[i]
        else:
            ang = i * 2.39996                                  # golden angle
            Y[i] = np.median(base[list(n_new)], axis=0) + 0.012 * np.array([np.cos(ang), np.sin(ang)])
            moved.append(i)
    return Y, moved


def hdbscan_labels(Y: np.ndarray) -> np.ndarray:
    from sklearn.cluster import HDBSCAN

    return HDBSCAN(min_cluster_size=6, min_samples=3).fit_predict(Y)


def merge_adjacent(ids: np.ndarray, Y: np.ndarray, sectors: list[str], eps: float = CLUSTER_MERGE_EPS) -> tuple[np.ndarray, list]:
    """Merge clusters that share a top sector and whose closest members are within eps."""
    from scipy.spatial.distance import cdist

    cl = sorted(set(ids) - {-1})
    top = {c: Counter(sectors[i] for i in np.where(ids == c)[0]).most_common(1)[0][0] for c in cl}
    parent = {c: c for c in cl}

    def find(c):
        while parent[c] != c:
            c = parent[c]
        return c
    merged = []
    for a_i, a in enumerate(cl):
        for b in cl[a_i + 1:]:
            if top[a] != top[b] or find(a) == find(b):
                continue
            d = cdist(Y[ids == a], Y[ids == b]).min()
            if d < eps:
                parent[find(b)] = find(a)
                merged.append((top[a], a, b, round(float(d), 3)))
    return np.array([find(c) if c != -1 else -1 for c in ids]), merged


def label_clusters(ids: np.ndarray, Y: np.ndarray, tick: list[str], meta: dict, overrides: list[dict]):
    """Manual overrides first (best member overlap), else the dominant sub-industry or sector.
    Never a 'Mixed' label: two-sector clusters are named 'A & B'."""
    out = []
    for c in sorted(set(ids) - {-1}):
        m = np.where(ids == c)[0]
        members = [tick[i] for i in m]
        subs = Counter(meta[t]["sub"] for t in members).most_common()
        secs = Counter(meta[t]["sector"] for t in members).most_common()
        if subs[0][1] / len(members) >= 0.4:
            auto, cnt = subs[0]
        elif secs[0][1] / len(members) >= 0.5 or len(secs) == 1:
            auto, cnt = secs[0]
        else:
            auto, cnt = f"{secs[0][0]} & {secs[1][0]}", secs[0][1] + secs[1][1]
        out.append({"id": int(c), "label": auto, "auto": auto, "share": round(cnt / len(members), 2), "n": len(members),
                    "x": r3(np.median(Y[m, 0])), "y": r3(np.median(Y[m, 1])), "members": members})
    # each cluster takes the override that covers most of it (>= 50% of members); an override can
    # name several clusters, but within one layout the bigger cluster keeps the plain name
    for cl in out:
        best, score = None, 0.0
        mem = set(cl["members"])
        for ov in overrides:
            match = set(ov.get("tickers", []))
            match |= {t for t in mem if meta[t]["sector"] in ov.get("sectors", []) or meta[t]["sub"] in ov.get("subs", [])}
            share = len(match & mem) / cl["n"]
            if share >= 0.5 and share > score:
                best, score = ov, share
        if best:
            cl["label"] = best["label"]
            cl["share"] = round(score, 2)
    seen: dict[str, int] = {}
    for cl in sorted(out, key=lambda c: -c["n"]):
        seen[cl["label"]] = seen.get(cl["label"], 0) + 1
        if seen[cl["label"]] > 1:          # e.g. two separate "Banks" islands
            cl["label"] = f"{cl['label']} ({seen[cl['label']]})"
    for cl in out:
        del cl["members"]
    return out


def load_themes():
    cfg = json.loads(THEMES_FILE.read_text())
    sets = cfg["sets"]

    def expand(items):
        out = set()
        for x in items:
            out |= set(sets[x[1:]]) if x.startswith("@") else {x}
        return out
    rules = [(r["theme"], expand(r["a"]), expand(r["b"])) for r in cfg["rules"]]
    overrides = {frozenset(o["pair"]): o["theme"] for o in cfg.get("overrides", [])}
    return rules, overrides


def pair_theme(a: str, b: str, meta: dict, rules, overrides) -> str:
    if frozenset((a, b)) in overrides:
        return overrides[frozenset((a, b))]
    sa, sb = meta[a]["sub"], meta[b]["sub"]
    hit = lambda s, S: "*" in S or s in S
    for theme, A, B in rules:
        if (hit(sa, A) and hit(sb, B)) or (hit(sa, B) and hit(sb, A)):
            return theme
    x, y = sorted((meta[a]["sector"], meta[b]["sector"]))
    return x if x == y else f"{x} × {y}"


# ----------------------------------------------------------------------------- main

def window_resid(Rw: np.ndarray, Fw: np.ndarray):
    E, B = residualize(Rw, Fw)
    return winsorize(E), B


def main():
    import pandas as pd
    from scipy.stats import norm, rankdata

    ap = argparse.ArgumentParser()
    ap.add_argument("--cached-prices", action="store_true")
    args = ap.parse_args()
    t0 = time.time()
    CACHE.mkdir(exist_ok=True)

    meta = load_universe()
    instruments = sorted({f for fs in FACTOR_INSTRUMENTS.values() for f in fs})
    factor_only = [f for f in instruments if f not in meta]
    data = download_prices(list(meta) + factor_only, args.cached_prices)
    close, volume = data["close"], data["volume"]
    cal = close["SPY"].dropna().index                       # equity trading calendar
    close = close.reindex(cal).ffill(limit=3)               # crypto weekends fold into Monday
    volume = volume.reindex(cal)
    lr = np.log(close).diff().iloc[1:]
    FR = factor_returns(lr)
    log(f"prices: {close.shape[1]} tickers, {len(cal)} days, {cal[0].date()} to {cal[-1].date()}")

    # map window and universe: complete data over the last 2 years (after small-gap fill)
    win = lr.iloc[-MAP_DAYS:]
    assets = [t for t in meta if t in win and win[t].notna().all()]
    dropped = [t for t in meta if t not in assets]
    log(f"universe: {len(assets)} assets ({sum(meta[t]['cls'] == 'stock' for t in assets)} stocks); dropped {len(dropped)}: {dropped}")
    N = len(assets)
    ix = {t: i for i, t in enumerate(assets)}
    is_stock = np.array([meta[t]["cls"] == "stock" for t in assets])
    is_etf = np.array([meta[t]["cls"] == "etf" for t in assets])
    stock_idx = np.where(is_stock)[0]
    sectors = [meta[t]["sector"] for t in assets]

    # ---- filter metadata
    ann_vol = lr[assets].iloc[-YEAR_DAYS:].std() * np.sqrt(YEAR_DAYS)
    dollar_vol = close[assets] * volume[assets]
    crypto = [t for t in assets if meta[t]["cls"] == "crypto"]
    dollar_vol[crypto] = volume[crypto]                 # Yahoo quotes crypto volume in USD already
    adv = dollar_vol.iloc[-63:].mean()
    ua = os.environ.get("SEC_USER_AGENT", "").strip()
    mcap = {}
    try:
        shares = shares_outstanding(ua or "MarketMapPro/2.1 (research script)")
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

    # ---- business text (stocks only): SEC 10-K Item 1, Yahoo only where EDGAR fails
    stocks = [assets[i] for i in stock_idx]
    texts: dict[str, str] = {}
    if ua and "@" in ua:
        texts, failed = edgar_texts(meta, stocks, ua)
        log(f"EDGAR: Item 1 for {len(texts)} of {len(stocks)} companies")
    else:
        failed = list(stocks)
        log("EDGAR: SEC_USER_AGENT not set (needs a contact email), so every company falls back to Yahoo")
    yt = yahoo_texts(failed) if failed else {}
    fallback = sorted(t for t in failed if t in yt)
    name_only = sorted(t for t in failed if t not in yt)
    texts.update({t: yt[t] for t in fallback})
    log(f"business text: {len(stocks) - len(failed)} SEC 10-K, {len(fallback)} Yahoo fallback, {len(name_only)} name only")
    if ua and fallback:
        log(f"  fell back to Yahoo: {', '.join(fallback)}")
    text_src = {t: ("edgar" if t not in failed else "yahoo" if t in yt else "name") for t in stocks}
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
    biz_raw = umap_layout(X=emb)

    # ---- total returns: covariance inputs (2y and 1y, winsorised), written once
    years = sorted({d.year for d in lr.index})
    year_rows = {y: np.where(lr.index.year == y)[0] for y in years}
    years = [y for y in years if len(year_rows[y]) >= 120]
    n_years = len(years)
    R2 = win[assets].to_numpy()
    W2, W1 = winsorize(R2), winsorize(R2[-YEAR_DAYS:])
    sd2, sd1 = W2.std(0, ddof=1), W1.std(0, ddof=1)
    C_raw, C_raw1 = corr_matrix(W2), corr_matrix(W1)
    OUT_BIN.mkdir(parents=True, exist_ok=True)
    for f in OUT_BIN.iterdir():
        f.unlink()
    q16(upper(C_raw)).tofile(OUT_BIN / "matrix_raw.bin")
    q16(upper(C_raw1)).tofile(OUT_BIN / "matrix_raw_1y.bin")
    np.where(np.isnan(upper(P)), 65535, np.round(np.nan_to_num(upper(P)) * 100)).astype(np.uint16).tofile(OUT_BIN / "sim_pct.bin")
    close[assets].iloc[-MAP_DAYS:].to_numpy().T.astype(np.float32).tofile(OUT_BIN / "series_close.f32")

    # ---- pass 1: per-preset residual statistics and raw layouts
    st: dict[str, dict] = {}
    for p, cols in FACTOR_COLS.items():
        tp = time.time()
        inp = np.array([t not in FACTOR_INSTRUMENTS[p] for t in assets])   # a factor can't explain itself
        F2 = FR.loc[win.index, cols].to_numpy()
        E2, B2 = window_resid(R2, F2)
        E2[:, ~inp] = np.nan
        C = np.full((N, N), np.nan)
        C[np.ix_(inp, inp)] = corr_matrix(E2[:, inp])
        mats = []
        for y in years:
            rows = year_rows[y]
            Ry = lr[assets].iloc[rows].to_numpy()
            Fy = FR[cols].iloc[rows].to_numpy()
            ok = inp & ~np.isnan(Ry).any(0) & ~np.isnan(Fy).any()
            Cy = np.full((N, N), np.nan)
            if ok.sum() > 2:
                Ey, _ = window_resid(Ry[:, ok], Fy)
                Cy[np.ix_(ok, ok)] = corr_matrix(Ey)
            mats.append(Cy)
        K, Nw = stability_counts(mats)
        Rl, Fl = lr[assets].to_numpy(), FR[cols].to_numpy()
        El = np.full_like(Rl, np.nan)
        for j in np.where(inp)[0]:
            m = ~np.isnan(Rl[:, j]) & ~np.isnan(Fl).any(1)
            if m.sum() > 250:
                e, _ = residualize(Rl[m, j:j + 1], Fl[m])
                El[m, j] = e[:, 0]
        CL = pd.DataFrame(winsorize(El)).corr(min_periods=250).to_numpy()
        C60 = np.full((N, N), np.nan)
        C60[np.ix_(inp, inp)] = corr_matrix(E2[-RECENT_DAYS:, inp])
        sub = np.where(inp)[0]
        if p == "mkt":
            beh = np.full((N, 2), np.nan)
            beh[sub] = norm2d(umap_layout(D=np.sqrt(2 * (1 - np.clip(C[np.ix_(sub, sub)], -1, 1)))))
            moved = []
        else:
            # Only stocks whose neighbourhood genuinely changes move (a fresh UMAP, even seeded from the
            # Market layout and Procrustes-aligned, moved ~96% of dots for no structural reason).
            beh, moved = anchored_layout(st["mkt"]["beh"], C, st["mkt"]["C"], inp)
        st[p] = dict(inp=inp, E2=E2, B2=B2, C=C, K=K, Nw=Nw, CL=CL, C60=C60, beh=beh, moved=moved,
                     sdres=np.nanstd(E2, 0, ddof=1))
        log(f"preset {p}: {int(inp.sum())} assets, {n_years} yearly windows"
            + (f", {len(moved)} stocks change neighbourhood vs Market: {', '.join(assets[i] for i in moved[:20])}" if p != "mkt" else "")
            + f" ({time.time() - tp:.0f}s)")

    # ---- keep positions stable: align every layout to the Market layout (orthogonal Procrustes)
    ref = st["mkt"]["beh"]
    for p in FACTOR_COLS:
        if p == "mkt":
            continue
        rows = np.where(st[p]["inp"] & st["mkt"]["inp"])[0]
        b = st[p]["beh"]
        has = ~np.isnan(b[:, 0])
        b[has] = align_to(b, ref, rows)[has]
    bz = np.full((N, 2), np.nan)
    bz[stock_idx] = norm2d(biz_raw)
    bz[stock_idx] = align_to(bz, ref, stock_idx)[stock_idx]
    s = np.nanmax(np.abs(np.vstack([st[p]["beh"] for p in FACTOR_COLS] + [bz])))
    for p in FACTOR_COLS:
        st[p]["beh"] /= s
    bz /= s
    moved = {p: float(np.nanmedian(np.linalg.norm(st[p]["beh"] - st["mkt"]["beh"], axis=1))) for p in FACTOR_COLS if p != "mkt"}
    log(f"layouts aligned to Market; median shift: " + ", ".join(f"{p} {v:.3f}" for p, v in moved.items()))

    overrides = json.loads(LABELS_FILE.read_text()) if LABELS_FILE.exists() else []
    rules, theme_over = load_themes()

    def clusters_for(Y):
        has = np.where(~np.isnan(Y[:, 0]))[0]
        lab = np.full(N, -1)
        lab[has] = hdbscan_labels(Y[has])
        lab[has], merged = merge_adjacent(lab[has], Y[has], [sectors[i] for i in has])
        return {"ids": [int(v) for v in lab], "labels": label_clusters(lab[has], Y[has], [assets[i] for i in has], meta, overrides)}, merged
    biz_clusters, biz_merged = clusters_for(bz)

    # ---- pass 2: clusters, neighbours, lists, exports
    out_presets, report = {}, {}
    si, sj = np.triu_indices(N, 1)
    cik = np.array([meta[t]["cik"] or -(k + 1) for k, t in enumerate(assets)])
    distinct = cik[si] != cik[sj]            # GOOG/GOOGL, FOX/FOXA, NWS/NWSA are one company
    for p in FACTOR_COLS:
        d = st[p]
        inp, C, K, Nw, CL, C60, beh = d["inp"], d["C"], d["K"], d["Nw"], d["CL"], d["C60"], d["beh"]
        beh_clusters, merged = clusters_for(beh)
        for m in merged + (biz_merged if p == "mkt" else []):
            log(f"  merged adjacent {m[0]} clusters {m[1]}+{m[2]} (gap {m[3]})")

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
            row = C[i].copy()
            row[i] = np.nan
            nb = topk(row, 5, st_in if is_stock[i] else all_in)
            nn_beh.append([[assets[j], r3(C[i, j]), int(K[i, j]), int(Nw[i, j])] for j in nb])
            if is_stock[i]:
                rs = S[i].copy()
                rs[i] = np.nan
                overlap.append(round(len(set(topk(row, K_OVERLAP, st_in)) & set(topk(rs, K_OVERLAP, stock_idx))) / K_OVERLAP, 1))
            else:
                overlap.append(None)

        # Hidden twins / Lookalikes: stock pairs, stable across calendar years
        pc, ps, pp = C[si, sj], S[si, sj], P[si, sj]
        kk, nn = K[si, sj], Nw[si, sj]
        cand = np.where(is_stock[si] & is_stock[sj] & inp[si] & inp[sj] & distinct)[0]
        stable = stable_pair(kk, nn, n_years)
        hc = cand[(pc[cand] > np.quantile(pc[cand], TOP_Q)) & stable[cand]]
        hidden = hc[np.argsort(ps[hc])[:N_LIST]]
        hs = cand[(ps[cand] > np.quantile(ps[cand], TOP_Q)) & stable[cand]]
        apart = hs[np.argsort(pc[hs])[:N_LIST]]

        def pair(q):
            a, b = assets[si[q]], assets[sj[q]]
            return {"a": a, "b": b, "corr": r3(pc[q]), "simPct": round(float(pp[q]), 1), "k": int(kk[q]), "n": int(nn[q]),
                    "theme": pair_theme(a, b, meta, rules, theme_over)}

        # Decoupling: strong, durable pairs only; one-sided Fisher z on the last 60 days; BH at q = 0.05
        tested = np.where(inp[si] & inp[sj] & ~is_etf[si] & ~is_etf[sj] & distinct & (CL[si, sj] >= DECOUPLE_MIN_LR)
                          & (kk >= math.ceil(DECOUPLE_HELD * n_years)))[0]
        z = fisher_z(C60[si[tested], sj[tested]], CL[si[tested], sj[tested]])
        pval = norm.cdf(z)                       # lower tail: the recent correlation fell
        rej, adj = bh_reject(pval)
        passing = tested[rej][np.argsort(z[rej])]
        zq = {int(q): (float(zz), float(aa)) for q, zz, aa in zip(tested, z, adj)}
        log(f"  decoupling [{PRESET_LABEL[p]}]: {len(tested)} pairs tested, {int(rej.sum())} pass BH at q = {FDR_Q}")

        out_presets[p] = {
            "beh": [None if np.isnan(v[0]) else [r3(v[0]), r3(v[1])] for v in beh],
            "biz": [None if np.isnan(v[0]) else [r3(v[0]), r3(v[1])] for v in bz],
            "overlap": overlap,
            "exposure": [None if not inp[i] else [round(float(x), 2) for x in d["B2"][:, i]] for i in range(N)],
            "sdRes": [sig5(d["sdres"][i]) if inp[i] else None for i in range(N)],
            "nnBeh": nn_beh,
            "clusters": {"beh": beh_clusters, "biz": biz_clusters},
            "hidden": [pair(q) for q in hidden],
            "apart": [pair(q) for q in apart],
            "decoupleTested": int(len(tested)),
            "decouple": [{"a": assets[si[q]], "b": assets[sj[q]], "longRun": r3(CL[si[q], sj[q]]),
                          "recent": r3(C60[si[q], sj[q]]), "k": int(kk[q]), "n": int(nn[q]),
                          "z": round(zq[int(q)][0], 2), "q": float(f"{zq[int(q)][1]:.2g}")} for q in passing[:N_LIST]],
        }
        report[p] = out_presets[p]

        d["E2"].T.astype(np.float32).tofile(OUT_BIN / f"series_resid_{p}.f32")
        with open(OUT_BIN / f"matrix_{p}.bin", "wb") as f:
            q16(upper(C)).tofile(f)
            q16(upper(CL)).tofile(f)
            upper(K).astype(np.uint8).tofile(f)
            upper(Nw).astype(np.uint8).tofile(f)

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
        "version": 2.1,
        "asof": str(cal[-1].date()),
        "start": str(lr.index[0].date()),
        "mapStart": str(win.index[0].date()),
        "dates": [str(d.date()) for d in win.index],
        "years": years,
        "textSource": "edgar" if len(failed) < len(stocks) else "yahoo",
        "textFallback": fallback if len(failed) < len(stocks) else [],
        "presets": [{"id": p, "label": PRESET_LABEL[p], "factors": FACTOR_INSTRUMENTS[p], "exposures": EXPOSURE_NAMES[p],
                     "notPlotted": [t for t in FACTOR_INSTRUMENTS[p] if t != "SPY"]} for p in FACTOR_COLS],
        "assets": [{"t": t, "name": meta[t]["name"], "cls": meta[t]["cls"], "sector": meta[t]["sector"], "sub": meta[t]["sub"],
                    "mcap": round(mcap[t] / 1e9, 1) if t in mcap and np.isfinite(mcap[t]) else None,
                    "vol": round(float(ann_vol[t]), 3) if np.isfinite(ann_vol[t]) else None,
                    "adv": round(float(adv[t]) / 1e6, 1) if np.isfinite(adv[t]) else None,
                    "beta": round(float(beta_mkt[ix[t]]), 2),
                    "sd": sig5(sd2[ix[t]]), "sd1y": sig5(sd1[ix[t]]),
                    "text": text_src.get(t)} for t in assets],
        "nnBiz": nn_biz,
        "data": out_presets,
    }
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(doc, separators=(",", ":"), allow_nan=False))
    log(f"wrote {OUT_JSON.relative_to(ROOT)} ({OUT_JSON.stat().st_size / 1024:.0f} KB) and "
        f"{len(list(OUT_BIN.iterdir()))} binaries in {OUT_BIN.relative_to(ROOT)} (N={N})")

    # ---- report
    log("\nTOP 10 HIDDEN TWINS BY PRESET (stable pairs only)")
    for p, P_ in report.items():
        log(f"  [{PRESET_LABEL[p]}]  ({len(P_['hidden'])} pairs pass the stability rule)")
        for r in P_["hidden"][:10]:
            log(f"    {r['a']:>6} {r['b']:<6} {r['corr']:.2f}  held {r['k']}/{r['n']}  [{r['theme']}]  "
                f"({meta[r['a']]['sub']} / {meta[r['b']]['sub']})")
    log("\nDECOUPLING (Fisher z, one-sided, BH q = 0.05)")
    for p, P_ in report.items():
        log(f"  [{PRESET_LABEL[p]}] tested {P_['decoupleTested']}, passed {len(P_['decouple'])}")
        for r in P_["decouple"][:10]:
            log(f"    {r['a']:>6} {r['b']:<6} long-run {r['longRun']:.2f} -> 60d {r['recent']:.2f}  z {r['z']}  q {r['q']}")

    test = {"NVDA": 20, "MSFT": 15, "AVGO": 10, "JPM": 10, "BAC": 5, "XOM": 10, "DUK": 10, "NEE": 10, "O": 10}
    ti = [ix[t] for t in test]
    w = np.array(list(test.values()), float)
    w /= w.sum()
    Sig = C_raw[np.ix_(ti, ti)] * np.outer(sd2[ti], sd2[ti])
    log("\nTEST PORTFOLIO " + ", ".join(f"{t} {v}" for t, v in test.items()))
    log(f"  old (v2.0 headline: residual corr, Market): {neff(st['mkt']['C'][np.ix_(ti, ti)], w):.2f}")
    log(f"  old method on total-return corr:            {neff(C_raw[np.ix_(ti, ti)], w):.2f}")
    log(f"  new (v2.1 headline: total-return covariance): {neff_cov(Sig, w):.2f}")
    for p in FACTOR_COLS:
        Cp = st[p]["C"][np.ix_(ti, ti)]
        Sr = Cp * np.outer(st[p]["sdres"][ti], st[p]["sdres"][ti])
        log(f"  new, after removing {PRESET_LABEL[p]}: {neff_cov(Sr, w):.2f}")
    rc = risk_contrib(Sig, w)
    ids = report["mkt"]["clusters"]["beh"]["ids"]
    names = {c["id"]: c["label"] for c in report["mkt"]["clusters"]["beh"]["labels"]}
    groups: dict[str, list] = {}
    for k_, t in enumerate(test):
        g = names.get(ids[ix[t]], "Not in a cluster")
        groups.setdefault(g, [0.0, 0.0, []])
        groups[g][0] += w[k_]
        groups[g][1] += rc[k_]
        groups[g][2].append(t)
    log(f"  vol {np.sqrt(w @ Sig @ w * YEAR_DAYS):.1%}  beta {sum(w[k_] * beta_mkt[ix[t]] for k_, t in enumerate(test)):.2f}")
    for g, (cap, risk, mem) in sorted(groups.items(), key=lambda kv: -kv[1][1]):
        flag = "  <- risk > capital by 10+ pts" if risk - cap >= 0.10 else ""
        log(f"    {g:<34} capital {cap:5.1%}  risk {risk:5.1%}  {', '.join(mem)}{flag}")

    k = ix["KKR"]
    beta2 = C_raw[k] * sd2[k] / sd2
    beta1 = C_raw1[k] * sd1[k] / sd1
    liquid = np.array([a is not None and a >= 20 for a in (round(float(adv[t]) / 1e6, 1) if np.isfinite(adv[t]) else None for t in assets)])
    order = [j for j in np.argsort(-(C_raw[k] ** 2)) if j != k and liquid[j]][:5]
    log("\nKKR TOP 5 HEDGES (total returns, 2y)")
    for j in order:
        unstable = np.sign(beta1[j]) != np.sign(beta2[j]) or abs(beta1[j] - beta2[j]) > 0.5 * abs(beta2[j])
        verb = "Short" if beta2[j] > 0 else "Buy"
        log(f"    {verb} {abs(beta2[j]):.2f}x {assets[j]:<6} variance -{C_raw[k, j] ** 2:.0%}  1y beta {beta1[j]:.2f}"
            f"  {'UNSTABLE' if unstable else 'stable'}")
    log(f"\nbusiness text fallback to Yahoo: {len(failed)} of {len(stocks)} tickers")
    log(f"done in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    sys.exit(main())
