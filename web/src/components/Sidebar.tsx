"use client";

import { useState } from "react";
import type { Pair, Stock } from "@/lib/types";
import { fmt } from "@/lib/scales";

export type ListKind = "hidden" | "apart";

const Card = ({ children }: { children: React.ReactNode }) => (
  <section className="rounded-lg border border-line bg-surface-2/60 p-4">{children}</section>
);

const TickerButton = ({ t, onPick, strong }: { t: string; onPick: (t: string) => void; strong?: boolean }) => (
  <button
    type="button"
    onClick={() => onPick(t)}
    className={`underline decoration-line underline-offset-2 hover:decoration-ink-2 focus-visible:outline-2 focus-visible:outline-accent ${strong ? "font-semibold text-ink" : "text-ink"}`}
  >
    {t}
  </button>
);

export function IntroCard() {
  return (
    <Card>
      <h2 className="text-sm font-semibold text-ink">How to use it</h2>
      <ul className="mt-2 space-y-1.5 text-sm text-ink-2">
        <li>Hover a dot for details. Click it to pin the stock.</li>
        <li>
          Pinned stocks show who they <span className="text-ink">trade with</span> (solid lines) and who they{" "}
          <span className="text-ink">read like</span> (dashed lines).
        </li>
        <li>Switch between Behaviour and Business to see which stocks move.</li>
      </ul>
    </Card>
  );
}

export function StockCard({ s, onPick, onClose }: { s: Stock; onPick: (t: string) => void; onClose: () => void }) {
  const biz = new Set(s.nnBiz.map(([t]) => t));
  const beh = new Set(s.nnBeh.map(([t]) => t));
  const shared = Math.round(s.overlap * 10);
  return (
    <Card>
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold leading-tight text-ink">
            {s.t} <span className="font-normal text-ink-2">{s.name}</span>
          </h2>
          <p className="text-xs text-ink-3">
            {s.sector} · {s.sub}
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="rounded px-1.5 text-ink-3 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent">
          ✕
        </button>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
        <div>
          <dt className="text-xs text-ink-3">Beta to S&amp;P 500</dt>
          <dd className="tabular-nums text-ink">{fmt(s.beta)}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-3">Neighbours shared</dt>
          <dd className="tabular-nums text-ink">
            {shared} of 10 <span className="text-xs text-ink-3">{shared <= 1 ? "· divergent" : shared >= 6 ? "· consistent" : ""}</span>
          </dd>
        </div>
      </dl>
      <div className="mt-4 grid grid-cols-2 gap-4 text-sm">
        <NeighbourList title="Trades with" hint="corr" items={s.nnBeh} other={biz} onPick={onPick} solid />
        <NeighbourList title="Reads like" hint="text sim" items={s.nnBiz} other={beh} onPick={onPick} />
      </div>
      <p className="mt-3 text-xs text-ink-3">Bold: in both lists. Correlation is of daily moves after removing the market.</p>
    </Card>
  );
}

