"use client";

import { useState } from "react";
import type { Pair, Stock } from "@/lib/types";
import { fmt } from "@/lib/scales";
import { THEME_WHY, overlapWord, pairTheme, sameCompany, shortName, stockSentence, strength, surpriseWord } from "@/lib/plain";
import { Help } from "./Glossary";

export type ListKind = "hidden" | "apart";

export const Card = ({ children }: { children: React.ReactNode }) => (
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

/** "Medium 0.44": the strength word, with the number small and muted beside it. */
const Word = ({ word, v, signed, title }: { word: string; v: number; signed?: boolean; title?: string }) => (
  <span className="whitespace-nowrap tabular-nums" title={title}>
    <span className="text-ink">{word}</span> <span className="text-xs text-ink-3">{fmt(v, signed)}</span>
  </span>
);

export function IntroCard() {
  return (
    <Card>
      <h2 className="text-sm font-semibold text-ink">How to use it</h2>
      <ul className="mt-2 space-y-1.5 text-sm text-ink-2">
        <li>Hover a dot to see who it&apos;s secretly connected to. Click it to pin it.</li>
        <li>
          A pinned company shows who it <span className="text-ink">trades like</span> (solid lines) and who it{" "}
          <span className="text-ink">reads like</span> (dashed lines).
        </li>
        <li>
          Flip between <span className="text-ink">How they trade</span> and <span className="text-ink">What they do</span>.
          The dots that jump are the surprises.
        </li>
      </ul>
    </Card>
  );
}

export function StockCard({ s, by, onPick, onClose }: {
  s: Stock; by: Map<string, Stock>; onPick: (t: string) => void; onClose: () => void;
}) {
  const biz = new Set(s.nnBiz.map(([t]) => t));
  const beh = new Set(s.nnBeh.map(([t]) => t));
  const shared = Math.round(s.overlap * 10);
  const name = shortName(s);
  return (
    <Card>
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold leading-tight text-ink">
            {s.t} <span className="font-normal text-ink-2">{name}</span>
          </h2>
          <p className="text-xs text-ink-3">
            {s.sector} · {s.sub}
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="rounded px-1.5 text-ink-3 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent">
          ✕
        </button>
      </div>
      <p className="mt-2 text-sm text-ink">{stockSentence(s, by)}</p>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
        <div>
          <dt className="text-xs text-ink-3">
            Swinginess
            <Help term="swinginess" />
          </dt>
          <dd className="tabular-nums text-ink">{fmt(s.beta)}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-3">Surprise</dt>
          <dd className="tabular-nums text-ink">
            {surpriseWord(s.overlap)} <span className="text-xs text-ink-3">· {shared} of 10 shared</span>
          </dd>
        </div>
      </dl>
      <div className="mt-4 space-y-4 text-sm">
        <NeighbourList title={`${name} mostly trades like…`} self={s.t} items={s.nnBeh} other={biz} by={by} onPick={onPick} solid />
        <NeighbourList title={`${name} mostly reads like…`} self={s.t} items={s.nnBiz} other={beh} by={by} onPick={onPick} />
      </div>
      <p className="mt-3 text-xs text-ink-3">
        Bold: in both lists. &ldquo;Trades like&rdquo; means the prices move together once whole-market swings are taken out;
        the small number is the correlation
        <Help term="correlation" />. &ldquo;Reads like&rdquo; compares how the companies describe their business
        <Help term="similarity" />.
      </p>
    </Card>
  );
}

function NeighbourList({ title, self, items, other, by, onPick, solid }: {
  title: string; self: string; items: [string, number][]; other: Set<string>; by: Map<string, Stock>;
  onPick: (t: string) => void; solid?: boolean;
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
        {items.map(([t, v]) => {
          const n = by.get(t);
          return (
            <li key={t} className="flex items-baseline gap-2">
              <span className="w-12 shrink-0">
                <TickerButton t={t} onPick={onPick} strong={other.has(t)} />
              </span>
              <span className="min-w-0 flex-1 truncate text-ink-2">
                {n ? shortName(n) : ""}
                {sameCompany(t, self) && <span className="text-ink-3"> (other share class)</span>}
              </span>
              <Word word={strength(v)} v={v} />
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const PAIR_COPY: Record<ListKind, string> = {
  hidden:
    "They run totally different businesses, but their prices move together. Usually there's a hidden link, like a shared cost or customer.",
  apart: "They do similar things, but investors treat them very differently.",
};

export function PairCard({ pair, kind, a, b, onPick, onClose }: {
  pair: Pair; kind: ListKind; a: Stock; b: Stock; onPick: (t: string) => void; onClose: () => void;
}) {
  const theme = kind === "hidden" ? pairTheme(a, b) : null;
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
        {shortName(a)} and {shortName(b)}: {PAIR_COPY[kind].charAt(0).toLowerCase() + PAIR_COPY[kind].slice(1)}
      </p>
      {theme && (
        <p className="mt-2 text-sm text-ink-2">
          <span className="font-medium text-ink">Why: {theme}.</span> {THEME_WHY[theme] ?? ""}
        </p>
      )}
      <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
        <div>
          <dt className="text-xs text-ink-3">
            Move together
            <Help term="correlation" />
          </dt>
          <dd>
            <Word word={strength(pair.corr)} v={pair.corr} />
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-3">
            Business overlap
            <Help term="similarity" />
          </dt>
          <dd>
            <Word word={overlapWord(pair.sim)} v={pair.sim} signed />
          </dd>
        </div>
      </dl>
      <ul className="mt-3 space-y-1 text-sm">
        {[a, b].map((s) => (
          <li key={s.t}>
            <TickerButton t={s.t} onPick={onPick} strong /> <span className="text-ink-2">{shortName(s)}</span>{" "}
            <span className="text-xs text-ink-3">· {s.sub}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

const LIST_COPY: Record<ListKind, { tab: string; blurb: string }> = {
  hidden: { tab: "Secret twins", blurb: PAIR_COPY.hidden },
  apart: { tab: "Same business, different paths", blurb: PAIR_COPY.apart },
};

export function PairLists({ lists, total, by, active, onPick }: {
  lists: Record<ListKind, Pair[]>;
  total: Record<ListKind, number>;
  by: Map<string, Stock>;
  active: { kind: ListKind; a: string; b: string } | null;
  onPick: (kind: ListKind, p: Pair) => void;
}) {
  const [tab, setTab] = useState<ListKind>("hidden");
  const rows = lists[tab];
  return (
    <Card>
      <div role="tablist" aria-label="Pair lists" className="flex gap-4 border-b border-line text-sm">
        {(Object.keys(LIST_COPY) as ListKind[]).map((k) => (
          <button
            key={k}
            role="tab"
            type="button"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={`-mb-px border-b-2 pb-2 text-left focus-visible:outline-2 focus-visible:outline-accent ${
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
            <th className="pb-1 font-normal">{tab === "hidden" ? "Pair and why" : "Pair"}</th>
            <th className="pb-1 text-right font-normal">Move together</th>
            <th className="pb-1 text-right font-normal">Business overlap</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const on = active?.kind === tab && active.a === p.a && active.b === p.b;
            const A = by.get(p.a), B = by.get(p.b);
            const theme = tab === "hidden" && A && B ? pairTheme(A, B) : null;
            return (
              <tr key={`${p.a}-${p.b}`} className={on ? "bg-surface" : ""}>
                <td className="py-0.5 align-top">
                  <button
                    type="button"
                    onClick={() => onPick(tab, p)}
                    aria-pressed={on}
                    aria-label={`${p.a} and ${p.b}`}
                    className={`text-left hover:underline focus-visible:outline-2 focus-visible:outline-accent ${on ? "font-semibold text-ink" : "text-ink"}`}
                  >
                    {p.a} <span className="text-ink-3">↔</span> {p.b}
                  </button>
                  {theme && (
                    <span className="block text-xs text-ink-3" title={THEME_WHY[theme]}>
                      {theme}
                    </span>
                  )}
                </td>
                <td className="py-0.5 text-right align-top">
                  <Word word={strength(p.corr)} v={p.corr} />
                </td>
                <td className="py-0.5 text-right align-top">
                  <Word word={overlapWord(p.sim)} v={p.sim} signed />
                </td>
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
