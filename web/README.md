# Market Map: web front end

A static Next.js 16 page that renders `src/data/market_map.json`, the output of `../market_map.ipynb`.

```bash
npm install
npm run dev        # http://localhost:3000
npm run build      # fully static: / is prerendered
```

## Updating the data

1. Re-run `../market_map.ipynb` in Colab (upload `../desc_cache.json` to skip the description calls) and download `market_map.json` into `..`.
2. `npm run sync-data` copies it into `src/data/`.
3. Rebuild or redeploy.

The 2-D layout reshuffles on every rerun: UMAP is sensitive to small changes in Yahoo's data. Neighbour lists and pair lists are stable.

## What's where

- `src/app/page.tsx`: page shell and the "How to read this" section (server component).
- `src/components/MarketMap.tsx`: state, controls and layout.
- `src/components/MapView.tsx`: the SVG map. Points glide between layouts via CSS transform transitions. Also handles zoom/pan and label placement.
- `src/components/Sidebar.tsx`: stock and pair cards, and the two divergence lists (capped at 2 appearances per ticker).
- `src/lib/scales.ts`: colour bins for divergence and beta.

## Framing

The out-of-sample test (`../oos_test.ipynb`) found that the divergence lists predict co-movement, not prices. The copy presents them as a risk view. Keep it that way unless a new test says otherwise.

## Deploy

On Vercel, set the project root to `web/`. No environment variables are needed.
