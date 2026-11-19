"use client";

// Copied from v1 components/MapView.tsx and extended for Pro.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Asset, ClusterLabel, Pt, View } from "../lib/types";
import { fmt, money } from "../lib/scales";

const SIZE = 1000;
const HALF = SIZE / 2;
const HIT_PX = 14;
const LINE_HIT_PX = 6;

type XY = readonly [number, number];
const project = ([x, y]: Pt): XY => [HALF + HALF * x, HALF - HALF * y];
const translate = ([x, y]: XY) => `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;

type VB = { x: number; y: number; w: number };
const FULL: VB = { x: 0, y: 0, w: SIZE };
const MIN_W = SIZE / 14;
const clampVb = (x: number, y: number, w: number): VB => {
  const ww = Math.min(SIZE, Math.max(MIN_W, w));
  return { w: ww, x: Math.min(SIZE - ww, Math.max(0, x)), y: Math.min(SIZE - ww, Math.max(0, y)) };
};
const zoomed = (v: VB, fx: number, fy: number, f: number): VB => {
  const w = Math.min(SIZE, Math.max(MIN_W, v.w * f));
  return clampVb(v.x + fx * v.w - fx * w, v.y + fy * v.w - fy * w, w);
};
/** Square view around a set of points with 5% padding on each side. */
const fitTo = (pts: XY[]): VB => {
  if (!pts.length) return FULL;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const span = Math.max(x1 - x0, y1 - y0) / 0.9;
  return clampVb((x0 + x1) / 2 - span / 2, (y0 + y1) / 2 - span / 2, span);
};

export type ProMapProps = {
  assets: Asset[];
  view: View;
  beh: (Pt | null)[];
  biz: (Pt | null)[];
  fills: string[];
  order: number[];
  visible: boolean[];
  focus: Set<number> | null;
  holdings: Set<number>;
  selected: number | null;
  behNbrs: number[];
  bizNbrs: number[];
  pair: [number, number] | null;
  hovered: number | null;
  clusterLabels: ClusterLabel[];
  linkKey: string;
  lateLinks: boolean;
  onHover: (i: number | null) => void;
  onSelect: (i: number | null) => void;
  onPickPair: (a: number, b: number) => void;
};

export default function ProMap(p: ProMapProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(800);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);

  // Behaviour position for everything; business position where the asset has one (stocks).
  const pos = useMemo(
    () => p.assets.map((_, i) => project((p.view === "biz" ? p.biz[i] : null) ?? p.beh[i] ?? [0, 0])),
    [p.assets, p.view, p.beh, p.biz],
  );
  const placed = (i: number) => (p.view === "biz" ? p.biz[i] !== null : p.beh[i] !== null);
  const shown = (i: number) => placed(i) && p.visible[i];

  // Initial view: the data, both layouts, with 5% padding (the parent remounts this per preset).
  const fit = useMemo(() => {
    const pts: XY[] = [];
    p.assets.forEach((_, i) => {
      if (p.beh[i]) pts.push(project(p.beh[i]!));
      if (p.biz[i]) pts.push(project(p.biz[i]!));
    });
    return fitTo(pts);
  }, [p.assets, p.beh, p.biz]);
  const [vb, setVb] = useState<VB>(fit);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width || 800));
    ro.observe(el);
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

  const k = vb.w / width;
  const isZoomed = vb.w < fit.w - 1;
  const sel = p.selected;

  const toUnits = (e: React.PointerEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    return [vb.x + ((e.clientX - r.left) / r.width) * vb.w, vb.y + ((e.clientY - r.top) / r.height) * vb.w] as const;
  };
  const pick = (e: React.PointerEvent) => {
    const [x, y] = toUnits(e);
    let best: number | null = null;
    let bestD = (HIT_PX * k) ** 2;
    pos.forEach(([px, py], i) => {
      if (!shown(i)) return;
      const d = (px - x) ** 2 + (py - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  };
  // A click near a neighbour line opens that pair.
  const pickLine = (e: React.PointerEvent): number | null => {
    if (sel === null) return null;
    const [x, y] = toUnits(e);
    const [ax, ay] = pos[sel];
    let best: number | null = null;
    let bestD = LINE_HIT_PX * k;
    for (const j of new Set([...p.behNbrs, ...p.bizNbrs])) {
      if (!shown(j)) continue;
      const [bx, by] = pos[j];
      const L2 = (bx - ax) ** 2 + (by - ay) ** 2 || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / L2));
      const d = Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay)));
      if (d < bestD) {
        bestD = d;
        best = j;
      }
    }
    return best;
  };

  const r = 3.6 * k;
  const isMain = (i: number) => i === sel || (p.pair?.includes(i) ?? false);
  const quiet = sel === null && p.pair === null;
  const labelled = [
    ...new Set([
      ...(sel !== null ? [sel, ...p.behNbrs, ...p.bizNbrs] : []),
      ...(p.pair ?? []),
      ...(quiet ? [...p.holdings] : []),
    ]),
  ].filter(shown);
  const { labels, taken } = placeLabels(labelled, pos, (i) => p.assets[i].t, isMain, k, vb);
  const clusterLabels = placeClusterLabels(p.clusterLabels, k, vb, taken);

  const fitFocus = () => {
    const ids = p.pair ?? (sel !== null ? [sel, ...(p.view === "beh" ? p.behNbrs : p.bizNbrs)] : [...p.holdings]);
    const pts = ids.filter(shown).map((i) => pos[i]);
    if (!pts.length) return;
    const v = fitTo(pts);
    setVb(clampVb(v.x - v.w * 0.15, v.y - v.w * 0.15, Math.max(v.w * 1.3, 90)));
  };

  const mark = (i: number, rad: number, fill: string, stroke: string, sw: number) =>
    p.assets[i].cls === "stock" ? (
      <circle r={rad} style={{ fill }} stroke={stroke} strokeWidth={sw} />
    ) : (
      <path d={`M0 ${-rad * 1.35}L${rad * 1.35} 0L0 ${rad * 1.35}L${-rad * 1.35} 0Z`} style={{ fill }} stroke={stroke} strokeWidth={sw} />
    );

  const h = p.hovered !== null && shown(p.hovered) ? p.hovered : null;

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.w}`}
        className={`block h-auto w-full select-none ${isZoomed ? "cursor-grab active:cursor-grabbing" : "cursor-crosshair"}`}
        style={{ touchAction: isZoomed ? "none" : "auto" }}
        role="img"
        aria-label={`Map of ${p.assets.length} assets, ${p.view === "beh" ? "behaviour" : "business"} view`}
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
          if (!d || d.moved) return;
          const i = pick(e);
          if (i !== null) return p.onSelect(i);
          const j = pickLine(e);
          if (j !== null && sel !== null) return p.onPickPair(sel, j);
          p.onSelect(null);
        }}
        onPointerCancel={() => (drag.current = null)}
        onPointerLeave={() => p.onHover(null)}
      >
        <g>
          {p.order.map((i) => (
            <g
              key={p.assets[i].t}
              className="ppt"
              style={{
                transform: translate(pos[i]),
                opacity: !shown(i) ? 0 : p.focus && !p.focus.has(i) ? 0.26 : 1,
                pointerEvents: "none",
              }}
            >
              {mark(i, r, p.fills[i], "var(--surface)", 0.9 * k)}
            </g>
          ))}
        </g>

        <g key={`c-${p.view}-${p.linkKey.split("|")[0]}`} className={p.lateLinks ? "plinks late" : "plinks"} pointerEvents="none">
          {clusterLabels.map((c) => (
            <text key={c.id} x={c.x} y={c.y} fontSize={c.size} textAnchor="middle" fontWeight={600}
              className="phalo pclabel" style={{ fill: "var(--ink-3)", strokeWidth: 3 * k, opacity: p.focus ? 0.55 : 0.9 }}>
              {c.text}
            </text>
          ))}
        </g>

        {sel !== null && shown(sel) && (
          <g key={`n-${p.linkKey}`} className={p.lateLinks ? "plinks late" : "plinks"} strokeLinecap="round" pointerEvents="none">
            {p.bizNbrs.filter(shown).map((j) => (
              <line key={`z${j}`} x1={pos[sel][0]} y1={pos[sel][1]} x2={pos[j][0]} y2={pos[j][1]}
                stroke="var(--ink-3)" strokeWidth={1.25 * k} strokeDasharray={`${4 * k} ${4 * k}`} />
            ))}
            {p.behNbrs.filter(shown).map((j) => (
              <line key={`b${j}`} x1={pos[sel][0]} y1={pos[sel][1]} x2={pos[j][0]} y2={pos[j][1]}
                stroke="var(--ink-2)" strokeWidth={1.75 * k} />
            ))}
          </g>
        )}
        {p.pair && shown(p.pair[0]) && shown(p.pair[1]) && (
          <g key={`p-${p.linkKey}`} className={p.lateLinks ? "plinks late" : "plinks"} pointerEvents="none">
            <line x1={pos[p.pair[0]][0]} y1={pos[p.pair[0]][1]} x2={pos[p.pair[1]][0]} y2={pos[p.pair[1]][1]}
              stroke="var(--ink)" strokeWidth={2 * k} />
          </g>
        )}

        <g pointerEvents="none">
          {[...p.holdings].filter(shown).map((i) => (
            <g key={`h-${p.assets[i].t}`} className="ppt" style={{ transform: translate(pos[i]) }}>
              <circle r={r * 2.1} fill="none" stroke="var(--ink)" strokeWidth={1.25 * k} />
            </g>
          ))}
          {labelled.map((i) => {
            const main = isMain(i);
            const lab = labels.get(i);
            return (
              <g key={`l-${p.assets[i].t}`} className="ppt" style={{ transform: translate(pos[i]) }}>
                {mark(i, main ? r * 1.7 : r * 1.25, p.fills[i], main ? "var(--ink)" : "var(--surface)", (main ? 2 : 1.25) * k)}
                {lab && (
                  <text x={lab.dx} y={lab.dy} fontSize={lab.size} fontWeight={main ? 600 : 500}
                    className="phalo" style={{ fill: "var(--ink)", strokeWidth: 3.5 * k }}>
                    {p.assets[i].t}
                  </text>
                )}
              </g>
            );
          })}
        </g>

        {h !== null && (
          <g className="ppt" style={{ transform: translate(pos[h]) }} pointerEvents="none">
            <circle r={r * 2} fill="none" stroke="var(--ink)" strokeWidth={1.5 * k} />
          </g>
        )}
      </svg>

      {h !== null && <Tooltip a={p.assets[h]} x={(pos[h][0] - vb.x) / k} y={(pos[h][1] - vb.y) / k} width={width} />}

      <div className="absolute right-1 top-1 flex flex-col gap-1">
        <ZoomButton label="Zoom in" onClick={() => setVb((v) => zoomed(v, 0.5, 0.5, 1 / 1.6))}>+</ZoomButton>
        <ZoomButton label="Zoom out" onClick={() => setVb((v) => zoomed(v, 0.5, 0.5, 1.6))} disabled={vb.w >= SIZE}>−</ZoomButton>
        {(sel !== null || p.pair || p.holdings.size > 0) && <ZoomButton label="Zoom to selection" onClick={fitFocus}>⤢</ZoomButton>}
        {isZoomed && <ZoomButton label="Reset zoom" onClick={() => setVb(fit)}>↺</ZoomButton>}
      </div>
    </div>
  );
}

