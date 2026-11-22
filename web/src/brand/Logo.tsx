import { HORIZONTAL, HORIZONTAL_PRO } from "./logo-paths";

/**
 * Horizontal Market Map lockup, inline so it needs no request and no font.
 * Drawn in currentColor: give it `text-ink`, which is the brand off-white (#f0efec) on the dark theme
 * and stays visible on the light one. Width and height attributes reserve its box before CSS loads.
 */
export default function Logo({ pro = false, className }: { pro?: boolean; className?: string }) {
  const L = pro ? HORIZONTAL_PRO : HORIZONTAL;
  const label = pro ? "Market Map Pro" : "Market Map";
  return (
    <svg
      viewBox={L.viewBox}
      width={L.width}
      height={L.height}
      role="img"
      aria-label={label}
      className={className}
      fill="currentColor"
    >
      <title>{label}</title>
      <path d={L.mm} />
      <path d={L.word} />
      <line
        x1={L.rule.x1}
        y1={L.rule.y1}
        x2={L.rule.x2}
        y2={L.rule.y2}
        stroke="currentColor"
        strokeWidth={L.rule.strokeWidth}
        strokeOpacity={0.6}
      />
    </svg>
  );
}
