import type { Metadata } from "next";
import raw from "@/data/market_map.json";
import type { MarketMapData } from "@/lib/types";
import { buildStories, companyCount } from "@/lib/plain";
import MarketMap from "@/components/MarketMap";
import { Help } from "@/components/Glossary";
import TourLink from "@/components/TourLink";
import Logo from "@/brand/Logo";

const data = raw as unknown as MarketMapData;
// Checked against the data at build time: a story whose pattern no longer holds is left out.
const stories = buildStories(data);

const TITLE = "Market Map: which stocks are secretly connected";
const DESCRIPTION =
  "495 big US companies grouped two ways: by what they do, and by how their share prices actually move. Where the two disagree, things get interesting.";
const OG_IMAGE = { url: "/brand/og-classic.png", width: 1200, height: 630, alt: "Market Map: which stocks are secretly connected?" };

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: { type: "website", url: "/", siteName: "Market Map", title: TITLE, description: DESCRIPTION, images: [OG_IMAGE] },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: [OG_IMAGE] },
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
};

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-[1440px] px-4 pb-16 pt-6 sm:px-6 lg:px-8">
      <header className="mb-4">
        <h1 className="text-ink">
          <Logo className="block h-6 w-auto sm:h-8" />
        </h1>
        <p className="mt-1 text-lg text-ink">Which stocks are secretly connected?</p>
        <p className="mt-1 max-w-3xl text-sm text-ink-2">
          We grouped {companyCount(data.stocks)} big US companies two ways: by what they do, and by how their share prices
          actually move. Where the two disagree, things get interesting.
        </p>
        <p className="mt-1 text-xs tabular-nums text-ink-3">
          S&amp;P 500
          <Help term="S&P 500" /> members · daily prices {day(data.start)} – {day(data.asof)} · whole-market swings removed
          using SPY, an ETF
          <Help term="ETF" /> · <TourLink /> ·{" "}
          <a href="/about" className="font-medium text-accent hover:underline">
            About this project
          </a>{" "}
          ·{" "}
          <a href="/pro" className="font-medium text-accent hover:underline">
            Try Pro →
          </a>
        </p>
      </header>

      <MarketMap data={data} stories={stories} />

      <About />
    </main>
  );
}

function About() {
  return (
    <section aria-labelledby="about" className="mt-14 border-t border-line pt-8">
      <h2 id="about" className="text-lg font-semibold text-ink">
        How to read this
      </h2>
      <div className="mt-4 grid gap-4 text-sm text-ink-2 md:grid-cols-3">
        <div className="space-y-2 rounded-lg border border-line bg-surface-2/60 p-4">
          <h3 className="font-medium text-ink">What am I looking at?</h3>
          <p>
            Each dot is one company. In <span className="text-ink">How they trade</span>, two dots sit close when their
            share prices tend to rise and fall on the same days. In <span className="text-ink">What they do</span>, they
            sit close when the companies describe their businesses in similar words.
          </p>
          <p>Flip between the two. The dots that jump the furthest are the surprises.</p>
        </div>
        <div className="space-y-2 rounded-lg border border-line bg-surface-2/60 p-4">
          <h3 className="font-medium text-ink">Why remove the whole market?</h3>
          <p>
            A rising tide lifts all boats. On a good day for the market almost every stock goes up, and that tells you
            nothing about which companies are really linked.
          </p>
          <p>
            So we first take out each stock&apos;s usual reaction to the whole market, then compare what&apos;s left.
            Two stocks that still move together share something of their own.
          </p>
        </div>
        <div className="space-y-2 rounded-lg border border-line bg-surface-2/60 p-4">
          <h3 className="font-medium text-ink">Can I make money with this?</h3>
          <p>
            Probably not directly. We tested it, and betting on lookalikes converging didn&apos;t pay. But it&apos;s great
            for spotting when your &ldquo;different&rdquo; stocks are secretly the same bet.
          </p>
        </div>
      </div>
      <p className="mt-6 text-xs text-ink-3">
        Prices and company descriptions come from Yahoo Finance. Not investment advice.
      </p>

      <details className="group mt-8 border-t border-line pt-6">
        <summary className="cursor-pointer list-none text-sm font-medium text-ink hover:underline focus-visible:outline-2 focus-visible:outline-accent">
          <span className="mr-1.5 inline-block text-ink-3 transition-transform group-open:rotate-90">›</span>
          For the nerds
        </summary>
        <div className="mt-4 grid gap-8 text-sm text-ink-2 md:grid-cols-3">
          <div className="space-y-2">
            <h3 className="font-medium text-ink">Behaviour map</h3>
            <p>
              Each stock&apos;s daily return is regressed on the S&amp;P 500 (SPY), and what&apos;s left over is the
              stock&apos;s own behaviour. Stocks whose leftovers move together are placed close together, using UMAP on
              the distance √(2(1 − ρ)).
            </p>
            <p>
              A 2-D map has to squeeze 500 dimensions into two. Neighbourhoods are reliable. The distance between two
              far-apart clusters isn&apos;t, so trust the neighbour lists over the gaps.
            </p>
          </div>
          <div className="space-y-2">
            <h3 className="font-medium text-ink">Business map</h3>
            <p>
              Company descriptions are embedded with a small local language model (all-MiniLM-L6-v2). Company names and
              &ldquo;headquartered in&rdquo; boilerplate are removed first; otherwise Constellation Energy and
              Constellation Brands look like twins.
            </p>
            <p>
              Similarity is cosine similarity after removing the average description. 0 is a typical pair, and 0.4+ is
              close.
            </p>
          </div>
          <div className="space-y-2">
            <h3 className="font-medium text-ink">Is this a trading signal? No.</h3>
            <p>
              The two lists were tested out of sample: 7 rolling folds from 2016 to 2026, each building the lists on two
              years of data and measuring the following year.
            </p>
            <ul className="list-disc space-y-1 pl-4">
              <li>
                Lookalikes trading apart <span className="text-ink">did</span> re-couple: +0.08 correlation beyond
                matched controls.
              </li>
              <li>
                Betting on their prices converging <span className="text-ink">did not</span> pay: +0.8% a year, not
                significant. With 1-year windows it lost 8.8% a year.
              </li>
              <li>Hidden twins kept about 70% of their extra correlation the following year.</li>
            </ul>
            <p>Use it to spot hidden concentration risk, not mispricings.</p>
          </div>
        </div>
        <p className="mt-8 text-xs text-ink-3">
          Data: today&apos;s S&amp;P 500 members (Wikipedia), so it has survivorship bias. Prices and descriptions are
          from Yahoo Finance via yfinance. Not investment advice.
        </p>
      </details>
    </section>
  );
}
