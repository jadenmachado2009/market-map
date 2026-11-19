"use client";

import { useEffect, useMemo, useState } from "react";
import type { ColorMode, MarketMapData, Pair, View } from "@/lib/types";
import { BETA_BINS, DIVERGENCE_BINS, binIndex, capPairs, seq } from "@/lib/scales";
import MapView from "./MapView";
import { BinLegend, Search, SectorSelect, Segmented } from "./Controls";
import { IntroCard, PairCard, PairLists, StockCard, type ListKind } from "./Sidebar";

type Focus = { kind: "stock"; t: string } | { kind: "pair"; list: ListKind; p: Pair } | null;

const VIEW_COPY: Record<View, string> = {
  beh: "Close together = their daily moves line up once the whole market's move is taken out.",
  biz: "Close together = similar company descriptions. Stocks that jump when you switch trade unlike their business.",
};

export default function MarketMap({ data }: { data: MarketMapData }) {
  const { stocks } = data;
  const index = useMemo(() => new Map(stocks.map((s, i) => [s.t, i])), [stocks]);

  const [view, setView] = useState<View>("beh");
  const [morph, setMorph] = useState(0); // bumps on every view toggle
  const [mode, setMode] = useState<ColorMode>("divergence");
  const [sector, setSector] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ f: Focus; morph: number }>({ f: null, morph: 0 });
  const [hovered, setHovered] = useState<number | null>(null);

  const choose = (f: Focus) => {
    setFocus({ f, morph });
    const hash = f?.kind === "stock" ? `#${f.t}` : location.pathname + location.search;
    history.replaceState(null, "", hash);
  };
  const pickTicker = (t: string) => choose({ kind: "stock", t });

  // Deep link (#NVDA) on load; Escape clears the selection.
  useEffect(() => {
    const fromHash = () => {
      const t = decodeURIComponent(location.hash.slice(1)).toUpperCase();
      if (index.has(t)) setFocus((cur) => ({ f: { kind: "stock", t }, morph: cur.morph }));
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setFocus((cur) => ({ f: null, morph: cur.morph }));
      history.replaceState(null, "", location.pathname + location.search);
    };
    const id = requestAnimationFrame(fromHash);
    window.addEventListener("hashchange", fromHash);
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener("hashchange", fromHash);
      window.removeEventListener("keydown", onKey);
    };
  }, [index]);

  const sectors = useMemo(() => {
    const n = new Map<string, number>();
    stocks.forEach((s) => n.set(s.sector, (n.get(s.sector) ?? 0) + 1));
    return [...n].map(([name, count]) => ({ name, n: count })).sort((a, b) => a.name.localeCompare(b.name));
  }, [stocks]);

  const activeSector = sector;
  const { fills, order, counts } = useMemo(() => {
    const ids = stocks.map((_, i) => i);
    if (mode === "sector") {
      const on = stocks.map((s) => s.sector === activeSector);
      return {
        fills: on.map((x) => (x ? "var(--accent)" : "var(--point)")),
        order: ids.sort((a, b) => Number(on[a]) - Number(on[b])),
        counts: [],
      };
    }
    const bins = mode === "beta" ? BETA_BINS : DIVERGENCE_BINS;
    const bi = stocks.map((s) => binIndex(bins, s));
    return {
      fills: bi.map(seq),
      order: ids.sort((a, b) => bi[b] - bi[a]), // strongest colour drawn last
      counts: bins.map((_, k) => bi.filter((x) => x === k).length),
    };
  }, [mode, activeSector, stocks]);

  const lists = useMemo(() => ({ hidden: capPairs(data.hidden), apart: capPairs(data.apart) }), [data]);
  const total = { hidden: data.hidden.length, apart: data.apart.length };

  const f = focus.f;
  const selected = f?.kind === "stock" ? (index.get(f.t) ?? null) : null;
  const sel = selected !== null ? stocks[selected] : null;
  const toIdx = (ns: [string, number][]) =>
    ns.map(([t]) => index.get(t)).filter((i): i is number => i !== undefined);
  const behNbrs = sel ? toIdx(sel.nnBeh) : [];
  const bizNbrs = sel ? toIdx(sel.nnBiz) : [];
  const pair: [number, number] | null = f?.kind === "pair" ? [index.get(f.p.a)!, index.get(f.p.b)!] : null;
  const focusSet = selected !== null ? new Set([selected, ...behNbrs, ...bizNbrs]) : pair ? new Set(pair) : null;

  const legend =
    mode === "divergence" ? (
      <BinLegend
        title="Neighbours shared between the maps (of 10)"
        note="For each stock: of the 10 stocks it trades most like, how many are also among the 10 businesses it most resembles. A stronger colour means it trades with a different crowd from its business peers."
        bins={DIVERGENCE_BINS}
        counts={counts}
      />
    ) : mode === "beta" ? (
      <BinLegend title="Beta to the S&P 500" note="How much the stock typically moves for a 1% market move, over the same window." bins={BETA_BINS} counts={counts} />
    ) : (
      <p className="text-xs text-ink-3">
        {activeSector ? (
          <>
            <span className="mr-1.5 inline-block size-2.5 rounded-full align-middle" style={{ background: "var(--accent)" }} />
            <span className="text-ink-2">{activeSector}</span>{" "}
          </>
        ) : (
          "Pick a sector to highlight it. "
        )}
        Sectors are GICS. Business lines inside one sector often trade apart.
      </p>
    );

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <section aria-label="Map" className="min-w-0 lg:sticky lg:top-3 lg:self-start">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <label className="flex items-center gap-2 text-xs text-ink-3">
            Map
            <Segmented
              label="Map"
              value={view}
              onChange={(v) => {
                if (v === view) return;
                setView(v);
                setMorph((m) => m + 1);
              }}
              options={[
                { value: "beh", label: "Behaviour" },
                { value: "biz", label: "Business" },
              ]}
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-ink-3">
            Colour
            <Segmented
              label="Colour by"
              value={mode}
              onChange={setMode}
              options={[
                { value: "divergence", label: "Divergence" },
                { value: "sector", label: "Sector" },
                { value: "beta", label: "Beta" },
              ]}
            />
          </label>
          {mode === "sector" && <SectorSelect sectors={sectors} value={sector} onChange={setSector} />}
        </div>

        <p className="mt-2 text-sm text-ink-2">{VIEW_COPY[view]}</p>

        <div className="mx-auto mt-2" style={{ maxWidth: "min(100%, max(360px, calc(100svh - 250px)))" }}>
          <MapView
            stocks={stocks}
            view={view}
            fills={fills}
            order={order}
            focus={focusSet}
            selected={selected}
            behNbrs={behNbrs}
            bizNbrs={bizNbrs}
            pair={pair}
            hovered={hovered}
            linkKey={`${morph}-${f?.kind === "stock" ? f.t : f?.kind === "pair" ? `${f.p.a}-${f.p.b}` : ""}`}
            lateLinks={focus.morph !== morph}
            onHover={setHovered}
            onSelect={(i) => choose(i === null || i === selected ? null : { kind: "stock", t: stocks[i].t })}
          />
        </div>
        <div className="mt-3">{legend}</div>
        <p className="mt-1 text-xs text-ink-3">Zoom with the + button, a pinch, or ⌘/Ctrl + scroll. Drag to pan once zoomed in.</p>
      </section>

      <aside className="space-y-4" aria-label="Details">
        <Search stocks={stocks} onPick={pickTicker} />
        {sel ? (
          <StockCard s={sel} onPick={pickTicker} onClose={() => choose(null)} />
        ) : f?.kind === "pair" && pair ? (
          <PairCard pair={f.p} kind={f.list} a={stocks[pair[0]]} b={stocks[pair[1]]} onPick={pickTicker} onClose={() => choose(null)} />
        ) : (
          <IntroCard />
        )}
        <PairLists
          lists={lists}
          total={total}
          active={f?.kind === "pair" ? { kind: f.list, a: f.p.a, b: f.p.b } : null}
          onPick={(list, p) =>
            choose(f?.kind === "pair" && f.list === list && f.p.a === p.a && f.p.b === p.b ? null : { kind: "pair", list, p })
          }
        />
      </aside>
    </div>
  );
}