function NeighbourList({ title, hint, items, other, onPick, solid }: {
  title: string; hint: string; items: [string, number][]; other: Set<string>; onPick: (t: string) => void; solid?: boolean;
}) {
  return (
    <div>
      <h3 className="mb-1 flex items-center gap-1.5 text-xs font-medium text-ink-2">
        <svg width="18" height="6" aria-hidden="true">
          <line x1="1" y1="3" x2="17" y2="3" stroke={solid ? "var(--ink-2)" : "var(--ink-3)"} strokeWidth={solid ? 1.75 : 1.25} strokeDasharray={solid ? undefined : "3 3"} />
        </svg>
        {title}
      </h3>
      <ol className="space-y-0.5">
        {items.map(([t, v]) => (
          <li key={t} className="flex justify-between tabular-nums">
            <TickerButton t={t} onPick={onPick} strong={other.has(t)} />
            <span className="text-ink-2" title={hint}>{fmt(v)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function PairCard({ pair, kind, a, b, onPick, onClose }: {
  pair: Pair; kind: ListKind; a: Stock; b: Stock; onPick: (t: string) => void; onClose: () => void;
}) {
  return (
    <Card>
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-lg font-semibold text-ink">
          {pair.a} <span className="text-ink-3">↔</span> {pair.b}
        </h2>
        <button type="button" onClick={onClose} aria-label="Close" className="rounded px-1.5 text-ink-3 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent">
          ✕
        </button>
      </div>
      <p className="mt-1 text-sm text-ink-2">
        {kind === "hidden"
          ? "These two trade together, but their business descriptions are unrelated. That points to a shared exposure the descriptions don't mention."
          : "These two read alike but don't trade together. Usually one is priced on a different story, e.g. AI power demand vs a regulated utility."}
      </p>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
        <div>
          <dt className="text-xs text-ink-3">Correlation (market removed)</dt>
          <dd className="tabular-nums text-ink">{fmt(pair.corr)}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-3">Description similarity</dt>
          <dd className="tabular-nums text-ink">{fmt(pair.sim, true)}</dd>
        </div>
      </dl>
      <ul className="mt-3 space-y-1 text-sm">
        {[a, b].map((s) => (
          <li key={s.t}>
            <TickerButton t={s.t} onPick={onPick} strong /> <span className="text-ink-2">{s.name}</span>{" "}
            <span className="text-xs text-ink-3">· {s.sub}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

const LIST_COPY: Record<ListKind, { tab: string; blurb: string }> = {
  hidden: {
    tab: "Hidden twins",
    blurb:
      "Among the 1% most correlated pairs, the ones with the least similar businesses. In out-of-sample tests they kept about 70% of their extra correlation the following year, so most of it is a real shared exposure.",
  },
  apart: {
    tab: "Lookalikes trading apart",
    blurb:
      "Among the 1% most similar businesses, the pairs with the lowest correlation. Out of sample they partly re-couple, but betting on their prices converging lost money. Treat this as a risk signal, not a trade.",
  },
};

export function PairLists({ lists, total, active, onPick }: {
  lists: Record<ListKind, Pair[]>;
  total: Record<ListKind, number>;
  active: { kind: ListKind; a: string; b: string } | null;
  onPick: (kind: ListKind, p: Pair) => void;
}) {
  const [tab, setTab] = useState<ListKind>("hidden");
  const rows = lists[tab];
  return (
    <Card>
      <div role="tablist" aria-label="Divergence lists" className="flex gap-4 border-b border-line text-sm">
        {(Object.keys(LIST_COPY) as ListKind[]).map((k) => (
          <button
            key={k}
            role="tab"
            type="button"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={`-mb-px border-b-2 pb-2 focus-visible:outline-2 focus-visible:outline-accent ${
              tab === k ? "border-ink font-medium text-ink" : "border-transparent text-ink-2 hover:text-ink"
            }`}
          >
            {LIST_COPY[k].tab}
          </button>
        ))}
      </div>
      <p className="mt-3 text-xs text-ink-2">{LIST_COPY[tab].blurb}</p>
      <table className="mt-3 w-full text-sm tabular-nums">
        <thead>
          <tr className="text-left text-xs text-ink-3">
            <th className="pb-1 font-normal">Pair</th>
            <th className="pb-1 text-right font-normal">Corr</th>
            <th className="pb-1 text-right font-normal">Text sim</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const on = active?.kind === tab && active.a === p.a && active.b === p.b;
            return (
              <tr key={`${p.a}-${p.b}`} className={on ? "bg-surface" : ""}>
                <td className="py-0.5">
                  <button
                    type="button"
                    onClick={() => onPick(tab, p)}
                    aria-pressed={on}
                    aria-label={`${p.a} and ${p.b}`}
                    className={`text-left hover:underline focus-visible:outline-2 focus-visible:outline-accent ${on ? "font-semibold text-ink" : "text-ink"}`}
                  >
                    {p.a} <span className="text-ink-3">↔</span> {p.b}
                  </button>
                </td>
                <td className="py-0.5 text-right text-ink-2">{fmt(p.corr)}</td>
                <td className="py-0.5 text-right text-ink-2">{fmt(p.sim, true)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-ink-3">
        Showing {rows.length} of {total[tab]} pairs, at most 2 per stock.
      </p>
    </Card>
  );
}
