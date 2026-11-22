import type { Metadata } from "next";
import Link from "next/link";
import Logo from "@/brand/Logo";

/**
 * Who built this, why, and what the testing showed. Written for someone with a minute to spare
 * (an admissions reader, a banker following a link), so it leads with the story, not the method.
 *
 * Fill these in to show them. Empty values are left out, and the page reads fine without them.
 */
const AUTHOR_NAME = ""; // e.g. "Alex Tan"
const LINKEDIN_URL = ""; // e.g. "https://www.linkedin.com/in/..."
const VIDEO_URL = ""; // a short walkthrough in your own voice, e.g. an unlisted YouTube link

const TITLE = "About Market Map";
const DESCRIPTION =
  "Who built Market Map, why, and what happened when the original trading idea was tested on seven years of data it had never seen.";
const OG_IMAGE = { url: "/brand/og-classic.png", width: 1200, height: 630, alt: "Market Map: which stocks are secretly connected?" };

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: { type: "website", url: "/about", siteName: "Market Map", title: TITLE, description: DESCRIPTION, images: [OG_IMAGE] },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: [OG_IMAGE] },
};

const link = "font-medium text-accent hover:underline focus-visible:outline-2 focus-visible:outline-accent";

export default function About() {
  const who = AUTHOR_NAME ? `${AUTHOR_NAME}, a Grade 12 student` : "a Grade 12 student";
  return (
    <main className="mx-auto w-full max-w-2xl px-4 pb-16 pt-6 sm:px-6">
      <header>
        <Link href="/" className="inline-block text-ink" aria-label="Market Map home">
          <Logo className="block h-6 w-auto sm:h-8" />
        </Link>
        <h1 className="mt-6 text-2xl font-semibold tracking-tight text-ink">About this project</h1>
        <p className="mt-2 text-base text-ink-2">
          Built in November 2026 by {who}, to answer one question: are stocks that look like different bets really
          different?
        </p>
        {VIDEO_URL && (
          <p className="mt-3 text-sm">
            <a href={VIDEO_URL} className={link} target="_blank" rel="noopener noreferrer">
              Watch the 90-second walkthrough →
            </a>
          </p>
        )}
      </header>

      <div className="mt-10 space-y-10 text-[15px] leading-relaxed text-ink-2">
        <section aria-labelledby="why" className="space-y-3">
          <h2 id="why" className="text-lg font-semibold text-ink">
            Why I built it
          </h2>
          <p>
            Owning nine stocks feels like nine bets. Often it isn&apos;t: some companies&apos; shares move together for
            reasons their businesses don&apos;t explain, like a shared customer or a shared cost. I wanted to see those
            links, so I grouped every big US company twice, once by what it does and once by how its shares actually
            move, and looked at where the two disagree.
          </p>
        </section>

        <section aria-labelledby="failed" className="space-y-3">
          <h2 id="failed" className="text-lg font-semibold text-ink">
            The test that failed
          </h2>
          <p>
            My first idea was a trade: when two similar businesses drift apart in price, bet that they come back
            together. Before testing it, I wrote down what would count as a pass. Then I tested it on data it had never
            seen, one year at a time, for seven years.
          </p>
          <ul className="list-disc space-y-1.5 pl-5">
            <li>
              It earned <span className="font-medium text-ink">0.8% a year</span>, which can&apos;t be told apart from
              zero.
            </li>
            <li>
              With shorter look-back windows it <span className="font-medium text-ink">lost 8.8% a year</span>: the
              laggards kept lagging.
            </li>
            <li>
              What did hold up: stocks that trade together kept{" "}
              <span className="font-medium text-ink">about 70%</span> of that link the following year.
            </li>
          </ul>
          <p>
            So I stopped calling it a signal and rebuilt it as a risk tool.{" "}
            <Link href="/pro" className={link}>
              Pro
            </Link>
            , the second version, takes your holdings and shows how many independent bets they really add up to, which
            ones carry the risk, and what would hedge each one.
          </p>
        </section>

        <section aria-labelledby="how" className="space-y-3">
          <h2 id="how" className="text-lg font-semibold text-ink">
            How it was made
          </h2>
          <p>
            AI coding agents wrote most of the code. My part was deciding what to build, setting the tests, and checking
            the results. When something looked wrong, I treated it as a bug, not a finding. For example, when I switched
            to companies&apos; annual reports, two grain traders, ADM and Bunge, suddenly looked unrelated. The cause was
            the wrong section of each filing being read, and the site now keeps whichever text source scores better.
          </p>
          <p>
            Pro rebuilds itself every night from Yahoo Finance prices and SEC filings, and more than 70 automated tests
            check the maths.
          </p>
        </section>

        <section aria-labelledby="limits" className="space-y-3">
          <h2 id="limits" className="text-lg font-semibold text-ink">
            What it can&apos;t tell you
          </h2>
          <ul className="list-disc space-y-1.5 pl-5">
            <li>
              It uses today&apos;s S&amp;P 500 members, so companies that dropped out of the index are missing. That
              flatters any backtest.
            </li>
            <li>Prices come from free data, not the professional feeds banks use.</li>
            <li>
              Hedges are measured on the same two years they&apos;re fitted on, so real-world results will be weaker.
            </li>
          </ul>
        </section>

        {LINKEDIN_URL && (
          <section aria-labelledby="contact" className="space-y-3">
            <h2 id="contact" className="text-lg font-semibold text-ink">
              Tell me what&apos;s wrong with it
            </h2>
            <p>
              If you work with portfolio risk or company comparisons, I&apos;d like to hear what&apos;s missing.{" "}
              <a href={LINKEDIN_URL} className={link} target="_blank" rel="noopener noreferrer">
                Message me on LinkedIn →
              </a>
            </p>
          </section>
        )}
      </div>

      <nav aria-label="Pages" className="mt-12 flex flex-wrap gap-x-6 gap-y-2 border-t border-line pt-6 text-sm">
        <Link href="/" className={link}>
          ← Classic map
        </Link>
        <Link href="/pro" className={link}>
          Market Map Pro →
        </Link>
      </nav>
      <p className="mt-4 text-xs text-ink-3">Not investment advice.</p>
    </main>
  );
}
