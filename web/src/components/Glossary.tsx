"use client";

import { useEffect, useId, useRef, useState } from "react";
import { GLOSSARY } from "@/lib/plain";

const W = 240;

/** A small "?" that shows a one-sentence plain definition on hover, focus or tap. */
export function Help({ term, text }: { term: string; text?: string }) {
  const def = text ?? GLOSSARY[term];
  const id = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const [pinned, setPinned] = useState(false);

  const show = () => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    setAt({ x: Math.min(Math.max(8, r.left + r.width / 2 - W / 2), window.innerWidth - W - 8), y: r.bottom + 6 });
  };
  const hide = () => {
    setAt(null);
    setPinned(false);
  };

  useEffect(() => {
    if (!at) return;
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Node && !btn.current?.contains(e.target)) hide();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && hide();
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", hide, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", hide);
    };
  }, [at]);

  if (!def) return null;
  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-label={`What is ${term}?`}
        aria-describedby={at ? id : undefined}
        aria-expanded={!!at}
        onMouseEnter={show}
        onMouseLeave={() => !pinned && setAt(null)}
        onFocus={show}
        onBlur={hide}
        onClick={() => {
          if (pinned) hide();
          else {
            show();
            setPinned(true);
          }
        }}
        className="ml-0.5 inline-grid size-4 place-items-center rounded-full border border-line align-[1px] text-[10px] font-medium leading-none text-ink-3 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
      >
        ?
      </button>
      {at && (
        <span
          id={id}
          role="tooltip"
          className="fixed z-50 block rounded-md border border-line bg-surface px-3 py-2 text-left text-xs font-normal normal-case tracking-normal text-ink-2 shadow-md"
          style={{ left: at.x, top: at.y, width: W }}
        >
          {def}
        </span>
      )}
    </>
  );
}

/** The word for the strongest colour step, which is dark blue on the light theme and bright on the dark one. */
export function ThemeWord({ light, dark }: { light: string; dark: string }) {
  return (
    <>
      <span className="dark:hidden">{light}</span>
      <span className="hidden dark:inline">{dark}</span>
    </>
  );
}
