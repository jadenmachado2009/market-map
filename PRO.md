# Market Map Pro (v2.4)

v1 answers "which stocks are near each other". Pro answers "what is my portfolio really betting on, and what hedges it?" It lives at `/pro`, next to v1, which is unchanged (see "v1 protection" below).

## What's in it
- **Portfolio X-ray:** paste `NVDA 20, MSFT 15, JPM 10` (weights optional). The headline is the effective number of independent bets on the **covariance** of daily total returns (2 years, winsorised): N_eff = (Σλ)² / Σλ² for the eigenvalues of M = diag(w) Σ diag(w), computed as tr(M)² / ‖M‖²_F. The second line is the same on the active preset's residual covariance. Then portfolio volatility and beta, "% of capital vs % of risk" by cluster (risk share RCᵢ = wᵢ(Σw)ᵢ / wᵀΣw, sorted by risk, with clusters 10+ points risk-heavy flagged), and pairs at a residual correlation of 0.5 or more. Every holding has a group: its cluster in the active preset, or its asset class ("Bonds", "Equity ETFs") when that preset uses it as a factor. Everything runs client-side; the portfolio is saved to localStorage only.
- **Factor presets:** Market (SPY); + Rates & defensives (SPY, TLT, USMV − SPY); + Rates, defensives, size, value (SPY, TLT, USMV − SPY, IWM, IWD, IWF). Factor instruments are not plotted. The other presets reuse the Market positions and only move stocks whose neighbourhood changes, so switching presets moves 15–27 dots, not all of them.
- **Risk card:** market cap, volatility, beta, and every factor exposure for the preset. "Trades with" includes years held; "Reads like" is shown as a percentile. **Best hedges** are on total returns: hedge ratio β = Cov / Var, variance removed = ρ², flagged "unstable" if the 1-year ratio flips sign or moves more than 50%. Two lists, top 3 each: **ETF hedges** first (sector, index, factor, bond and commodity ETFs; "No ETF hedge passes your filters." when none qualify), then **Peer hedges (pair-trade style)** (single stocks). Currency ETFs and crypto are in neither list; they still show in the Residual view. Commodity ETFs were added after the first v2.2 release: without them a gold miner's best hedge (NEM: GLD, −61% variance) was hidden. A "Residual view" toggle keeps the old residual-correlation lists.
- **Pair view:** prices rebased to 100, a rolling 60-day residual correlation against the dashed long-run level, plus stability, similarity percentile and betas.
- **Lists:** Hidden twins and Lookalikes keep only pairs that held a correlation of 0.3+ in at least 6 of 11 calendar years (or 60% of a shorter history and at least 4 years), each tagged with a theme from `pair_themes_v2.json`. Decoupling tests durable pairs (long-run ≥ 0.5, held 7+ of 11 years) with a one-sided Fisher z on the last 60 days and Benjamini–Hochberg at q = 0.05. The build log prints how many pairs were tested and how many passed. Below it, a muted watchlist, "Closest to breaking (not significant yet)", shows the 5 tested pairs with the most negative z that did not pass (never a significant pair; only pairs whose correlation fell). Equity ETFs and share-class pairs (same SEC CIK, e.g. GOOG/GOOGL) are excluded.
- **Clusters:** HDBSCAN on each layout, then every noise point joins the majority cluster of its 5 nearest clustered neighbours on the same layout (ties: the tied cluster with the nearest member), on every preset and both maps. These carry `assigned: true` in the JSON and look like any other member on the page. Cluster names and label positions come from the members HDBSCAN placed itself, so an assigned point can't rename a cluster.
- **Cross-asset universe:** sector ETFs, SPY/QQQ/IWM/EFA/EEM, the factor ETFs USMV/IWD/IWF, FX, gold/silver/oil, Treasuries/HY and BTC/ETH. These appear as diamonds, on the behaviour map only.
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
| `cluster_labels_v2.json` | manual cluster names by economic theme, matched by member tickers / sectors / sub-industries (the cluster takes the best match covering 50%+ of it) |
| `pair_themes_v2.json` | theme tags for pair lists: sub-industry rules plus per-pair overrides |
| `tests_v2/` | Python tests |
| `requirements_v2.txt` | pipeline dependencies |
| `.github/workflows/pro-nightly.yml` | nightly rebuild + Vercel deploy (01:30 UTC Tue–Sat, or run it by hand from the Actions tab) |
| `web/src/app/pro/page.tsx` | the `/pro` route |
| `web/src/pro/` | v2 components, maths, lazy loaders, styles (scoped under `.pro-root`) |
| `web/src/data-pro/market_map_v2.json` | the page's data (~100 KB gzipped) |
| `web/public/pro-data/` | lazy binaries: per-preset pair matrices (int16 corr ×2, uint8 years held / available), total-return matrix, similarity percentiles, Float32 price and residual series |
| `web/tests-pro/` | front-end tests (Node's built-in runner, so `package.json` stays untouched) |
| `pro_meta/v1_checksums*.sha256` | SHA-256 of every v1 file: at the branch point, and now (with the Try Pro link) |

## Nightly rebuild: setup still needed
1. The workflow is active on `main`. To edit it, use GitHub's web editor: the local git token used so far lacks the `workflow` scope, so pushes that change `.github/workflows/` are rejected.
2. Add these repository secrets (GitHub → Settings → Secrets and variables → Actions):
   - `SEC_USER_AGENT`: `Market Map <your email>`. SEC requires a reachable contact on every request. Without it, business text stays on Yahoo.
   - `VERCEL_TOKEN`: create one at vercel.com/account/tokens.
   - `VERCEL_ORG_ID`: your Vercel team ID (Team Settings → General → Team ID), or the `orgId` in `.vercel/project.json` after `vercel link`.
   - `VERCEL_PROJECT_ID`: the market-map project's ID (Project → Settings → General → Project ID), or the `projectId` in `.vercel/project.json`.

   Without the Vercel secrets the job still builds and tests, but skips deploying.

Data isn't committed nightly (≈7 MB of binaries a night would bloat git). Each run deploys fresh data straight to Vercel. A normal `git push` deploys whatever data was last committed.

## Choices that differ from the brief, and why
- **The factor regression uses a spread basis:** Market, Rates (TLT), Defensive (USMV − SPY), Size (IWM − SPY), Value (IWD − IWF) and Large-cap tilt ((IWD + IWF)/2 − SPY). It spans exactly the same space as the instruments, so the residuals are identical (tested). Raw collinear ETF betas would be unreadable, and all six betas are shown.
- **Preset layouts are anchored, not re-run.** A fresh UMAP per preset, even seeded from Market and Procrustes-aligned, moved ~96% of dots (median 0.19 of the map) without improving how well the map shows each preset's neighbours (0.52–0.53 either way). Now a stock keeps its Market position unless it shares fewer than 5 of its top-10 neighbours; then it moves to the median of its new neighbours.
- **Cluster labels:** manual theme names cover the 20 biggest clusters of every behaviour layout. Unnamed clusters use their dominant sub-industry or sector, never "Mixed". Same-sector clusters whose nearest members are within 0.05 are merged first.
- **Equity ETFs are left out of the pair lists.** Their links to their own holdings are mechanical: the first decoupling list was all NFLX–QQQ, AAPL–XLK and similar. They stay on the map and in the hedge finder.
- **Hedge finder "lowest" reads as "closest to zero"**, so it's a separate list from "most negative".
- **Factor ETFs drop out of presets that use them** (SPY everywhere; TLT and USMV under "+ Rates"; TLT, USMV, IWM, IWD and IWF under the full preset): their residual is zero by construction. They stay in the universe so they can be hedges.
- **10-K Item 1 extraction (fixed 2026-11-20).** The first 10-K run scored worse than Yahoo (top-5 business neighbours sharing a sector 0.78 → 0.72; ADM–BG fell from the 99th to the 28th percentile) because the extractor took the *longest* span between any "Item 1. Business" and "Item 1A" mention, so cross-references could win. Now: the first line-start Item 1 heading with 300+ words, ended by the next line-start Item 1A/1B/1C/2/3 heading; "Items 1 and 2. Business and Properties" is recognised (most oil & gas filers); boilerplate sub-sections (regulation, human capital, executive officers…) are cut once 300 words are in; older EDGAR filing pages are searched when the recent list has no 10-K (XOM). Whole filings are cached as plain text, so extractor changes re-run without refetching.
- **Quality gate on business text.** Every run embeds both the 10-K text and the Yahoo summaries and compares them: how often a stock's 5 nearest texts share its sector or sub-industry, and the median similarity percentile of same-sub-industry pairs. If the 10-K version is clearly worse (sector share down by more than 0.04, or median down by more than 3 points), the run uses Yahoo for everyone and the page says so. Both scores and a set of probe pairs (ADM–BG, KO–PEP, KKR–BX, …) are printed in the build log.
- **v2.3 text rules.** `cik_overrides_v2.json` fixes CIKs Wikipedia gets wrong (XOM: Wikipedia lists 2115436, a registrant with no 10-K; the 10-Ks are filed under 34088). `item1_extractors_v2.json` holds per-ticker extractors for annual-report-style 10-Ks (C, MS, GE, HON, INTC, MCD: start/end heading patterns) and the tickers allowed a relaxed heading rule (AIG, EXC, EXPE: the Item 1 heading may sit mid-line). Each such extraction must beat that ticker's own Yahoo summary on the quality check (one neighbour of sector slack, same 3-point median rule), or it stays on Yahoo and the log says why; filings that end on Yahoo get their heading lines dumped to the log. Hidden twins and Lookalikes drop pairs whose two texts come from different sources (10-K vs Yahoo reads unlike for that reason alone), and "Reads like" compares stocks only with stocks of the same text source; with fewer than 100 such stocks it says "Not enough comparable text" and gives the pool size (see v2.3.1). Fallback stocks say "Business text: Yahoo (no usable 10-K)" on their risk card.
- **v2.3.1 Reads like needs a pool of 100.** With only the ~12 Yahoo fallback stocks to compare against, their "top 5" was noise: VLO (a refiner) read like AMCR, FCX, EXC, DTE and CAH at 84–88 pctl, and AMCR (packaging) read like CAH (drug distribution) at 97 pctl. A percentile cutoff can't fix it: Yahoo summaries share a style, so Yahoo pairs from different sectors sit at a median 73rd pctl vs 45th for 10-K pairs (run #6 data). So "Reads like" now needs 100 other stocks with the same text source (`READS_LIKE_MIN_POOL`, written to the JSON as `readsLikeMinPool`): then the 5 shown are the top 5% of candidates or better. 10-K stocks (pool 484) are unchanged; fallback stocks show "Not enough comparable text: only 12 other stocks use Yahoo summaries, and a fair ranking needs 100."
- **v2.4 Yahoo-based Reads like for fallback stocks.** A fallback stock's Yahoo summary is compared with the Yahoo summaries of all ~498 stocks (10-K stocks included: Yahoo with Yahoo is the same source, and the pool is full). Percentiles are among Yahoo-vs-Yahoo pairs, so they sit on the Yahoo scale. The card labels the list "Based on Yahoo summaries", and the pair view shows the same score labelled "(Yahoo summaries)" (the stored sim_pct.bin would give the 10-K-vs-Yahoo number). The JSON lists these stocks in `readsLikeYahoo`. 10-K stocks still rank only against 10-K stocks; Hidden twins and Lookalikes keep the mixed-source rule. Preview on Yahoo data: AIG reads like EG, ACGL, ALL, WRB, CB; VLO like PSX, XOM, MPC; WY (the only timber REIT) is weakest, at about 96–97 pctl, on other REITs.
- **Forced cluster assignment has a cost.** A point HDBSCAN left out takes its neighbours' cluster even when the name fits poorly: on the 2026-11-19 Market layout TLT, IEF and HYG join "Consumer cyclicals" (their nearest clustered neighbours are rate-sensitive building names: SHW, MLM, VMC, CRH, HD) and the drug distributors join "Exchanges & waste collectors".

## v1 protection
- Every v1 file is unchanged except `web/src/app/page.tsx`, which gained the approved "Try Pro →" link (5 lines). `pro_meta/v1_checksums_branchpoint.sha256` records v1 before any v2 work (23 of 24 still match); `pro_meta/v1_checksums.sha256` is the expected state with the link (`shasum -a 256 -c pro_meta/v1_checksums.sha256`).
- The link is a plain `<a>` rather than `next/link`, so v1 gains no client component. Its rendered markup differs from the branch point by exactly that one element.
- v1's rendered HTML is identical, apart from the stylesheet hash and build ID.
- Tailwind v4 scans the whole project for class names, so the single shared stylesheet now also contains the utilities `/pro` uses: 44 added rules, plus new variables in the `:root` theme block. No v1 rule or variable value changed. Keeping them out would mean editing v1's `globals.css`.
