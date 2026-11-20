"use client";

import { useEffect, useMemo, useState } from "react";
import type { ColorMode, Filters, PresetId, ProData, Selection, View } from "../lib/types";
import { BETA_BINS, DEFAULT_FILTERS, DIVERGENCE_BINS, betaBin, divergenceBin, passes } from "../lib/scales";
import { loadMatrix, loadRawCorr, type PairMatrix } from "../lib/lazy";
import { parsePortfolio } from "../lib/math";
import ProMap from "./ProMap";
import { DiamondKey, FilterBar, Legend, Search, SectorSelect, Segmented } from "./ProControls";
import { RiskCard } from "./RiskCard";
import { PairPanel } from "./PairPanel";
import { Portfolio } from "./Portfolio";
import { ProLists } from "./ProLists";

const STORE = "market-map-pro:portfolio";
const DEFAULT_PIN = "KKR";
const FACTOR_TEXT: Record<PresetId, string> = {
  mkt: "the market (SPY)",
  rates_def: "the market, rates and defensives (SPY, TLT, USMV − SPY)",
  full: "market, rates, defensives, size and value (SPY, TLT, USMV − SPY, IWM, IWD, IWF)",
};

export default function ProApp({ data }: { data: ProData }) {
  const { assets } = data;
  const N = assets.length;
  const index = useMemo(() => new Map(assets.map((a, i) => [a.t, i])), [assets]);
  const known = useMemo(() => new Set(assets.map((a) => a.t)), [assets]);

  const [preset, setPreset] = useState<PresetId>("mkt");
  const [view, setView] = useState<View>("beh");
  const [morph, setMorph] = useState(0);
  const [mode, setMode] = useState<ColorMode>("divergence");
  const [sector, setSector] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [focus, setFocus] = useState<{ s: Selection; morph: number }>(() => ({
    s: index.has(DEFAULT_PIN) ? { kind: "stock", i: index.get(DEFAULT_PIN)! } : null,
    morph: 0,
  }));
  const [hovered, setHovered] = useState<number | null>(null);
  const [pfText, setPfText] = useState("");
  const [mats, setMats] = useState<Partial<Record<PresetId, PairMatrix>>>({});
  const [raw, setRaw] = useState<{ get: (i: number, j: number) => number } | null>(null);
  const [raw1, setRaw1] = useState<{ get: (i: number, j: number) => number } | null>(null);

  const pf = useMemo(() => {
    const p = parsePortfolio(pfText, known);
    return { text: pfText, holdings: p.holdings.map((h) => ({ i: index.get(h.t)!, w: h.w })), unknown: p.unknown, weighted: p.weighted };
  }, [pfText, known, index]);

  const choose = (s: Selection) => {
    setFocus({ s, morph });
    try {
      history.replaceState(null, "", s?.kind === "stock" ? `#${assets[s.i].t}` : location.pathname + location.search);
    } catch {}
  };
  const pickTicker = (t: string) => index.has(t) && choose({ kind: "stock", i: index.get(t)! });
  const pickPair = (a: number, b: number) => choose(a === b ? null : { kind: "pair", a, b });
  const setPortfolio = (t: string) => {
    setPfText(t);
    try {
      localStorage.setItem(STORE, t);
    } catch {}
  };

  // Restore the saved portfolio and any #TICKER deep link; Escape clears the selection.
  useEffect(() => {
    const restore = () => {
      try {
        const saved = localStorage.getItem(STORE);
        if (saved) setPfText(saved);
      } catch {}
      fromHash();
    };
    // #TICKER deep links, on load and when only the hash changes (same behaviour as v1).
    const fromHash = () => {
      const t = decodeURIComponent(location.hash.slice(1)).toUpperCase();
      if (index.has(t)) setFocus((cur) => ({ s: { kind: "stock", i: index.get(t)! }, morph: cur.morph }));
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFocus((cur) => ({ s: null, morph: cur.morph }));
    };
    const id = setTimeout(restore, 0); // not rAF: it never fires in a background tab
    window.addEventListener("keydown", onKey);
    window.addEventListener("hashchange", fromHash);
    return () => {
      clearTimeout(id);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("hashchange", fromHash);
    };
  }, [index]);

  // Lazy data: the preset's pair matrix once anything needs it, the total-return matrix for portfolios.
  const needMatrix = focus.s !== null || pf.holdings.length > 0;
  useEffect(() => {
    if (!needMatrix || mats[preset]) return;
    let live = true;
    loadMatrix(preset, N).then((m) => live && setMats((cur) => ({ ...cur, [preset]: m }))).catch(() => {});
    return () => {
      live = false;
    };
  }, [needMatrix, preset, mats, N]);
  // Total-return correlations: 2 years for the X-ray and hedges, last year for hedge stability.
  useEffect(() => {
    if (!needMatrix || raw) return;
    let live = true;
    loadRawCorr(N, "2y").then((get) => live && setRaw({ get })).catch(() => {});
    return () => {
      live = false;
    };
  }, [needMatrix, raw, N]);
  const needRaw1 = focus.s?.kind === "stock";
  useEffect(() => {
    if (!needRaw1 || raw1) return;
    let live = true;
    loadRawCorr(N, "1y").then((get) => live && setRaw1({ get })).catch(() => {});
    return () => {
      live = false;
    };
  }, [needRaw1, raw1, N]);

  const P = data.data[preset];
  const matrix = mats[preset] ?? null;
  const ok = (i: number) => passes(assets[i], filters);
  const visible = useMemo(() => assets.map((a, i) => passes(a, filters) && P.beh[i] !== null), [assets, filters, P]);

  const sectors = useMemo(() => {
    const n = new Map<string, number>();
    assets.forEach((a) => a.cls === "stock" && n.set(a.sector, (n.get(a.sector) ?? 0) + 1));
    return [...n].map(([name, c]) => ({ name, n: c })).sort((a, b) => a.name.localeCompare(b.name));
  }, [assets]);

  const { fills, order, counts } = useMemo(() => {
    const ids = assets.map((_, i) => i);
    if (mode === "sector") {
      const on = assets.map((a) => a.sector === sector);
      return { fills: on.map((x) => (x ? "var(--accent)" : "var(--pro-point)")), order: ids.sort((a, b) => Number(on[a]) - Number(on[b])), counts: [] };
    }
    if (mode === "beta") {
      const bi = assets.map((a) => betaBin(a.beta));
      return {
        fills: bi.map((b) => BETA_BINS[b].color),
        order: ids.sort((a, b) => bi[b] - bi[a]),
        counts: BETA_BINS.map((_, k) => bi.filter((x, i) => x === k && P.beh[i] !== null).length),
      };
    }
    const bi = assets.map((_, i) => divergenceBin(P.overlap[i]));
    // Draw order uses the Market preset's bins so it doesn't change when the preset does:
    // a DOM node that React moves can't animate, and dots must glide between presets.
    const bm = assets.map((_, i) => divergenceBin(data.data.mkt.overlap[i]));
    const rank = (b: number) => (b === -1 ? 3 : b);
    return {
      fills: bi.map((b) => (b === -1 ? "var(--pro-point)" : DIVERGENCE_BINS[b].color)),
      order: ids.sort((a, b) => rank(bm[b]) - rank(bm[a])),
      counts: DIVERGENCE_BINS.map((_, k) => bi.filter((x) => x === k).length),
    };
  }, [mode, sector, assets, P, data]);

  const s = focus.s;
  const sel = s?.kind === "stock" ? s.i : null;
  const toIdx = (list: [string, ...unknown[]][] | null) =>
    (list ?? []).map(([t]) => index.get(t)).filter((i): i is number => i !== undefined);
  const behNbrs = sel !== null ? toIdx(P.nnBeh[sel]) : [];
  const bizNbrs = sel !== null ? toIdx(data.nnBiz[sel]) : [];
  const pair: [number, number] | null = s?.kind === "pair" ? [s.a, s.b] : null;
  const holdings = useMemo(() => new Set(pf.holdings.map((h) => h.i)), [pf.holdings]);
  const focusSet =
    sel !== null ? new Set([sel, ...behNbrs, ...bizNbrs]) : pair ? new Set(pair) : holdings.size ? holdings : null;
  const presetMeta = data.presets.find((p) => p.id === preset)!;

  const legend =
    mode === "divergence" ? (
      <Legend
        title="Neighbours shared between the maps (of 10)"
        bins={DIVERGENCE_BINS}
        counts={counts}
        note="Brightest orange = trades with a different crowd from the businesses it resembles (0–1 of its 10 trading neighbours also read alike). 4+ shared = consistent, so it fades to grey."
        extra={<DiamondKey />}
      />
    ) : mode === "beta" ? (
      <Legend title="Beta to the S&P 500" bins={BETA_BINS} counts={counts} note="How much the asset typically moves for a 1% market move, over the map window." extra={<DiamondKey />} />
    ) : (
      <p className="text-xs text-ink-3">
        {sector ? `Highlighting ${sector}.` : "Pick a sector to highlight it."} Sectors are GICS. <DiamondKey />
      </p>
    );

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
      <section aria-label="Map" className="min-w-0 lg:sticky lg:top-3 lg:self-start">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <label className="flex items-center gap-2 text-xs text-ink-3">
            Remove
            <Segmented label="Factor preset" value={preset}
              onChange={(v) => {
                if (v === preset) return;
                setPreset(v);
                setMorph((m) => m + 1); // dots glide to the aligned layout; lines wait for them
              }}
              options={data.presets.map((p) => ({ value: p.id, label: p.label }))} />
          </label>
          <label className="flex items-center gap-2 text-xs text-ink-3">
            Map
            <Segmented label="Map" value={view}
              onChange={(v) => {
                if (v === view) return;
                setView(v);
                setMorph((m) => m + 1);
              }}
              options={[{ value: "beh", label: "Behaviour" }, { value: "biz", label: "Business" }]} />
          </label>
          <label className="flex items-center gap-2 text-xs text-ink-3">
            Colour
            <Segmented label="Colour by" value={mode} onChange={setMode}
              options={[{ value: "divergence", label: "Divergence" }, { value: "sector", label: "Sector" }, { value: "beta", label: "Beta" }]} />
          </label>
          {mode === "sector" && <SectorSelect sectors={sectors} value={sector} onChange={setSector} />}
        </div>
        <div className="mt-2">
          <FilterBar filters={filters} onChange={setFilters} shown={visible.filter((v, i) => v && (view === "beh" || P.biz[i] !== null)).length} total={N} />
          {presetMeta.notPlotted.length > 0 && (
            <p className="mt-1 text-xs text-ink-3">{presetMeta.notPlotted.join(", ")} {presetMeta.notPlotted.length === 1 ? "is the factor" : "are factors"} here, so not plotted.</p>
          )}
        </div>
        <p className="mt-2 text-sm text-ink-2">
          {view === "beh"
            ? `Close together = daily moves line up after removing ${FACTOR_TEXT[preset]}.`
            : "Close together = similar business descriptions. Only stocks have one, so the diamonds (ETFs, FX, commodities, bonds, crypto) step out."}
        </p>

        <div className="mx-auto mt-1" style={{ maxWidth: "min(100%, max(360px, calc(100svh - 260px)))" }}>
          <ProMap
            assets={assets}
            view={view}
            beh={P.beh}
            biz={P.biz}
            fills={fills}
            order={order}
            visible={visible}
            focus={focusSet}
            holdings={holdings}
            selected={sel}
            behNbrs={behNbrs}
            bizNbrs={bizNbrs}
            pair={pair}
            hovered={hovered}
            clusterLabels={P.clusters[view].labels}
            linkKey={`${morph}|${sel ?? ""}-${pair?.join("-") ?? ""}`}
            lateLinks={focus.morph !== morph}
            onHover={setHovered}
            onSelect={(i) => choose(i === null || i === sel ? null : { kind: "stock", i })}
            onPickPair={pickPair}
          />
        </div>
        <div className="mt-2">{legend}</div>
        <p className="mt-1 text-xs text-ink-3">
          Zoom with +, a pinch or ⌘/Ctrl + scroll; drag to pan. Click a neighbour line to compare the pair.
        </p>
      </section>

      <aside className="space-y-4" aria-label="Details">
        <Portfolio
          pf={pf}
          onText={setPortfolio}
          assets={assets}
          factorText={FACTOR_TEXT[preset]}
          matrix={matrix}
          rawCorr={raw?.get ?? null}
          sdRes={P.sdRes}
          clusterIds={P.clusters.beh.ids}
          clusterLabels={P.clusters.beh.labels}
          onPickPair={pickPair}
          onPick={pickTicker}
        />
        <Search assets={assets} onPick={pickTicker} />
        {pair ? (
          <PairPanel a={pair[0]} b={pair[1]} assets={assets} preset={preset} presetLabel={presetMeta.label} dates={data.dates}
            matrix={matrix} onPick={pickTicker} onClose={() => choose(null)} />
        ) : sel !== null ? (
          <RiskCard
            i={sel}
            a={assets[sel]}
            presetLabel={presetMeta.label}
            exposureNames={presetMeta.exposures}
            exposure={P.exposure[sel]}
            nnBeh={P.nnBeh[sel]}
            nnBiz={data.nnBiz[sel]}
            firstYear={data.years[0]}
            matrix={matrix}
            raw2={raw?.get ?? null}
            raw1={raw1?.get ?? null}
            assets={assets}
            passes={ok}
            onPick={pickTicker}
            onPickPair={(j) => pickPair(sel, j)}
            onClose={() => choose(null)}
          />
        ) : (
          <section className="rounded-lg border border-line bg-surface-2/60 p-4 text-sm text-ink-2">
            Click a dot for its risk card: factor exposures, who it trades with, what it reads like, and hedges.
            Click a pair in a list, or a neighbour line, to compare two assets.
          </section>
        )}
        <ProLists
          hidden={P.hidden}
          apart={P.apart}
          decouple={P.decouple}
          watch={P.watch}
          tested={P.decoupleTested}
          ok={(t) => index.has(t) && ok(index.get(t)!)}
          active={pair ? { a: assets[pair[0]].t, b: assets[pair[1]].t } : null}
          onPick={(a, b) => pickPair(index.get(a)!, index.get(b)!)}
        />
      </aside>
    </div>
  );
}