type Box = [number, number, number, number];
const overlaps = (a: Box, b: Box) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
const inside = (b: Box, vb: VB) => b[0] >= vb.x && b[1] >= vb.y && b[2] <= vb.x + vb.w && b[3] <= vb.y + vb.w;

// Greedy label placement (same idea as v1): 8 candidate spots per dot, first one that collides
// with nothing placed so far wins; labels that fit nowhere are dropped (the panel lists them).
function placeLabels(ids: number[], pos: XY[], text: (i: number) => string, isMain: (i: number) => boolean, k: number, vb: VB) {
  const taken: Box[] = ids.map((i) => {
    const d = (isMain(i) ? 7 : 5) * k;
    return [pos[i][0] - d, pos[i][1] - d, pos[i][0] + d, pos[i][1] + d];
  });
  const labels = new Map<number, { dx: number; dy: number; size: number }>();
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
      if (!inside(box, vb) || taken.some((t) => overlaps(t, box))) continue;
      taken.push(box);
      labels.set(i, { dx: bx - x, dy: by - y + hgt * 0.8, size });
      break;
    }
  }
  return { labels, taken };
}

// Cluster names sit at the cluster centre; bigger clusters claim their spot first, and a name
// that would collide (or fall off-screen) is skipped. Constant on-screen size at every zoom.
function placeClusterLabels(cl: ClusterLabel[], k: number, vb: VB, taken: Box[]) {
  const out: { id: number; x: number; y: number; size: number; text: string }[] = [];
  const boxes = [...taken];
  const used = new Set<string>(); // two clusters with the same name: label only the bigger one
  for (const c of [...cl].sort((a, b) => b.n - a.n)) {
    if (used.has(c.label)) continue;
    const [x, y] = project([c.x, c.y]);
    const text = c.label.length > 34 ? c.label.slice(0, 32) + "…" : c.label;
    const size = 9.5 * k;
    const w = 0.66 * size * text.length;
    const box: Box = [x - w / 2, y - size, x + w / 2, y + size * 0.3];
    if (!inside(box, vb) || boxes.some((b) => overlaps(b, box))) continue;
    boxes.push(box);
    used.add(c.label);
    out.push({ id: c.id, x, y, size, text });
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

function Tooltip({ a, x, y, width }: { a: Asset; x: number; y: number; width: number }) {
  const W = 240;
  const left = x + 16 + W > width ? x - 16 - W : x + 16;
  return (
    <div
      className="pointer-events-none absolute z-10 rounded-md border border-line bg-surface px-3 py-2 text-xs shadow-md"
      style={{ left, top: Math.max(0, y - 36), width: W }}
      role="tooltip"
    >
      <div className="text-sm font-semibold text-ink">
        {a.t} <span className="font-normal text-ink-2">{a.name}</span>
      </div>
      <div className="text-ink-3">{a.cls === "stock" ? `${a.sector} · ${a.sub}` : a.sector}</div>
      <div className="mt-1.5 flex flex-wrap gap-x-4 tabular-nums text-ink-2">
        {a.cls === "stock" && <span>{money(a.mcap)}</span>}
        <span>vol {a.vol === null ? "–" : `${Math.round(a.vol * 100)}%`}</span>
        <span>β {fmt(a.beta)}</span>
      </div>
    </div>
  );
}
