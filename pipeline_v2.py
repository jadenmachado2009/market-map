#!/usr/bin/env python3
"""Market Map Pro (v2.4.1) data pipeline.

Builds everything the /pro route needs: three factor presets (market; + rates & defensives;
+ size & value), winsorised residual correlations, yearly stability counts, stable pair lists
with theme tags, a Fisher-z / Benjamini-Hochberg decoupling list plus a watchlist of the pairs
closest to breaking, business-text similarity
(SEC 10-K Item 1 when SEC_USER_AGENT is set, Yahoo summaries otherwise), a cross-asset universe,
HDBSCAN clusters (noise points assigned to their neighbours' majority cluster), covariance inputs for the portfolio X-ray and hedge finder, and compact
lazy-loaded binaries. Share classes of one company (same CIK) are one ticker. Text is cached across
runs: a 10-K is downloaded once per accession number, Yahoo summaries are refreshed every 30 days.

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
import zlib
from collections import Counter, defaultdict
from datetime import date, timedelta
from io import StringIO
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / "pro_cache"
OUT_JSON = ROOT / "web" / "src" / "data-pro" / "market_map_v2.json"
OUT_BIN = ROOT / "web" / "public" / "pro-data"
LABELS_FILE = ROOT / "cluster_labels_v2.json"
THEMES_FILE = ROOT / "pair_themes_v2.json"
CIK_OVERRIDES_FILE = ROOT / "cik_overrides_v2.json"      # checked before Wikipedia's ticker -> CIK column
EXTRACTORS_FILE = ROOT / "item1_extractors_v2.json"      # per-ticker Item 1 extractors and the relaxed-rule list

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
NOISE_K = 5             # HDBSCAN noise points join the majority cluster of their 5 nearest clustered neighbours
YAHOO_TTL_DAYS = 30     # a cached Yahoo summary is re-fetched once it is this many days old
N_WATCH = 25            # decoupling watchlist exported per preset (the page shows the top 5 within filters)

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
    "etf": ["XLB", "XLC", "XLE", "XLF", "XLI", "XLK", "XLP", "XLRE", "XLU", "XLV", "XLY", "SPY", "QQQ", "IWM", "EFA", "EEM",
            "USMV", "IWD", "IWF"],   # SPY/USMV/IWD/IWF are factors too: listed so they can be hedges (never plotted as their own factor)
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
    "SPY": "SPDR S&P 500", "USMV": "iShares MSCI USA Min Vol Factor", "IWD": "iShares Russell 1000 Value",
    "IWF": "iShares Russell 1000 Growth", "QQQ": "Invesco QQQ (Nasdaq-100)", "IWM": "iShares Russell 2000", "EFA": "iShares MSCI EAFE",
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

def load_cik_overrides(path: Path = CIK_OVERRIDES_FILE) -> dict[str, int]:
    """{ticker: CIK} from cik_overrides_v2.json; keys starting with '_' are comments."""
    if not path.exists():
        return {}
    return {t: int(str(v)) for t, v in json.loads(path.read_text()).items() if not t.startswith("_")}


def load_universe():
    import pandas as pd
    import requests

    html = requests.get("https://en.wikipedia.org/wiki/List_of_S%26P_500_companies",
                        headers={"User-Agent": "Mozilla/5.0"}, timeout=30).text
    t = pd.read_html(StringIO(html))[0]
    t["Symbol"] = t["Symbol"].str.replace(".", "-", regex=False)
    t = t.set_index("Symbol")
    overrides = load_cik_overrides()
    meta = {}
    for sym, row in t.iterrows():
        wiki = int(row["CIK"]) if not pd.isna(row["CIK"]) else None
        meta[sym] = {"name": row["Security"], "cls": "stock", "sector": row["GICS Sector"],
                     "sub": row["GICS Sub-Industry"], "cik": overrides.get(sym, wiki)}
        if sym in overrides and overrides[sym] != wiki:
            log(f"CIK override: {sym} {wiki} (Wikipedia) -> {overrides[sym]}")
    for cls, ticks in CROSS.items():
        for sym in ticks:
            meta[sym] = {"name": CROSS_NAMES[sym], "cls": cls, "sector": CLASS_LABEL[cls], "sub": CLASS_LABEL[cls], "cik": None}
    return meta



def collapse_share_classes(tickers: list[str], meta: dict, dollar_vol) -> tuple[list[str], dict[str, list[str]]]:
    """One ticker per company. Stocks that share a CIK (GOOG/GOOGL, FOX/FOXA, NWS/NWSA) are share classes of
    one company: the class with the higher average dollar volume stays and the others leave the universe as
    its 'aka' (search, deep links and portfolios map them to it), so no list, twin or hedge can pair two
    classes of one company. Ties go to the alphabetically first ticker. Returns (tickers, aka)."""
    by_cik: dict[int, list[str]] = defaultdict(list)
    for t in tickers:
        if meta[t]["cls"] == "stock" and meta[t].get("cik"):
            by_cik[meta[t]["cik"]].append(t)
    aka: dict[str, list[str]] = {}
    for group in by_cik.values():
        if len(group) > 1:
            dv = {t: float(np.nan_to_num(dollar_vol.get(t, 0.0))) for t in group}
            keep = max(sorted(group), key=dv.get)
            aka[keep] = sorted(t for t in group if t != keep)
    folded = {t for ts in aka.values() for t in ts}
    return [t for t in tickers if t not in folded], aka

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


# Section headings must start a line: inline cross-references ("see Item 1. Business") are what the
# v2.1 longest-span rule latched onto. Covers "Item 1. Business", "PART I, ITEM 1 — BUSINESS" and
# "Items 1 and 2. Business and Properties" (most oil & gas filers).
ITEM1 = re.compile(r"^[^\S\n]*(?:part\s+i\b[\s,.\-–—]*)?items?\s*1\s*(?:(?:and|&|,)\s*2\s*)?[\.:\-–—]?\s*"
                   r"(?:description\s+of\s+(?:the\s+)?)?business\b(?:\s*(?:and|&)\s*properties\b)?", re.I | re.M)
# ...and it ends at the next Part I heading: 1A, 1B, 1C, 2 Properties or 3 Legal Proceedings
ITEM_END = re.compile(r"^[^\S\n]*item\s*(?:1a|1b|1c|2|3)\s*[\.:\-–—]?\s*"
                      r"(?:risk\s*factors|unresolved|cybersecurity|properties|legal\s+proceedings)", re.I | re.M)
# Sub-sections that read alike across unrelated companies (regulation made KKR "read like" a bank)
BOILER_HEAD = re.compile(r"^(?:(?:government(?:al)?|supervision\s+and)\s+)?regulation\b|^regulatory\b|^human\s+capital"
                         r"|^(?:our\s+)?employees\b|^environmental\b|^available\s+information|^where\s+you\s+can\s+find"
                         r"|^(?:information\s+about\s+(?:our\s+)?)?executive\s+officers", re.I)
ITEM1_MIN_WORDS = 300
TEXT_GATE_SECTOR = 0.04   # 10-K text is dropped for Yahoo if its top-5 neighbours share a sector this much less often
TEXT_GATE_SUBPCT = 3.0    # ... or same-sub-industry pairs score this many percentile points lower
TEXT_PROBES = [("ADM", "BG"), ("AMGN", "BMY"), ("CVX", "XOM"), ("COF", "SYF"), ("KO", "PEP"), ("V", "MA"),
               ("HD", "LOW"), ("KKR", "BX"), ("KKR", "TFC"), ("UNH", "ELV")]


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


def _trim_section(span: str, max_words: int) -> str:
    """Stop at the first boilerplate sub-heading once ITEM1_MIN_WORDS are in, then cap at max_words."""
    kept, n = [], 0
    for line in span.splitlines():
        head = line.strip()
        if n >= ITEM1_MIN_WORDS and 0 < len(head.split()) <= 8 and BOILER_HEAD.match(head):
            break
        kept.append(line)
        n += len(line.split())
    return " ".join(" ".join(kept).split()[:max_words])


# Relaxed rule (named tickers only). A heading may follow other text on its line (a running page header,
# "Part I."), may use "|" as its separator ("ITEM 1 | Business", AIG), and the same goes for the end
# heading ("Part I. Item 1A. Risk Factors", EXPE) - but it must END its line, so an inline
# cross-reference ("see Item 1. Business - Regulation for ...") can't start or end a section.
ITEM1_RELAXED = re.compile(r"(?:^|[^\S\n])(?:part\s+i\b[\s,.\-–—|]*)?items?\s*1\s*(?:(?:and|&|,)\s*2\s*)?[\.:\-–—|]?\s*"
                           r"(?:description\s+of\s+(?:the\s+)?)?business\b(?:\s*(?:and|&)\s*properties\b)?[^\S\n]*$",
                           re.I | re.M)
ITEM_END_RELAXED = re.compile(r"(?:^|[^\S\n])(?:part\s+i\b[\s,.\-–—|]*)?item\s*(?:1a|1b|1c|2|3)\s*[\.:\-–—|]?\s*"
                              r"(?:risk\s*factors|unresolved[^\n]*|cybersecurity|properties|legal\s+proceedings)[^\S\n]*$",
                              re.I | re.M)


def extract_item1(text: str, max_words: int = ITEM1_WORDS, relaxed: bool = False) -> str | None:
    """Item 1 (Business) of a 10-K's plain text. Takes the FIRST line-start 'Item 1. Business' heading
    whose section (up to the next line-start Item 1A/1B/1C/2/3 heading) has 300+ words, so the table of
    contents (a few words) is skipped and cross-references can't start a span. Stops at the first
    boilerplate sub-heading (regulation, human capital, executive officers...) once 300 words are in,
    then caps at max_words. None if no section qualifies. relaxed=True (named tickers only) uses
    ITEM1_RELAXED / ITEM_END_RELAXED: headings after other text on the line, "|" separators, "Part I."
    prefixes, as long as the heading ends its line."""
    ends = [m.start() for m in (ITEM_END_RELAXED if relaxed else ITEM_END).finditer(text)]
    for m in (ITEM1_RELAXED if relaxed else ITEM1).finditer(text):
        nxt = [e for e in ends if e > m.end()]
        span = text[m.end():nxt[0]] if nxt else ""
        if len(span.split()) >= ITEM1_MIN_WORDS:
            return _trim_section(span, max_words)
    return None


def extract_by_headings(text: str, starts: list[str], ends: list[str], max_words: int = ITEM1_WORDS) -> str | None:
    """Custom extractor for filers whose 10-K has no usable 'Item 1. Business' heading (annual-report
    style filings). A start or end heading is a line whose whole stripped text matches one of the
    patterns (case-insensitive). Takes the first start whose section has 300+ words."""
    sp = [re.compile(x, re.I) for x in starts]
    ep = [re.compile(x, re.I) for x in ends]
    lines = text.splitlines()
    heads = [ln.strip() for ln in lines]
    s_idx = [k for k, h in enumerate(heads) if h and any(r.fullmatch(h) for r in sp)]
    e_idx = [k for k, h in enumerate(heads) if h and any(r.fullmatch(h) for r in ep)]
    for k in s_idx:
        e = next((x for x in e_idx if x > k), None)
        if e is None:
            continue
        span = "\n".join(lines[k + 1:e])
        if len(span.split()) >= ITEM1_MIN_WORDS:
            return _trim_section(span, max_words)
    return None


HEADING_HINT = re.compile(r"\bitem\s*\d|\bpart\s+i|business|overview|risk\s+factors|management.s\s+discussion|segment"
                          r"|our\s+compan|about\s|introduction|general|products|cross.?reference", re.I)


def heading_dump(text: str, limit: int = 160) -> list[str]:
    """Heading-like lines of a filing (short lines naming items, parts or business sections) with their
    word offset, for writing custom extractors from CI logs."""
    out, words = [], 0
    for line in text.splitlines():
        h = " ".join(line.split())
        n = len(h.split())
        if 0 < n <= 12 and (HEADING_HINT.search(h) or (h.isupper() and len(h) > 3)):
            out.append(f"@{words:>6}w  {h[:110]}")
            if len(out) >= limit:
                break
        words += n
    return out


def load_extractors(path: Path = EXTRACTORS_FILE) -> dict:
    """{'custom': {ticker: {'start': [...], 'end': [...], 'why': str}}, 'relaxed': set of tickers}"""
    cfg = json.loads(path.read_text()) if path.exists() else {}
    return {"custom": {t: v for t, v in cfg.get("custom", {}).items() if not t.startswith("_")},
            "relaxed": set(cfg.get("relaxed", []))}


def latest_10k(http, cik: int, trace: list | None = None) -> tuple[str, str] | None:
    """(accession number, primary document) of the newest 10-K. The 'recent' block lists only the last
    ~1,000 filings, which for heavy filers no longer reaches the 10-K, so older pages are read too.
    `trace` collects every URL with its HTTP status and what came back (entity name, forms seen)."""
    def find(block):
        for i, form in enumerate(block.get("form", [])):
            if form in ("10-K", "10-KT"):
                return block["accessionNumber"][i], block["primaryDocument"][i]
        return None

    def fetch(url):
        try:
            r = http.get(url)
        except Exception as e:  # noqa: BLE001
            resp = getattr(e, "response", None)
            if trace is not None:
                trace.append(f"{url} -> {getattr(resp, 'status_code', type(e).__name__)}")
            raise
        d = r.json()
        if trace is not None:
            forms = d.get("filings", {}).get("recent", d).get("form", [])
            trace.append(f"{url} -> HTTP {getattr(r, 'status_code', 200)}; entity {d.get('name', '?')!r}; "
                         f"{len(forms)} filings, forms seen: {', '.join(sorted(set(forms))[:12])}")
        return d

    sub = fetch(f"https://data.sec.gov/submissions/CIK{cik:010d}.json")
    hit = find(sub["filings"]["recent"])
    for page in sub["filings"].get("files", []):
        if hit:
            break
        hit = find(fetch(f"https://data.sec.gov/submissions/{page['name']}"))
    return hit


def edgar_texts(meta: dict, stocks: list[str], ua: str, extractors: dict | None = None, debug: set | None = None):
    """Item 1 of each company's latest 10-K. A filing is downloaded once: its whole plain text is cached per
    accession number (extractor fixes re-run on the cache), so a run only asks EDGAR whether a newer 10-K
    exists, and a superseded filing's file is deleted when the new one arrives. edgar/index.json records the
    filing each company last used: if the lookup fails, that filing is reused instead of dropping the company
    to Yahoo for a night. Custom extractors replace the standard rule for their tickers; 'relaxed' tickers
    try the standard rule, then the relaxed one.
    Returns (texts, failed, reason, mode, dumps, traces, stats): mode is how each text was extracted; dumps
    hold heading lines for `debug` tickers; traces hold URL/HTTP lines for every lookup that failed; stats
    counts filings reused from the cache and names those downloaded (new 10-Ks) or reused after a failed lookup."""
    extractors = extractors or {"custom": {}, "relaxed": set()}
    debug = debug or set()
    d = CACHE / "edgar"
    d.mkdir(parents=True, exist_ok=True)
    for old in d.glob("*.txt.gz"):           # v2.1 caches held only the (often wrong) extracted span
        if not old.name.endswith(".full.txt.gz"):
            old.unlink()
    idx_path = d / "index.json"
    index = json.loads(idx_path.read_text()) if idx_path.exists() else {}
    http = Polite(ua)
    out, fails, why, mode, dumps, traces = {}, [], {}, {}, {}, {}
    stats = {"reused": 0, "downloaded": [], "lookupFallback": []}
    for n, t in enumerate(stocks, 1):
        cik, trace = meta[t]["cik"], []
        try:
            hit = None
            if cik:
                try:
                    hit = latest_10k(http, cik, trace)
                except Exception:  # noqa: BLE001
                    prev = index.get(str(cik))
                    if not prev or not (d / f"{cik}_{prev['acc']}.full.txt.gz").exists():
                        raise
                    hit = (prev["acc"], prev["doc"])
                    stats["lookupFallback"].append(t)
            if not hit:
                why[t] = "no 10-K on EDGAR" if cik else "no CIK"
                traces[t] = trace
            else:
                acc, doc = hit
                url = f"https://www.sec.gov/Archives/edgar/data/{cik}/{acc.replace('-', '')}/{doc}"
                f = d / f"{cik}_{acc}.full.txt.gz"
                if f.exists():
                    text = gzip.decompress(f.read_bytes()).decode()
                    stats["reused"] += 1
                else:
                    trace.append(url)
                    text = html_to_text(http.get(url).content)
                    f.write_bytes(gzip.compress(text.encode()))
                    stats["downloaded"].append(t)
                    for old in d.glob(f"{cik}_*.full.txt.gz"):     # the 10-K this one supersedes
                        if old != f:
                            old.unlink()
                index[str(cik)] = {"acc": acc, "doc": doc, "ticker": t}
                if t in extractors["custom"]:
                    c = extractors["custom"][t]
                    item1, how = extract_by_headings(text, c["start"], c["end"]), "custom"
                else:
                    item1, how = extract_item1(text), "standard"
                    if not item1 and t in extractors["relaxed"]:
                        item1, how = extract_item1(text, relaxed=True), "relaxed"
                if item1:
                    out[t], mode[t] = item1, how
                else:
                    why[t] = {"custom": "custom extractor found no 300+ word section",
                              "relaxed": "no Item 1 section even with the relaxed rule"}.get(how, "no Item 1 heading with 300+ words")
                if t in debug:
                    dumps[t] = [f"{url}  ({len(text.split())} words)"] + heading_dump(text)
        except Exception as e:  # noqa: BLE001
            resp = getattr(e, "response", None)
            why[t] = f"{type(e).__name__}" + (f" HTTP {resp.status_code}" if resp is not None else "")
            traces[t] = trace
        if t in why:
            fails.append(t)
        if n % 100 == 0:
            log(f"  EDGAR {n}/{len(stocks)}")
    idx_path.write_text(json.dumps(index, sort_keys=True, indent=0))
    return out, fails, why, mode, dumps, traces, stats


def text_quality(emb: np.ndarray, subs: list[str], sectors: list[str], k: int = 5) -> dict[str, float]:
    """Sanity check for business embeddings: how often a stock's k nearest texts share its GICS
    sub-industry / sector, and the median similarity percentile of same-sub-industry pairs."""
    from scipy.stats import rankdata

    S = emb @ emb.T
    np.fill_diagonal(S, -np.inf)
    nb = np.argsort(-S, axis=1)[:, :k]
    subs_a, secs_a = np.array(subs), np.array(sectors)
    iu = np.triu_indices(len(subs), 1)
    pct = rankdata(S[iu]) / len(iu[0]) * 100
    same = subs_a[iu[0]] == subs_a[iu[1]]
    return {"sub": round(float((subs_a[nb] == subs_a[:, None]).mean()), 3),
            "sector": round(float((secs_a[nb] == secs_a[:, None]).mean()), 3),
            "sameSubPct": round(float(np.median(pct[same])), 1) if same.any() else float("nan")}


TICKER_GATE_SECTOR = 0.2   # per ticker the sector share moves in steps of 1/5: allow one neighbour


def ticker_quality(E: np.ndarray, i: int, subs: list[str], sectors: list[str], tri_sorted: np.ndarray, k: int = 5) -> dict:
    """The gate's checks for one stock: share of its k nearest texts in its sub-industry / sector, and the
    median similarity percentile (among all pairs, tri_sorted) of its same-sub-industry peers (sector
    peers if it has none)."""
    s = E @ E[i]
    s[i] = -np.inf
    nb = np.argsort(-s)[:k]
    peers = [j for j in range(len(subs)) if j != i and subs[j] == subs[i]] or \
            [j for j in range(len(subs)) if j != i and sectors[j] == sectors[i]]
    pct = np.searchsorted(tri_sorted, s[peers]) / len(tri_sorted) * 100 if peers else np.array([np.nan])
    return {"sub": round(float(np.mean([subs[j] == subs[i] for j in nb])), 2),
            "sector": round(float(np.mean([sectors[j] == sectors[i] for j in nb])), 2),
            "sameSubPct": round(float(np.median(pct)), 1)}


def ticker_gate(q_edgar: dict, q_yahoo: dict) -> bool:
    """Per-ticker version of text_gate for custom and relaxed extractions: its 10-K text may not make it
    clearly worse than its own Yahoo summary (one neighbour of sector slack; same 3-point median rule)."""
    eps = 1e-9                                  # 0.6 >= 0.8 - 0.2 is False in floating point
    return (q_edgar["sector"] >= q_yahoo["sector"] - TICKER_GATE_SECTOR - eps
            and q_edgar["sameSubPct"] >= q_yahoo["sameSubPct"] - TEXT_GATE_SUBPCT - eps)


def same_source(src: np.ndarray, si: np.ndarray, sj: np.ndarray) -> np.ndarray:
    """True for pairs whose business texts come from the same source: a 10-K vs Yahoo pair reads
    artificially unlike, so it can't be a Lookalike or a Hidden twin."""
    return src[si] == src[sj]


