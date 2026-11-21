"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Stock, View } from "@/lib/types";
import { fmt } from "@/lib/scales";
import { shortName, surpriseWord } from "@/lib/plain";

const SIZE = 1000; // viewBox units
const PAD = 40;
const HALF = (SIZE - 2 * PAD) / 2;
const HIT_PX = 14; // hover/click radius in screen pixels, bigger than the dot

type Pt = readonly [number, number];
const project = ([x, y]: [number, number]): Pt => [SIZE / 2 + HALF * x, SIZE / 2 - HALF * y];
const translate = ([x, y]: Pt) => `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;

// Square viewBox used for zoom/pan, kept inside the full map.
type VB = { x: number; y: number; w: number };
const FULL: VB = { x: 0, y: 0, w: SIZE };
const MIN_W = SIZE / 12;
const clampVb = (x: number, y: number, w: number): VB => {
  const ww = Math.min(SIZE, Math.max(MIN_W, w));
  return { w: ww, x: Math.min(SIZE - ww, Math.max(0, x)), y: Math.min(SIZE - ww, Math.max(0, y)) };
};
// Zoom by `factor` (<1 zooms in) keeping the point at fractions (fx, fy) of the view fixed.
const zoomed = (v: VB, fx: number, fy: number, factor: number): VB => {
  const w = Math.min(SIZE, Math.max(MIN_W, v.w * factor));
  return clampVb(v.x + fx * v.w - fx * w, v.y + fy * v.w - fy * w, w);
};

export type MapViewProps = {
  stocks: Stock[];
  view: View;
  fills: string[]; // per stock index
  order: number[]; // draw order, strongest last
  focus: Set<number> | null; // when set, everything else is dimmed
  selected: number | null;
  behNbrs: number[];
  bizNbrs: number[];
  pair: [number, number] | null;
  hovered: number | null;
  linkKey: string; // changes when the neighbour lines must be redrawn
  lateLinks: boolean; // true right after a view toggle: wait for the points to land
  onHover: (i: number | null) => void;
  onSelect: (i: number | null) => void;
  describe: (i: number) => string; // one plain sentence for the hover card
  zoomSignal: number; // bump to frame the current selection (story chips)
};

export default function MapView(p: MapViewProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(800);
  const [vb, setVb] = useState<VB>(FULL);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width || 800));
    ro.observe(el);
    // Pinch, or Ctrl/⌘ + scroll, zooms around the cursor. Plain scrolling still scrolls the page.
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const dy = Math.max(-50, Math.min(50, e.deltaY));
      setVb((v) => zoomed(v, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, Math.exp(dy * 0.01)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      ro.disconnect();
      el.removeEventListener("wheel", onWheel);
    };
  }, []);

  const pos = useMemo(() => p.stocks.map((s) => project(p.view === "beh" ? s.beh : s.biz)), [p.stocks, p.view]);
  const k = vb.w / width; // viewBox units per screen pixel
  const isZoomed = vb.w < SIZE;

  const pick = (e: React.PointerEvent | React.MouseEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    const x = vb.x + ((e.clientX - r.left) / r.width) * vb.w;
    const y = vb.y + ((e.clientY - r.top) / r.height) * vb.w;
    let best: number | null = null;
    let bestD = (HIT_PX * k) ** 2;
    pos.forEach(([px, py], i) => {
      const d = (px - x) ** 2 + (py - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  };

  const sel = p.selected;
  const r = 3.8 * k;
  const h = p.hovered;
  const isMain = (i: number) => i === sel || (p.pair?.includes(i) ?? false);
  // Priority order: the pinned stock or pair first, then trades-with, then reads-like.
  const labelled = [...new Set([...(sel !== null ? [sel, ...p.behNbrs, ...p.bizNbrs] : []), ...(p.pair ?? [])])];
  const labels = placeLabels(labelled, pos, (i) => p.stocks[i].t, isMain, k, vb);

  // Frame the pinned stock with the neighbours that belong to this view (or the pinned pair).
  const fitFocus = () => {
    const ids = p.pair ?? (sel !== null ? [sel, ...(p.view === "beh" ? p.behNbrs : p.bizNbrs)] : []);
    if (!ids.length) return;
    const pts = ids.map((i) => pos[i]);
    const xs = pts.map((q) => q[0]);
    const ys = pts.map((q) => q[1]);
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    const w = span * 1.35 + 60;
    setVb(clampVb((Math.min(...xs) + Math.max(...xs)) / 2 - w / 2, (Math.min(...ys) + Math.max(...ys)) / 2 - w / 2, w));
  };
  const fitRef = useRef(fitFocus);
  useEffect(() => {
    fitRef.current = fitFocus; // runs before the zoom effect below, in the same commit
  });
  useEffect(() => {
    if (p.zoomSignal) fitRef.current();
  }, [p.zoomSignal]);

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.w}`}
        className={`block h-auto w-full select-none ${isZoomed ? "cursor-grab active:cursor-grabbing" : "cursor-crosshair"}`}
        style={{ touchAction: isZoomed ? "none" : "auto" }}
        role="img"
        aria-label={`Map of ${p.stocks.length} S&P 500 stocks, placed by ${p.view === "beh" ? "how they trade" : "what they do"}`}
        onPointerDown={(e) => {
          drag.current = { x: e.clientX, y: e.clientY, vx: vb.x, vy: vb.y, moved: false };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d && e.buttons) {
            const dx = e.clientX - d.x;
            const dy = e.clientY - d.y;
            if (!d.moved && Math.hypot(dx, dy) > 4) {
              d.moved = true;
              svgRef.current?.setPointerCapture(e.pointerId);
            }
            if (d.moved) {
              if (isZoomed) setVb((v) => clampVb(d.vx - dx * k, d.vy - dy * k, v.w));
              p.onHover(null);
              return;
            }
          }
          p.onHover(pick(e));
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (d && !d.moved) p.onSelect(pick(e));
        }}
        onPointerCancel={() => (drag.current = null)}
        onPointerLeave={() => p.onHover(null)}
      >
        <g>
          {p.order.map((i) => (
            <g
              key={p.stocks[i].t}
              className="pt"
              style={{ transform: translate(pos[i]), opacity: p.focus && !p.focus.has(i) ? 0.2 : 1 }}
            >
              <circle r={r} style={{ fill: p.fills[i] }} stroke="var(--surface)" strokeWidth={1 * k} />
            </g>
          ))}
        </g>

        {sel !== null && (
          <g key={`n-${p.linkKey}`} className={p.lateLinks ? "links late" : "links"} strokeLinecap="round">
            {p.bizNbrs.map((j) => (
              <line key={`z${j}`} x1={pos[sel][0]} y1={pos[sel][1]} x2={pos[j][0]} y2={pos[j][1]}
                stroke="var(--ink-3)" strokeWidth={1.25 * k} strokeDasharray={`${4 * k} ${4 * k}`} />
            ))}
            {p.behNbrs.map((j) => (
              <line key={`b${j}`} x1={pos[sel][0]} y1={pos[sel][1]} x2={pos[j][0]} y2={pos[j][1]}
                stroke="var(--ink-2)" strokeWidth={1.75 * k} />
            ))}
          </g>
        )}
        {p.pair && (
          <g key={`p-${p.linkKey}`} className={p.lateLinks ? "links late" : "links"}>
            <line x1={pos[p.pair[0]][0]} y1={pos[p.pair[0]][1]} x2={pos[p.pair[1]][0]} y2={pos[p.pair[1]][1]}
              stroke="var(--ink-2)" strokeWidth={1.75 * k} />
          </g>
        )}

        <g>
          {labelled.map((i) => {
            const main = isMain(i);
            const lab = labels.get(i);
            return (
              <g key={`l-${p.stocks[i].t}`} className="pt" style={{ transform: translate(pos[i]) }}>
                <circle r={main ? r * 1.7 : r * 1.25} style={{ fill: p.fills[i] }}
                  stroke={main ? "var(--ink)" : "var(--surface)"} strokeWidth={(main ? 2 : 1.25) * k} />
                {lab && (
                  <text x={lab.dx} y={lab.dy} fontSize={lab.size} fontWeight={main ? 600 : 500}
                    className="halo" style={{ fill: "var(--ink)", strokeWidth: 3.5 * k }}>
                    {p.stocks[i].t}
                  </text>
                )}
              </g>
            );
          })}
        </g>

        {h !== null && (
          <g className="pt" style={{ transform: translate(pos[h]) }} pointerEvents="none">
            <circle r={r * 2} fill="none" stroke="var(--ink)" strokeWidth={1.5 * k} />
          </g>
        )}
      </svg>

      {h !== null && (
        <Tooltip stock={p.stocks[h]} text={p.describe(h)} x={(pos[h][0] - vb.x) / k} y={(pos[h][1] - vb.y) / k} width={width} />
      )}

      <div className="absolute right-1 top-1 flex flex-col gap-1">
        <ZoomButton label="Zoom in" onClick={() => setVb((v) => zoomed(v, 0.5, 0.5, 1 / 1.6))}>+</ZoomButton>
        <ZoomButton label="Zoom out" onClick={() => setVb((v) => zoomed(v, 0.5, 0.5, 1.6))} disabled={!isZoomed}>−</ZoomButton>
        {p.focus && <ZoomButton label="Zoom to selection" onClick={fitFocus}>⤢</ZoomButton>}
        {isZoomed && <ZoomButton label="Reset zoom" onClick={() => setVb(FULL)}>↺</ZoomButton>}
      </div>
    </div>
  );
}

