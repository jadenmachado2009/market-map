"use client";

import type { Story } from "@/lib/plain";

/** "Start here" chips: each pins a stock or pair, zooms to it and shows a two-sentence caption. */
export function StoryChips({ stories, active, onPick }: {
  stories: Story[];
  active: string | null;
  onPick: (s: Story | null) => void;
}) {
  if (!stories.length) return null;
  return (
    <div className="mb-3 flex items-center gap-2">
      <span className="shrink-0 text-xs text-ink-3">Start here</span>
      <div className="-my-1 flex min-w-0 gap-2 overflow-x-auto py-1" role="group" aria-label="Start here stories">
        {stories.map((s) => (
          <button
            key={s.id}
            type="button"
            aria-pressed={active === s.id}
            onClick={() => onPick(active === s.id ? null : s)}
            className={`shrink-0 whitespace-nowrap rounded-md border px-3 py-1 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-accent ${
              active === s.id
                ? "border-ink-3 bg-surface font-medium text-ink shadow-sm"
                : "border-line bg-surface-2 text-ink-2 hover:text-ink"
            }`}
          >
            {s.title}
          </button>
        ))}
      </div>
    </div>
  );
}

export function StoryCaption({ story, onClose }: { story: Story; onClose: () => void }) {
  return (
    <section aria-live="polite" className="mb-3 rounded-lg lg:mb-0 border border-line bg-surface-2/60 p-4">
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">{story.title}</h2>
        <button type="button" onClick={onClose} aria-label="Close story" className="rounded px-1.5 text-ink-3 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent">
          ✕
        </button>
      </div>
      <p className="mt-1 text-sm text-ink-2">{story.caption}</p>
    </section>
  );
}