READS_LIKE_MIN_POOL = 100  # "Reads like" ranks a stock only if this many other stocks share its text source


def reads_like(S: np.ndarray, P: np.ndarray, is_stock: np.ndarray, src: np.ndarray, assets: list,
               min_pool: int = READS_LIKE_MIN_POOL, k: int = 5) -> list:
    """Top-k business-text neighbours of each stock, compared only with stocks of the same text source
    (10-K with 10-K, Yahoo with Yahoo). [] ("Not enough comparable text") when fewer than min_pool other
    stocks share the source: with 100+ the 5 shown are the top 5% of candidates or better. Yahoo fallback
    stocks number about a dozen, and Yahoo-vs-Yahoo similarity is inflated by the shared summary style
    (different-sector pairs: median 73rd pctl vs 45th for 10-K pairs), so their "top 5" was noise
    (VLO read like a packager, a copper miner and a utility); since v2.4 reads_like_yahoo gives them a
    full Yahoo pool instead. None for non-stocks."""
    out = []
    for i in range(len(assets)):
        if not is_stock[i]:
            out.append(None)
            continue
        peers = is_stock & (src == src[i])
        peers[i] = False
        if peers.sum() < max(min_pool, k):
            out.append([])
            continue
        row = np.where(peers, S[i], -np.inf)
        out.append([[assets[j], round(float(P[i, j]), 1)] for j in np.argsort(-row)[:k]])
    return out