type Box = [number, number, number, number];
const overlaps = (a: Box, b: Box) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

// Greedy label placement: try 8 spots around each dot, take the first that hits no earlier label
// or labelled dot, and drop the label if none fits (the sidebar still lists every neighbour).
function placeLabels(ids: number[], pos: Pt[], text: (i: number) => string, isMain: (i: number) => boolean, k: number, vb: VB) {
  const taken: Box[] = ids.map((i) => {
    const d = (isMain(i) ? 7 : 5) * k;
    return [pos[i][0] - d, pos[i][1] - d, pos[i][0] + d, pos[i][1] + d];
  });
  const out = new Map<number, { dx: number; dy: number; size: number }>();
  for (const i of ids) {
    const size = (isMain(i) ? 13 : 11.5) * k;
    const w = 0.62 * size * text(i).length + 2 * k;
    const hgt = size;
    const g = (isMain(i) ? 9 : 7) * k;
    const [x, y] = pos[i];
    const spots: [number, number][] = [
      [x + g, y - hgt / 2], [x - g - w, y - hgt / 2], [x - w / 2, y - g - hgt], [x - w / 2, y + g],
      [x + g * 0.8, y - g * 0.8 - hgt], [x + g * 0.8, y + g * 0.8], [x - g * 0.8 - w, y - g * 0.8 - hgt], [x - g * 0.8 - w, y + g * 0.8],
    ];
    for (const [bx, by] of spots) {
      const box: Box = [bx, by, bx + w, by + hgt];
      if (bx < vb.x || by < vb.y || bx + w > vb.x + vb.w || by + hgt > vb.y + vb.w) continue;
      if (taken.some((t) => overlaps(t, box))) continue;
      taken.push(box);
      out.set(i, { dx: bx - x, dy: by - y + hgt * 0.8, size });
      break;
    }
  }
  return out;
}

function ZoomButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="grid size-7 place-items-center rounded-md border border-line bg-surface text-sm text-ink-2 shadow-sm hover:text-ink disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-accent"
    >
      {children}
    </button>
  );
}

function Tooltip({ stock, text, x, y, width }: { stock: Stock; text: string; x: number; y: number; width: number }) {
  const W = Math.min(264, width - 8);
  const left = Math.max(0, x + 16 + W > width ? x - 16 - W : x + 16);
  const top = Math.max(0, y - 36);
  return (
    <div
      className="pointer-events-none absolute z-10 rounded-md border border-line bg-surface px-3 py-2 text-xs shadow-md"
      style={{ left, top, width: W }}
      role="tooltip"
    >
      <div className="text-sm font-semibold text-ink">
        {stock.t} <span className="font-normal text-ink-2">{shortName(stock)}</span>
      </div>
      <div className="text-ink-3">
        {stock.sector} · {stock.sub}
      </div>
      <p className="mt-1.5 text-ink">{text}</p>
      <div className="mt-1.5 flex gap-4 tabular-nums text-ink-2">
        <span>Swinginess {fmt(stock.beta)}</span>
        <span>Surprise: {surpriseWord(stock.overlap)}</span>
      </div>
    </div>
  );
}
