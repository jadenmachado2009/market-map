"use client";

import { ThemeWord } from "./Glossary";

export const TOUR_KEY = "market-map-tour-seen";

// localStorage can throw (private modes, blocked storage). Unknown counts as seen, so nobody gets the tour on every visit.
export function tourSeen(): boolean {
  try {
    return window.localStorage.getItem(TOUR_KEY) === "1";
  } catch {
    return true;
  }
}
export function markTourSeen() {
  try {
    window.localStorage.setItem(TOUR_KEY, "1");
  } catch {
    // nothing to do: the tour simply may show again
  }
}

export type TourTarget = "map" | "switch" | "legend";

export const TOUR_STEPS: { target: TourTarget; text: React.ReactNode }[] = [
  { target: "map", text: "Each dot is a company." },
  { target: "map", text: "Close dots move together." },
  { target: "switch", text: "Flip this switch to see what they actually do." },
  {
    target: "legend",
    text: (
      <>
        <ThemeWord light="Dark blue" dark="Bright" /> dots are the surprises. Click one.
      </>
    ),
  },
];

/** The highlight ring around the element the current step points at. */
export const ringIf = (on: boolean) => (on ? "rounded-md outline-2 outline-offset-4 outline-accent" : "");

export function TourCard({ step, onNext, onClose }: { step: number; onNext: () => void; onClose: () => void }) {
  const last = step === TOUR_STEPS.length - 1;
  return (
    <div
      role="dialog"
      aria-label="Quick tour"
      className="fixed inset-x-3 bottom-3 z-40 mx-auto max-w-sm rounded-lg border border-line bg-surface p-4 shadow-md lg:left-auto lg:right-6 lg:mx-0 lg:w-[340px]"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs tabular-nums text-ink-3">
          Quick tour · {step + 1} of {TOUR_STEPS.length}
        </p>
        <button type="button" onClick={onClose} aria-label="Close tour" className="rounded px-1.5 text-ink-3 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent">
          ✕
        </button>
      </div>
      <p className="mt-1 text-base font-medium text-ink">{TOUR_STEPS[step].text}</p>
      <div className="mt-3 flex items-center justify-between">
        <button type="button" onClick={onClose} className="text-sm text-ink-3 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent">
          Skip
        </button>
        <button
          type="button"
          onClick={last ? onClose : onNext}
          className="rounded-md border border-line bg-surface-2 px-3 py-1 text-sm font-medium text-ink shadow-sm hover:bg-surface focus-visible:outline-2 focus-visible:outline-accent"
        >
          {last ? "Got it" : "Next"}
        </button>
      </div>
    </div>
  );
}