def reads_like_yahoo(E_y: np.ndarray, have_y: np.ndarray, targets: list, names: list,
                     min_pool: int = READS_LIKE_MIN_POOL, k: int = 5) -> dict:
    """"Reads like" for stocks on Yahoo fallback text, on Yahoo summaries alone: each target's summary
    vs the Yahoo summary of every other stock that has one (10-K stocks included), so both sides are
    the same source and the pool is the whole index, not the dozen other fallbacks. Percentiles are
    among Yahoo-vs-Yahoo pairs of that pool (the Yahoo scale, not the 10-K one). E_y rows, have_y and
    names are in stock order; targets are row indices. Returns {name: [[ticker, pctl], ...]}, [] when the
    pool is under min_pool or the target has no Yahoo summary."""
    pool = np.where(have_y)[0]
    pos = {int(g): r for r, g in enumerate(pool)}
    Sy = E_y[pool] @ E_y[pool].T
    ref = np.sort(Sy[np.triu_indices(len(pool), 1)])
    out = {}
    for i in targets:
        if int(i) not in pos or len(pool) - 1 < max(min_pool, k):
            out[names[i]] = []
            continue
        r = pos[int(i)]
        row = Sy[r].copy()
        row[r] = -np.inf
        out[names[i]] = [[names[pool[j]], round(float(np.searchsorted(ref, row[j], side="right") / len(ref) * 100), 1)]
                         for j in np.argsort(-row)[:k]]
    return out


