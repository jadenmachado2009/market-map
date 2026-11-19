# Market Map Pro (v2)

v1 answers "which stocks are near each other". Pro answers "what is my portfolio really betting on, and what hedges it?" It lives at `/pro`, next to v1, which is unchanged (see "v1 protection" below).

## What's in it
- **Portfolio X-ray:** paste `NVDA 20, MSFT 15, JPM 10` (weights optional) to get the effective number of independent bets N_eff = (Σλ)² / Σλ², for the eigenvalues of W^½ C W^½. It is computed as (Σw)² / Σᵢⱼ wᵢwⱼCᵢⱼ², which is the same quantity without an eigen-decomposition. You also get holdings grouped by cluster, pairs at a residual correlation of 0.5 or more, and the total-return version. Everything runs client-side; the portfolio is saved to localStorage only.
- **Factor presets:** residuals after SPY, after SPY + TLT, or after SPY + TLT + IWM + IWD + IWF. Each preset has its own layout, lists, clusters and risk-card exposures.
- **Risk card:** market cap, volatility, beta, and factor exposures. "Trades with" includes years held; "Reads like" is shown as a percentile. Then the hedge finder.
- **Pair view:** prices rebased to 100, a rolling 60-day residual correlation against the dashed long-run level, plus stability, similarity percentile and betas.
- **Lists:** Hidden twins, Lookalikes, Decoupling now. Pairs involving equity ETFs are excluded.
- **Cross-asset universe:** sector ETFs, QQQ/IWM/EFA/EEM, FX, gold/silver/oil, Treasuries/HY and BTC/ETH. These appear as diamonds, on the behaviour map only.
- **Filters:** market cap (stocks), 1-year volatility, 3-month dollar volume and asset class.

## Run it
```bash
python pipeline_v2.py                    # ~1 min with cached caches; writes web/src/data-pro + web/public/pro-data
python pipeline_v2.py --cached-prices    # reuse pro_cache/prices.pkl
python -m unittest discover tests_v2     # winsorisation, factor regression, stability, N_eff
cd web && node --test tests-pro/*.test.mjs   # N_eff, parser, rolling correlation (front-end maths)
```
Business text comes from **SEC EDGAR 10-K Item 1** when `SEC_USER_AGENT` is set to something like `"Your Name you@example.com"`. SEC rejects document requests without a contact address. Without it, the pipeline falls back to Yahoo summaries (seeded from `desc_cache.json` if present).

## Files
| Path | What |
|---|---|
| `pipeline_v2.py` | the whole data build; the maths is in small pure functions at the top |
| `cluster_labels_v2.json` | manual cluster names, matched by member tickers / sectors / sub-industries |
| `tests_v2/` | Python tests |
| `requirements_v2.txt` | pipeline dependencies |
| `.github/workflows/pro-nightly.yml` | nightly rebuild + Vercel deploy |
| `web/src/app/pro/page.tsx` | the `/pro` route |
| `web/src/pro/` | v2 components, maths, lazy loaders, styles (scoped under `.pro-root`) |
| `web/src/data-pro/market_map_v2.json` | the page's data (~100 KB gzipped) |
| `web/public/pro-data/` | lazy binaries: per-preset pair matrices (int16 corr ×2, uint8 years held / available), total-return matrix, similarity percentiles, Float32 price and residual series |
| `web/tests-pro/` | front-end tests (Node's built-in runner, so `package.json` stays untouched) |
| `pro_meta/v1_checksums*.sha256` | SHA-256 of every v1 file: at the branch point, and now (with the Try Pro link) |

## Nightly rebuild: setup still needed
1. Merge `v2-pro` into `main`. GitHub only runs scheduled workflows from the default branch.
2. Add repository secrets: `SEC_USER_AGENT`, plus `VERCEL_TOKEN`, `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` for the deploy step. Without the Vercel secrets the job still builds and tests, but skips deploying.

Data isn't committed nightly (≈7 MB of binaries a night would bloat git). Each run deploys fresh data straight to Vercel. A normal `git push` deploys whatever data was last committed.

## Choices that differ from the brief, and why
- **Factor exposures for "+ Rates, size, value"** are shown as Market, Rates, Size (IWM−SPY) and Value (IWD−IWF). SPY, IWM, IWD and IWF are nearly collinear, so their raw betas are unreadable. The residuals come from the full five-ETF fit exactly as specified; only the displayed betas are re-expressed, and that re-expression is exact.
- **Cluster auto-labels** use the most common sub-industry only when it covers at least 40% of the cluster. Otherwise they use the dominant sector, or "Mixed: A / B". Without this, an 85-stock tech/communications cluster was labelled "Application Software".
- **Equity ETFs are left out of the pair lists.** Their links to their own holdings are mechanical: the first decoupling list was all NFLX–QQQ, AAPL–XLK and similar. They stay on the map and in the hedge finder.
- **Hedge finder "lowest" reads as "closest to zero"**, so it's a separate list from "most negative".
- **Factor ETFs drop out of presets that use them** (TLT under "+ Rates"; TLT and IWM under the full preset): their residual is zero by construction.

## v1 protection
- Every v1 file is unchanged except `web/src/app/page.tsx`, which gained the approved "Try Pro →" link (5 lines). `pro_meta/v1_checksums_branchpoint.sha256` records v1 before any v2 work (23 of 24 still match); `pro_meta/v1_checksums.sha256` is the expected state with the link (`shasum -a 256 -c pro_meta/v1_checksums.sha256`).
- The link is a plain `<a>` rather than `next/link`, so v1 gains no client component. Its rendered markup differs from the branch point by exactly that one element.
- v1's rendered HTML is identical, apart from the stylesheet hash and build ID.
- Tailwind v4 scans the whole project for class names, so the single shared stylesheet now also contains the utilities `/pro` uses: 44 added rules, plus new variables in the `:root` theme block. No v1 rule or variable value changed. Keeping them out would mean editing v1's `globals.css`.
