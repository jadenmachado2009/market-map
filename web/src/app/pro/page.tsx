import type { Metadata } from "next";
import Link from "next/link";
import raw from "@/data-pro/market_map_v2.json";
import type { ProData } from "@/pro/lib/types";
import ProApp from "@/pro/components/ProApp";
import "@/pro/pro.css";

const data = raw as unknown as ProData;

export const metadata: Metadata = {
  title: "Market Map Pro: see what your portfolio is really betting on",
  description:
    "Paste your holdings and see how many independent bets they really are, what they share, and what hedges them. S&P 500 plus ETFs, FX, commodities, bonds and crypto.",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
};

export default function ProPage() {
  const stocks = data.assets.filter((a) => a.cls === "stock").length;
  return (
    <main className="pro-root mx-auto w-full max-w-[1480px] px-4 pb-16 pt-6 sm:px-6 lg:px-8">
      <header className="mb-4">
        <p className="text-xs font-medium uppercase tracking-wider text-ink-3">
          Market Map Pro ·{" "}
          <Link href="/" className="normal-case tracking-normal text-ink-2 hover:text-ink hover:underline">
            ← Classic map
          </Link>
        </p>
        <h1 className="mt-0.5 text-2xl font-semibold tracking-tight text-ink">See what your portfolio is really betting on.</h1>
        <p className="mt-1 text-xs tabular-nums text-ink-3">
          Updated nightly · as of {day(data.asof)} · {stocks} S&amp;P 500 stocks + {data.assets.length - stocks} ETFs, currencies,
          commodities, bonds and crypto · prices since {day(data.start)}
        </p>
      </header>

      <ProApp data={data} />

      <section aria-labelledby="how" className="mt-14 border-t border-line pt-8">
        <h2 id="how" className="text-lg font-semibold text-ink">How to read this</h2>
        <div className="mt-4 grid gap-8 text-sm text-ink-2 md:grid-cols-3">
          <div className="space-y-2">
            <h3 className="font-medium text-ink">Residual correlation</h3>
            <p>
              Each asset&apos;s daily return is regressed on the chosen factors, and the leftover is its own behaviour.
              Daily leftovers are clipped at ±5 standard deviations, so one earnings day can&apos;t create a link.
              &ldquo;Held 9/11y&rdquo; means the correlation was 0.3 or higher in 9 of the 11 calendar years since 2016.
            </p>
          </div>
          <div className="space-y-2">
            <h3 className="font-medium text-ink">Business similarity</h3>
            <p>
              Company descriptions ({data.textSource === "edgar" ? "Item 1 of the latest 10-K, from SEC EDGAR" : "Yahoo Finance business summaries"})
              are embedded with a small local model, after removing names, boilerplate and the average description.
              It&apos;s shown as a percentile: 99th means more similar than 99% of stock pairs.
            </p>
          </div>
          <div className="space-y-2">
            <h3 className="font-medium text-ink">Risk tool, not a signal</h3>
            <p>
              In out-of-sample tests, correlation structure persisted: hidden twins kept about 70% of their extra correlation
              the following year. Betting on lookalike prices converging did not pay. Use this to see concentration and
              hedges, not to find trades.
            </p>
          </div>
        </div>
        <p className="mt-8 text-xs text-ink-3">
          Data: today&apos;s S&amp;P 500 members (Wikipedia), so it has survivorship bias. Prices from Yahoo Finance via
          yfinance; share counts from SEC EDGAR. Not investment advice.
        </p>
      </section>
    </main>
  );
}