def text_gate(q_edgar: dict, q_yahoo: dict) -> bool:
    """True if the 10-K embeddings are fit to use: not clearly worse than Yahoo's on either check."""
    eps = 1e-9
    return (q_edgar["sector"] >= q_yahoo["sector"] - TEXT_GATE_SECTOR - eps
            and q_edgar["sameSubPct"] >= q_yahoo["sameSubPct"] - TEXT_GATE_SUBPCT - eps)


def yahoo_entry(t: str, v, today: date, ttl: int = YAHOO_TTL_DAYS):
    """A cache entry {'text', 'fetched'}. Caches before v2.4.1 held bare strings with no date: each gets a
    fixed per-ticker age of 0..ttl-1 days, so refreshes spread across the month instead of one night."""
    if v is None or isinstance(v, dict):
        return v
    return {"text": v, "fetched": (today - timedelta(days=zlib.crc32(t.encode()) % ttl)).isoformat()}


def yahoo_due(entry, today: date, ttl: int = YAHOO_TTL_DAYS) -> bool:
    """Missing or failed entries are fetched every run; good ones once they are `ttl` days old."""
    return entry is None or entry.get("text") is None or (today - date.fromisoformat(entry["fetched"])).days >= ttl


def yahoo_texts(stocks: list[str], today: date | None = None, fetch=None, path: Path | None = None,
                seed: Path | None = ROOT / "desc_cache.json") -> tuple[dict[str, str], dict]:
    """Yahoo longBusinessSummary per stock, cached in pro_cache/yahoo_desc.json and re-fetched every
    YAHOO_TTL_DAYS days. A failed or empty refresh keeps the cached summary and retries next run (an empty
    answer for a company that had a summary is a Yahoo hiccup, not news). Returns ({ticker: summary}, stats)."""
    today = today or date.today()
    path = path or CACHE / "yahoo_desc.json"
    if fetch is None:
        import yfinance as yf

        def fetch(t):
            time.sleep(0.25)
            return yf.Ticker(t).info.get("longBusinessSummary") or ""
    desc = {t: yahoo_entry(t, v, today) for t, v in (json.loads(path.read_text()) if path.exists() else {}).items()}
    if seed is not None and seed.exists():  # v1 notebook cache, if present locally
        for t, v in json.loads(seed.read_text()).items():
            if desc.get(t) is None:
                desc[t] = yahoo_entry(t, v, today)
    stats = {"fetched": 0, "new": [], "changed": [], "failed": []}
    for t in [t for t in stocks if yahoo_due(desc.get(t), today)]:
        old = (desc.get(t) or {}).get("text")
        try:
            new = fetch(t)
        except Exception:  # noqa: BLE001
            new = None
        if new is None or (not new and old):
            stats["failed"].append(t)
            continue
        stats["fetched"] += 1
        if old is None:
            stats["new"].append(t)
        elif new != old:
            stats["changed"].append(t)
        desc[t] = {"text": new, "fetched": today.isoformat()}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({t: v for t, v in sorted(desc.items()) if v is not None and v.get("text") is not None}))
    return {t: desc[t]["text"] for t in stocks if desc.get(t) and desc[t].get("text")}, stats


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


