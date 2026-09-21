import { DECORATIVE, INK, OCEAN, STROKE, SUN, WHITE } from './style';

type Pt = {
  x: number;
  y: number;
};

/**
 * The volleyball: three panels (sun, white, ocean) meeting at the centre, the
 * way a beach ball is stitched. `VolleyballGlyph` is the drawing as a `<g>` for
 * use inside another SVG (the bracket's byes); `Volleyball` wraps it in its own
 * `<svg>` for the wordmark and the empty states.
 */
export function VolleyballGlyph({ cx = 32, cy = 32, r = 28, strokeWidth = STROKE }: { cx?: number; cy?: number; r?: number; strokeWidth?: number }) {
  const c: Pt = { x: cx, y: cy };
  // Rim points at the top and at ±120° from it; each seam is a quadratic from the centre to its rim point.
  const top: Pt = { x: cx, y: cy - r };
  const right: Pt = { x: cx + r * Math.cos(Math.PI / 6), y: cy + r * Math.sin(Math.PI / 6) };
  const left: Pt = { x: cx - r * Math.cos(Math.PI / 6), y: cy + r * Math.sin(Math.PI / 6) };
  const seams: Array<{ ctrl: Pt; end: Pt }> = [
    { ctrl: { x: cx - r * 0.32, y: cy - r * 0.45 }, end: top },
    { ctrl: { x: cx + r * 0.42, y: cy + r * 0.06 }, end: right },
    { ctrl: { x: cx - r * 0.13, y: cy + r * 0.38 }, end: left },
  ];
  const out = (s: { ctrl: Pt; end: Pt }) => `M${c.x} ${c.y} Q${s.ctrl.x} ${s.ctrl.y} ${s.end.x} ${s.end.y}`;
  const back = (s: { ctrl: Pt; end: Pt }) => `Q${s.ctrl.x} ${s.ctrl.y} ${c.x} ${c.y}`;
  const rim = (to: Pt) => `A${r} ${r} 0 0 1 ${to.x} ${to.y}`;
  const [a, b, d] = seams as [(typeof seams)[number], (typeof seams)[number], (typeof seams)[number]];
  return (
    <g>
      <path d={`${out(a)} ${rim(b.end)} ${back(b)} Z`} fill={SUN} />
      <path d={`${out(b)} ${rim(d.end)} ${back(d)} Z`} fill={WHITE} />
      <path d={`${out(d)} ${rim(a.end)} ${back(a)} Z`} fill={OCEAN} />
      <path d={seams.map(out).join(" ")} fill="none" stroke={INK} strokeWidth={strokeWidth} strokeLinecap="round" />
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={INK} strokeWidth={strokeWidth} />
    </g>
  );
}

export function Volleyball({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg {...DECORATIVE} width={size} height={size} viewBox="0 0 64 64" className={className}>
      <VolleyballGlyph />
    </svg>
  );
}
