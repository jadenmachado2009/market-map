"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ColorMode, MarketMapData, Pair, View } from "@/lib/types";
import { BETA_BINS, DIVERGENCE_BINS, binIndex, capPairs, seq } from "@/lib/scales";
import { GLOSSARY, stockSentence, type Story } from "@/lib/plain";
import MapView from "./MapView";
import { BinLegend, Search, SectorSelect, Segmented, SurpriseLegend } from "./Controls";
import { IntroCard, PairCard, PairLists, StockCard, type ListKind } from "./Sidebar";
import { Help } from "./Glossary";
import { StoryCaption, StoryChips } from "./Stories";
import { TOUR_EVENT } from "./TourLink";
import { TOUR_STEPS, TourCard, markTourSeen, ringIf, tourSeen } from "./Tour";

type Focus = { kind: "stock"; t: string } | { kind: "pair"; list: ListKind; p: Pair } | null;

const VIEW_COPY: Record<View, string> = {
  beh: "Close together = their prices tend to move together, even after ignoring whole-market swings.",
  biz: "Close together = they describe their businesses in similar words.",
};

export default function MarketMap({ data, stories }: { data: MarketMapData; stories: Story[] }) {
  const { stocks } = data;
  const index = useMemo(() => new Map(stocks.map((s, i) => [s.t, i])), [stocks]);
  const by = useMemo(() => new Map(stocks.map((s) => [s.t, s])), [stocks]);
  const sentences = useMemo(() => stocks.map((s) => stockSentence(s, by)), [stocks, by]);

  const [view, setView] = useState<View>("beh");
  const [morph, setMorph] = useState(0); // bumps on every view toggle
  const [mode, setMode] = useState<ColorMode>("divergence");
  const [sector, setSector] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ f: Focus; morph: number }>({ f: null, morph: 0 });
  const [hovered, setHovered] = useState<number | null>(null);
  const [story, setStory] = useState<Story | null>(null);
  const [zoomSignal, setZoomSignal] = useState(0);
  const [tour, setTour] = useState<number | null>(null);

  const mapRef = useRef<HTMLDivElement>(null);
  const switchRef = useRef<HTMLLabelElement>(null);
  const legendRef = useRef<HTMLDivElement>(null);

  const switchView = (v: View) => {
    if (v === view) return;
    setView(v);
    setMorph((m) => m + 1);
    if (tour === 2) setTour(3); // the tour asked for exactly this
  };

  const choose = (f: Focus, fromStory: Story | null = null) => {
    setFocus({ f, morph });
    setStory(fromStory);
    const hash = f?.kind === "stock" ? `#${f.t}` : location.pathname + location.search;
    history.replaceState(null, "", hash);
  };
  const pickTicker = (t: string) => choose({ kind: "stock", t });

  const openStory = (s: Story | null) => {
    if (!s) return choose(null);
    if (view !== "beh") {
      setView("beh");
      setMorph((m) => m + 1);
    }
    choose(s.focus.kind === "stock" ? s.focus : { kind: "pair", list: "hidden", p: s.focus.p }, s);
    setZoomSignal((z) => z + 1);
  };

  // Deep link (#NVDA) on load; Escape clears the selection and closes the tour.
  useEffect(() => {
    const fromHash = () => {
      const t = decodeURIComponent(location.hash.slice(1)).toUpperCase();
      if (index.has(t)) setFocus((cur) => ({ f: { kind: "stock", t }, morph: cur.morph }));
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setFocus((cur) => ({ f: null, morph: cur.morph }));
      setStory(null);
      setTour(null);
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

  // First visit: start the tour once. "Take the tour" replays it.
  useEffect(() => {
    const start = () => setTour(0);
    const id = requestAnimationFrame(() => {
      if (!tourSeen()) {
        markTourSeen();
        start();
      }
    });
    window.addEventListener(TOUR_EVENT, start);
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener(TOUR_EVENT, start);
    };
  }, []);

  const target = tour === null ? null : TOUR_STEPS[tour].target;
  useEffect(() => {
    const el = target === "map" ? mapRef.current : target === "switch" ? switchRef.current : target === "legend" ? legendRef.current : null;
    if (!el) return;
    // Scroll only when the target is out of sight (or hidden under the tour card at the bottom).
    const r = el.getBoundingClientRect();
    const visible = target === "map" ? r.top >= 0 && r.top < innerHeight * 0.5 : r.top >= 0 && r.bottom <= innerHeight - 170;
    if (!visible) el.scrollIntoView({ block: target === "map" ? "start" : "center", behavior: "smooth" });
  }, [target, tour]);

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
      <SurpriseLegend counts={counts} />
    ) : mode === "beta" ? (
      <BinLegend
        title={
          <>
            Swinginess
            <Help term="swinginess" />
          </>
        }
        note={GLOSSARY.swinginess}
        bins={BETA_BINS}
        counts={counts}
      />
    ) : (
      <p className="text-xs text-ink-3">
        {activeSector ? (
          <>
            <span className="mr-1.5 inline-block size-2.5 rounded-full align-middle" style={{ background: "var(--accent)" }} />
            <span className="text-ink-2">{activeSector}</span>{" "}
          </>
        ) : (
          "Pick an industry to highlight it. "
        )}
        These are the 11 official sectors
        <Help term="sector" />. Companies in the same one often trade quite differently.
      </p>
    );

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <section aria-label="Map" className="min-w-0 lg:sticky lg:top-3 lg:self-start">
        <StoryChips stories={stories} active={story?.id ?? null} onPick={openStory} />
        {story && (
          <div className="lg:hidden">
            <StoryCaption story={story} onClose={() => choose(null)} />
          </div>
        )}

        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <label ref={switchRef} className={`flex items-center gap-2 text-xs text-ink-3 ${ringIf(target === "switch")}`}>
            Map
            <Segmented
              label="Map"
              value={view}
              onChange={switchView}
              options={[
                { value: "beh", label: "How they trade" },
                { value: "biz", label: "What they do" },
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
                { value: "divergence", label: "Surprise" },
                { value: "sector", label: "Industry" },
                { value: "beta", label: "Swinginess", title: GLOSSARY.swinginess },
              ]}
            />
          </label>
          {mode === "sector" && <SectorSelect sectors={sectors} value={sector} onChange={setSector} />}
        </div>

        <p className="mt-2 text-sm text-ink-2">{VIEW_COPY[view]}</p>

        <div
          ref={mapRef}
          className={`mx-auto mt-2 ${ringIf(target === "map")}`}
          style={{ maxWidth: "min(100%, max(360px, calc(100svh - 290px)))" }}
        >
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
            onSelect={(i) => {
              if (i !== null && tour === TOUR_STEPS.length - 1) setTour(null); // "Click one." done
              choose(i === null || i === selected ? null : { kind: "stock", t: stocks[i].t });
            }}
            describe={(i) => sentences[i]}
            zoomSignal={zoomSignal}
          />
        </div>
        <div ref={legendRef} className={`mt-3 ${ringIf(target === "legend")}`}>
          {legend}
        </div>
        <p className="mt-1 text-xs text-ink-3">Zoom with the + button, a pinch, or ⌘/Ctrl + scroll. Drag to pan once zoomed in.</p>
      </section>

      <aside className="space-y-4" aria-label="Details">
        {story && (
          <div className="hidden lg:block">
            <StoryCaption story={story} onClose={() => choose(null)} />
          </div>
        )}
        <Search stocks={stocks} onPick={pickTicker} />
        {sel ? (
          <StockCard s={sel} by={by} onPick={pickTicker} onClose={() => choose(null)} />
        ) : f?.kind === "pair" && pair ? (
          <PairCard pair={f.p} kind={f.list} a={stocks[pair[0]]} b={stocks[pair[1]]} onPick={pickTicker} onClose={() => choose(null)} />
        ) : (
          <IntroCard />
        )}
        <PairLists
          lists={lists}
          total={total}
          by={by}
          active={f?.kind === "pair" ? { kind: f.list, a: f.p.a, b: f.p.b } : null}
          onPick={(list, p) =>
            choose(f?.kind === "pair" && f.list === list && f.p.a === p.a && f.p.b === p.b ? null : { kind: "pair", list, p })
          }
        />
      </aside>

      {tour !== null && <TourCard step={tour} onNext={() => setTour((s) => (s === null ? null : s + 1))} onClose={() => setTour(null)} />}
    </div>
  );
}