def embed_raw(texts: list[str], words: int = 200, max_chunks: int = 20) -> np.ndarray:
    """Mean of chunk embeddings per text (long Item 1 sections aren't cut at 256 tokens). Uncentred, so
    rows from different runs can be mixed before finish_embedding."""
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
    return np.vstack([E[owner == i].mean(0) for i in range(len(texts))])


def finish_embedding(R: np.ndarray) -> np.ndarray:
    """Remove the average description, then unit length."""
    out = R - R.mean(0)
    return out / np.linalg.norm(out, axis=1, keepdims=True)


def embed(texts: list[str], words: int = 200, max_chunks: int = 20) -> np.ndarray:
    return finish_embedding(embed_raw(texts, words, max_chunks))


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


def assign_noise(ids: np.ndarray, Y: np.ndarray, k: int = NOISE_K) -> tuple[np.ndarray, np.ndarray]:
    """Give every HDBSCAN noise point (-1) the majority cluster among its k nearest clustered neighbours
    on the same layout; a tie goes to the tied cluster with the nearest member. Votes come only from
    points HDBSCAN itself clustered, so assignments never chain. Returns (ids, assigned mask)."""
    from scipy.spatial.distance import cdist

    ids = np.asarray(ids).copy()
    assigned = ids == -1
    noise, lab = np.where(assigned)[0], np.where(~assigned)[0]
    if len(noise) == 0:
        return ids, assigned
    if len(lab) == 0:                    # nothing clustered at all: one cluster
        ids[:] = 0
        return ids, assigned
    D = cdist(Y[noise], Y[lab])
    kk = min(k, len(lab))
    new = ids.copy()
    for r, i in enumerate(noise):
        near = ids[lab[np.argsort(D[r], kind="stable")[:kk]]]
        votes = Counter(near.tolist())
        top = max(votes.values())
        new[i] = next(c for c in near if votes[int(c)] == top)   # nearest among the tied leaders
    return new, assigned


def watchlist(z: np.ndarray, significant: np.ndarray, n: int = N_WATCH) -> np.ndarray:
    """Positions in z of the pairs closest to breaking: most negative Fisher z first, excluding every pair
    that already passed BH (shown in the significant list) and any whose recent correlation rose."""
    z = np.asarray(z, float)
    cand = np.where(~np.asarray(significant, bool) & (z < 0))[0]
    return cand[np.argsort(z[cand], kind="stable")][:n]


