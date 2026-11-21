"use client";

export const TOUR_EVENT = "market-map:tour";

/** "Take the tour": replays the first-visit walkthrough. */
export default function TourLink() {
  return (
    <button
      type="button"
      onClick={() => {
        window.scrollTo({ top: 0, behavior: "smooth" });
        window.dispatchEvent(new Event(TOUR_EVENT));
      }}
      className="font-medium text-accent hover:underline focus-visible:outline-2 focus-visible:outline-accent"
    >
      Take the tour
    </button>
  );
}
