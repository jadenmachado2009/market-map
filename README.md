<p align="center">
  <a href="https://market-map-zeta.vercel.app">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="web/public/brand/mm-lockup.svg">
      <img src="brand/readme/mm-lockup-ink.svg" alt="Market Map" width="240">
    </picture>
  </a>
</p>

# Market Map

**Live:** https://market-map-zeta.vercel.app

The S&P 500 laid out two ways: by **how each stock trades** (residual-return correlations with the market removed, UMAP) and by **what each company does** (embeddings of its business description, aligned to the first map with Procrustes). The interesting stocks are the ones that move when you switch.

| Path | What it is |
|---|---|
| `market_map.ipynb` | Colab pipeline: prices → residual correlations → behaviour map; descriptions → embeddings → business map; divergence lists; exports `market_map.json`. Includes sanity checks. |
| `oos_test.ipynb` | Out-of-sample test of the divergence lists over 10 years, 7 rolling folds, with pass/fail criteria set before the run. |
| `market_map.json` | Latest export (498 stocks, Nov 2024 – Nov 2026). |
| `web/` | Next.js front end (static) that renders the JSON. See `web/README.md`. |

## What the out-of-sample test found

- Lookalikes that trade apart **do re-couple**: next-year correlation +0.08 beyond matched controls (t 2.8).
- Betting on their prices converging **does not pay**: +0.8% a year (t 0.1), and −8.8% a year with 1-year windows.
- Hidden twins keep about 70% of their extra correlation the following year.

So the map is a co-movement and risk tool, not an alpha source.

## Running the pipeline

Open `market_map.ipynb` in Colab and choose Runtime → Run all. The first run fetches about 500 company descriptions from Yahoo (≈8 min) and caches them in `desc_cache.json`. The cache isn't committed: keep your own copy and upload it to skip the fetch next time. Then copy the exported JSON into the front end with `cd web && npm run sync-data`.

Data: today's S&P 500 members (survivorship bias), with prices and descriptions from Yahoo Finance via yfinance. Not investment advice.