def label_clusters(ids: np.ndarray, Y: np.ndarray, tick: list[str], meta: dict, overrides: list[dict],
                   assigned: np.ndarray | None = None):
    """Manual overrides first (best member overlap), else the dominant sub-industry or sector.
    Never a 'Mixed' label: two-sector clusters are named 'A & B'. Names and label positions come from
    the members HDBSCAN placed itself, so a noise point joining a cluster can't flip its name."""
    out = []
    core_mask = np.ones(len(ids), bool) if assigned is None else ~np.asarray(assigned, bool)
    for c in sorted(set(ids) - {-1}):
        m_all = np.where(ids == c)[0]
        m = m_all[core_mask[m_all]] if core_mask[m_all].any() else m_all
        members = [tick[i] for i in m]
        subs = Counter(meta[t]["sub"] for t in members).most_common()
        secs = Counter(meta[t]["sector"] for t in members).most_common()
        if subs[0][1] / len(members) >= 0.4:
            auto, cnt = subs[0]
        elif secs[0][1] / len(members) >= 0.5 or len(secs) == 1:
            auto, cnt = secs[0]
        else:
            auto, cnt = f"{secs[0][0]} & {secs[1][0]}", secs[0][1] + secs[1][1]
        out.append({"id": int(c), "label": auto, "auto": auto, "share": round(cnt / len(members), 2), "n": len(m_all),
                    "x": r3(np.median(Y[m, 0])), "y": r3(np.median(Y[m, 1])), "members": members})
    # each cluster takes the override that covers most of it (>= 50% of members); an override can
    # name several clusters, but within one layout the bigger cluster keeps the plain name
    for cl in out:
        best, score = None, 0.0
        mem = set(cl["members"])
        for ov in overrides:
            match = set(ov.get("tickers", []))
            match |= {t for t in mem if meta[t]["sector"] in ov.get("sectors", []) or meta[t]["sub"] in ov.get("subs", [])}
            share = len(match & mem) / len(mem)
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
    complete = [t for t in meta if t in win and win[t].notna().all()]
    dropped = [t for t in meta if t not in complete]
    assets, aka = collapse_share_classes(complete, meta, (close * volume).iloc[-MAP_DAYS:].mean())
    log(f"universe: {len(assets)} assets ({sum(meta[t]['cls'] == 'stock' for t in assets)} stocks); dropped {len(dropped)}: {dropped}")
    for t, others in sorted(aka.items()):
        log(f"  share classes: {t} stays, {', '.join(others)} folded in (same CIK {meta[t]['cik']}; {t} trades more dollars)")
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
        shares = shares_outstanding(ua or "MarketMapPro/2.2 (research script)")
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

    # ---- business text (stocks only): SEC 10-K Item 1, Yahoo where EDGAR fails. Custom and relaxed
    # extractions must each beat their own Yahoo summary on the gate's checks; then the whole 10-K set
    # must not be clearly worse than all-Yahoo, or every company uses Yahoo this run.
    stocks = [assets[i] for i in stock_idx]
    sidx = {t: k for k, t in enumerate(stocks)}
    extractors = load_extractors()
    special = set(extractors["custom"]) | extractors["relaxed"]
    overridden = set(load_cik_overrides())
    texts: dict[str, str] = {}
    mode: dict[str, str] = {}
    why: dict[str, str] = {}
    dumps: dict[str, list[str]] = {}
    edgar_stats = None
    edgar_on = bool(ua and "@" in ua)
    if edgar_on:
        texts, failed, why, mode, dumps, traces, edgar_stats = edgar_texts(meta, stocks, ua, extractors, debug=special | overridden)
        log(f"EDGAR: Item 1 for {len(texts)} of {len(stocks)} companies "
            f"({sum(v == 'custom' for v in mode.values())} custom, {sum(v == 'relaxed' for v in mode.values())} relaxed)")
        log(f"  10-K cache: {edgar_stats['reused']} filings reused, {len(edgar_stats['downloaded'])} downloaded"
            + (f" (new 10-K: {', '.join(edgar_stats['downloaded'][:40])})" if edgar_stats["downloaded"] else "")
            + (f"; lookup failed, last 10-K reused: {', '.join(edgar_stats['lookupFallback'])}" if edgar_stats["lookupFallback"] else ""))
        for t, tr in sorted(traces.items()):
            log(f"  {t} lookup failed ({why[t]}):")
            for line in tr:
                log(f"    {line}")
        if texts:
            wc = {t: len(x.split()) for t, x in texts.items()}
            short = sorted(t for t, w in wc.items() if w < 600)
            log(f"  Item 1 words used: median {int(np.median(list(wc.values())))}, min {min(wc.values())}; "
                f"{len(short)} under 600 words" + (f": {', '.join(short[:40])}{' ...' if len(short) > 40 else ''}" if short else ""))
            for t in sorted(({t for pr in TEXT_PROBES for t in pr} | special | overridden) & set(texts)):
                log(f"  {t:>5} [{mode[t]}, {wc[t]} words]: {' '.join(texts[t].split()[:16])} ...")
    else:
        failed = list(stocks)
        log("EDGAR: SEC_USER_AGENT not set (needs a contact email), so every company falls back to Yahoo")
    yt, yahoo_stats = yahoo_texts(stocks)   # every stock: the fallback, and the baseline for the quality checks
    log(f"Yahoo summaries: {len(yt)} of {len(stocks)}; {yahoo_stats['fetched']} fetched this run (due after {YAHOO_TTL_DAYS} days or new)"
        + "".join(f"; {k}: {', '.join(v[:20])}" for k, v in yahoo_stats.items() if isinstance(v, list) and v))
    stub = {t: f"{meta[t]['name']}: {meta[t]['sub']}" for t in stocks}
    raw_y = embed_raw([clean_text(yt.get(t) or stub[t], meta[t]["name"]) for t in stocks])
    emb_y = finish_embedding(raw_y)
    emb = emb_y
    subs_st, secs_st = [meta[t]["sub"] for t in stocks], [meta[t]["sector"] for t in stocks]
    iu_q = np.triu_indices(len(stocks), 1)
    text_rejected, text_check = False, None
    if texts:
        korder = sorted(texts, key=sidx.get)
        raw_k = dict(zip(korder, embed_raw([clean_text(texts[t], meta[t]["name"]) for t in korder])))

        def combo(use: set) -> np.ndarray:
            R = raw_y.copy()
            for t in use:
                R[sidx[t]] = raw_k[t]
            return finish_embedding(R)

        use = set(texts)
        E_all = combo(use)
        tri_e, tri_y = np.sort((E_all @ E_all.T)[iu_q]), np.sort((emb_y @ emb_y.T)[iu_q])
        for t in sorted(t for t in use if mode.get(t) in ("custom", "relaxed")):
            qe = ticker_quality(E_all, sidx[t], subs_st, secs_st, tri_e)
            qy = ticker_quality(emb_y, sidx[t], subs_st, secs_st, tri_y)
            ok = ticker_gate(qe, qy)
            log(f"  quality check {t} [{mode[t]}]: 10-K {qe} vs Yahoo {qy} -> {'pass' if ok else 'FAIL, stays on Yahoo'}")
            if not ok:
                use.discard(t)
                why[t] = (f"{mode[t]} extractor failed the quality check (10-K: sector {qe['sector']}, same-industry "
                          f"{qe['sameSubPct']} pctl vs Yahoo {qy['sector']}, {qy['sameSubPct']})")
                failed.append(t)
        texts = {t: texts[t] for t in use}
        emb_e = combo(use)
        q_e = text_quality(emb_e, subs_st, secs_st)
        q_y = text_quality(emb_y, subs_st, secs_st)
        text_check = {"edgar": q_e, "yahoo": q_y}
        log(f"text quality (top-5 neighbours sharing sub-industry / sector; median same-sub-industry pair pctl):\n"
            f"  10-K  {q_e}\n  Yahoo {q_y}")
        tri_e, tri_y = (emb_e @ emb_e.T)[iu_q], (emb_y @ emb_y.T)[iu_q]
        for x, y in TEXT_PROBES:
            if x in sidx and y in sidx:
                i_, j_ = sidx[x], sidx[y]
                pe, py = (tri_e < emb_e[i_] @ emb_e[j_]).mean() * 100, (tri_y < emb_y[i_] @ emb_y[j_]).mean() * 100
                log(f"  {x}-{y}: 10-K {pe:.1f} pctl, Yahoo {py:.1f} pctl")
        if text_gate(q_e, q_y):
            emb = emb_e
        else:
            text_rejected = True
            texts = {}
            log("  10-K text REJECTED by the quality check: Yahoo summaries are used for every company this run")
    fallback = sorted(t for t in stocks if t not in texts and t in yt)
    name_only = sorted(t for t in stocks if t not in texts and t not in yt)
    text_src = {t: ("edgar" if t in texts else "yahoo" if t in yt else "name") for t in stocks}
    log(f"business text: {len(texts)} SEC 10-K, {len(fallback)} Yahoo fallback, {len(name_only)} name only")
    if edgar_on and texts:
        for t in fallback:
            log(f"  {t:>5} on Yahoo: {why.get(t, 'no 10-K text')}")
        for t in sorted(set(dumps) - set(texts)):          # what the filing looks like, for writing an extractor
            log(f"  {t} heading dump:")
            for line in dumps[t]:
                log(f"    {line}")
    used_edgar = bool(texts)
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

    def clusters_for(Y, name):
        has = np.where(~np.isnan(Y[:, 0]))[0]
        lab = np.full(N, -1)
        lab[has] = hdbscan_labels(Y[has])
        lab[has], merged = merge_adjacent(lab[has], Y[has], [sectors[i] for i in has])
        assigned = np.zeros(N, bool)
        lab[has], assigned[has] = assign_noise(lab[has], Y[has])
        assert (lab[has] != -1).all(), f"{name}: unclustered points left after noise assignment"
        log(f"  clusters [{name}]: {len(set(lab[has]))} clusters; {int(assigned.sum())} HDBSCAN noise points assigned "
            f"to their {NOISE_K} nearest neighbours' majority cluster")
        return {"ids": [int(v) for v in lab],
                "labels": label_clusters(lab[has], Y[has], [assets[i] for i in has], meta, overrides, assigned[has]),
                "assigned": [bool(v) for v in assigned]}, merged
    biz_clusters, biz_merged = clusters_for(bz, "business")

    # ---- pass 2: clusters, neighbours, lists, exports
    out_presets, report = {}, {}
    src_arr = np.array([text_src.get(t, "") for t in assets])
    mixed_report: dict = {}
    si, sj = np.triu_indices(N, 1)
    cik = np.array([meta[t]["cik"] or -(k + 1) for k, t in enumerate(assets)])
    distinct = cik[si] != cik[sj]            # share classes are already folded into one ticker; belt and braces
    for p in FACTOR_COLS:
        d = st[p]
        inp, C, K, Nw, CL, C60, beh = d["inp"], d["C"], d["K"], d["Nw"], d["CL"], d["C60"], d["beh"]
        beh_clusters, merged = clusters_for(beh, PRESET_LABEL[p])
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
        hs = cand[(ps[cand] > np.quantile(ps[cand], TOP_Q)) & stable[cand]]
        mixed = ~same_source(src_arr, si, sj)       # one side 10-K, the other Yahoo: reads unlike for that reason alone
        hidden = hc[~mixed[hc]][np.argsort(ps[hc[~mixed[hc]]])[:N_LIST]]
        apart = hs[~mixed[hs]][np.argsort(pc[hs[~mixed[hs]]])[:N_LIST]]
        if p == "mkt":
            mixed_report = {"hidden": (hc[np.argsort(ps[hc])[:N_LIST]], hidden), "apart": (hs[np.argsort(pc[hs])[:N_LIST]], apart)}

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
        watch = tested[watchlist(z, rej)]
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
            "watch": [{"a": assets[si[q]], "b": assets[sj[q]], "longRun": r3(CL[si[q], sj[q]]),
                       "recent": r3(C60[si[q], sj[q]]), "k": int(kk[q]), "n": int(nn[q]),
                       "z": round(zq[int(q)][0], 2), "q": float(f"{zq[int(q)][1]:.2g}")} for q in watch],
        }
        report[p] = out_presets[p]

        d["E2"].T.astype(np.float32).tofile(OUT_BIN / f"series_resid_{p}.f32")
        with open(OUT_BIN / f"matrix_{p}.bin", "wb") as f:
            q16(upper(C)).tofile(f)
            q16(upper(CL)).tofile(f)
            upper(K).astype(np.uint8).tofile(f)
            upper(Nw).astype(np.uint8).tofile(f)

    nn_biz = reads_like(S, P, is_stock, src_arr, assets)
    yahoo_rl = []                       # fallback stocks whose "Reads like" is on Yahoo summaries vs all stocks
    if used_edgar:
        targets = [sidx[t] for t in stocks if text_src[t] == "yahoo"]
        for t, lst in reads_like_yahoo(emb_y, np.array([t in yt for t in stocks]), targets, stocks).items():
            nn_biz[ix[t]] = lst
            yahoo_rl.append(t)
        yahoo_rl.sort()

    beta_mkt = residualize(R2, win[["SPY"]].to_numpy())[1][0]
    doc = {
        "version": 2.2,
        "asof": str(cal[-1].date()),
        "start": str(lr.index[0].date()),
        "mapStart": str(win.index[0].date()),
        "dates": [str(d.date()) for d in win.index],
        "years": years,
        "textSource": "edgar" if used_edgar else "yahoo",
        "textFallback": fallback if used_edgar else [],
        "textRejected": text_rejected,
        "textCheck": text_check,
        "readsLikeMinPool": READS_LIKE_MIN_POOL,
        "readsLikeYahoo": yahoo_rl,
        "textUpdates": {"edgar": edgar_stats, "yahoo": yahoo_stats, "yahooTtlDays": YAHOO_TTL_DAYS},
        "presets": [{"id": p, "label": PRESET_LABEL[p], "factors": FACTOR_INSTRUMENTS[p], "exposures": EXPOSURE_NAMES[p],
                     "notPlotted": [t for t in FACTOR_INSTRUMENTS[p] if t in ix]} for p in FACTOR_COLS],
        "assets": [{"t": t, "name": meta[t]["name"], "cls": meta[t]["cls"], "sector": meta[t]["sector"], "sub": meta[t]["sub"],
                    "mcap": round(mcap[t] / 1e9, 1) if t in mcap and np.isfinite(mcap[t]) else None,
                    "vol": round(float(ann_vol[t]), 3) if np.isfinite(ann_vol[t]) else None,
                    "adv": round(float(adv[t]) / 1e6, 1) if np.isfinite(adv[t]) else None,
                    "beta": round(float(beta_mkt[ix[t]]), 2),
                    "sd": sig5(sd2[ix[t]]), "sd1y": sig5(sd1[ix[t]]),
                    "text": text_src.get(t), **({"aka": aka[t]} if t in aka else {})} for t in assets],
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
    log("\nMIXED-SOURCE RULE (Market): pairs with one 10-K and one Yahoo text are dropped from the lists")
    for name, (before, after) in mixed_report.items():
        gone = [q for q in before if q not in set(after)]
        fmt_p = lambda q: f"{assets[si[q]]}-{assets[sj[q]]}"  # noqa: E731
        log(f"  {'Hidden twins' if name == 'hidden' else 'Lookalikes'}: {len(gone)} of the top {len(before)} dropped"
            + (f" ({', '.join(fmt_p(q) + ' [' + src_arr[si[q]] + '/' + src_arr[sj[q]] + ']' for q in gone)})" if gone else ""))
        log(f"    before: {', '.join(fmt_p(q) for q in before[:10])}")
        log(f"    after:  {', '.join(fmt_p(q) for q in after[:10])}")
    for t in ["XOM", "KKR"] + yahoo_rl:
        if t in ix and nn_biz[ix[t]] is not None:
            log(f"  {t} reads like [{'Yahoo vs all stocks' if t in yahoo_rl else text_src.get(t)}]: " + (", ".join(f"{a} {v}" for a, v in nn_biz[ix[t]]) or "not enough comparable text"))

    log("\nDECOUPLING (Fisher z, one-sided, BH q = 0.05)")
    for p, P_ in report.items():
        log(f"  [{PRESET_LABEL[p]}] tested {P_['decoupleTested']}, passed {len(P_['decouple'])}")
        for r in P_["decouple"][:10]:
            log(f"    {r['a']:>6} {r['b']:<6} long-run {r['longRun']:.2f} -> 60d {r['recent']:.2f}  z {r['z']}  q {r['q']}")
        log("    watchlist (closest to breaking, not significant):")
        for r in P_["watch"][:5]:
            log(f"      {r['a']:>6} {r['b']:<6} long-run {r['longRun']:.2f} -> 60d {r['recent']:.2f}  z {r['z']}  q {r['q']}")

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
        g = names[ids[ix[t]]]
        groups.setdefault(g, [0.0, 0.0, []])
        groups[g][0] += w[k_]
        groups[g][1] += rc[k_]
        groups[g][2].append(t)
    log(f"  vol {np.sqrt(w @ Sig @ w * YEAR_DAYS):.1%}  beta {sum(w[k_] * beta_mkt[ix[t]] for k_, t in enumerate(test)):.2f}")
    for g, (cap, risk, mem) in sorted(groups.items(), key=lambda kv: -kv[1][1]):
        flag = "  <- risk > capital by 10+ pts" if risk - cap >= 0.10 else ""
        log(f"    {g:<34} capital {cap:5.1%}  risk {risk:5.1%}  {', '.join(mem)}{flag}")
    asg = report["mkt"]["clusters"]["beh"]["assigned"]
    log("  assigned from HDBSCAN noise: " + (", ".join(t for t in test if asg[ix[t]]) or "none"))

    k = ix["KKR"]
    beta2 = C_raw[k] * sd2[k] / sd2
    beta1 = C_raw1[k] * sd1[k] / sd1
    liquid = np.array([a is not None and a >= 20 for a in (round(float(adv[t]) / 1e6, 1) if np.isfinite(adv[t]) else None for t in assets)])
    ranked = [j for j in np.argsort(-(C_raw[k] ** 2)) if j != k and liquid[j]]
    etf_h = [j for j in ranked if meta[assets[j]]["cls"] in ("etf", "bond", "commodity")][:3]
    peer_h = [j for j in ranked if meta[assets[j]]["cls"] == "stock"][:3]
    for title, order in (("ETF HEDGES", etf_h), ("PEER HEDGES (pair-trade style)", peer_h)):
        log(f"\nKKR {title} (total returns, 2y)")
        for j in order:
            unstable = np.sign(beta1[j]) != np.sign(beta2[j]) or abs(beta1[j] - beta2[j]) > 0.5 * abs(beta2[j])
            verb = "Short" if beta2[j] > 0 else "Buy"
            log(f"    {verb} {abs(beta2[j]):.2f}x {assets[j]:<6} variance -{C_raw[k, j] ** 2:.0%}  1y beta {beta1[j]:.2f}"
                f"  {'UNSTABLE' if unstable else 'stable'}")
    log(f"\nbusiness text: {'SEC 10-K' if used_edgar else 'Yahoo'}"
        + (f", {len(fallback)} of {len(stocks)} fell back to Yahoo" if used_edgar else "")
        + (" (10-K text rejected by the quality check)" if text_rejected else ""))
    log(f"done in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    sys.exit(main())
