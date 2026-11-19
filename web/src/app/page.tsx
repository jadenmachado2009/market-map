import raw from "@/data/market_map.json";
import type { MarketMapData } from "@/lib/types";
import MarketMap from "@/components/MarketMap";

const data = raw as unknown as MarketMapData;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
};

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-[1440px] px-4 pb-16 pt-6 sm:px-6 lg:px-8">
      <header className="mb-4">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Market Map</h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-2">
          The S&amp;P 500 laid out two ways: by how each stock trades, and by what each company does. The interesting
          stocks are the ones that move when you switch.
        </p>
        <p className="mt-1 text-xs tabular-nums text-ink-3">
          {data.stocks.length} stocks · daily prices {day(data.start)} – {day(data.asof)} · market (SPY) removed ·{" "}
          <a href="/pro" className="font-medium text-accent hover:underline">
            Try Pro →
          </a>
        </p>
      </header>

      <MarketMap data={data} />

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
    </section>
  );
}
