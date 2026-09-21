import { DECORATIVE, INK, OCEAN, PALM, SAND, STROKE, STROKE_FINE, SUN, SURF, WHITE } from './style';

/**
 * The beach furniture: a palm, an umbrella, a beach ball, a pennant flag and the
 * sand grain edge. Each glyph draws into a shared coordinate space so scenes can
 * compose them; the exported components wrap one glyph in its own `<svg>`.
 */

/** A palm: a leaning trunk with five fronds, anchored at the foot of the trunk (`x`, `y`) and `h` tall. */
export function PalmGlyph({ x, y, h, lean = 1, strokeWidth = STROKE_FINE }: { x: number; y: number; h: number; lean?: 1 | -1; strokeWidth?: number }) {
  const topX = x + lean * h * 0.28;
  const topY = y - h;
  const trunk = `M${x - h * 0.06} ${y} Q${x + lean * h * 0.02} ${y - h * 0.55} ${topX} ${topY} Q${x + lean * h * 0.12} ${y - h * 0.5} ${x + h * 0.06} ${y} Z`;
  const frond = (angle: number, len: number, bend: number) => {
    const a = (angle * Math.PI) / 180;
    const ex = topX + len * Math.cos(a);
    const ey = topY + len * Math.sin(a);
    const nx = -Math.sin(a) * bend;
    const ny = Math.cos(a) * bend;
    const mx = topX + (len / 2) * Math.cos(a);
    const my = topY + (len / 2) * Math.sin(a);
    return `M${topX} ${topY} Q${mx + nx} ${my + ny} ${ex} ${ey} Q${mx - nx * 0.2} ${my - ny * 0.2} ${topX} ${topY} Z`;
  };
  // Seven fronds fanned around the crown (270° is straight up in SVG space), the outer ones drooping toward the sand.
  const fronds = [
    frond(170, h * 0.46, -h * 0.16),
    frond(200, h * 0.52, -h * 0.14),
    frond(236, h * 0.5, -h * 0.08),
    frond(270, h * 0.44, 0),
    frond(304, h * 0.5, h * 0.08),
    frond(340, h * 0.52, h * 0.14),
    frond(10, h * 0.46, h * 0.16),
  ];
  return (
    <g>
      <path d={trunk} fill={SAND} stroke={INK} strokeWidth={strokeWidth} strokeLinejoin="round" />
      {fronds.map((d, i) => (
        <path key={i} d={d} fill={PALM} stroke={INK} strokeWidth={strokeWidth} strokeLinejoin="round" />
      ))}
      <circle cx={topX + 1} cy={topY + 5} r={h * 0.045} fill={SUN} stroke={INK} strokeWidth={strokeWidth} />
      <circle cx={topX - h * 0.07} cy={topY + 7} r={h * 0.045} fill={SUN} stroke={INK} strokeWidth={strokeWidth} />
    </g>
  );
}

/** A beach umbrella, tilted, anchored at the foot of its pole (`x`, `y`) and `h` tall. */
export function UmbrellaGlyph({ x, y, h, tilt = -12, strokeWidth = STROKE_FINE }: { x: number; y: number; h: number; tilt?: number; strokeWidth?: number }) {
  const r = h * 0.55;
  const cx = 0;
  const cy = -h;
  // Six panels of a half-disc, alternating ocean and white.
  const panels = 6;
  const panel = (i: number) => {
    const a0 = Math.PI + (i / panels) * Math.PI;
    const a1 = Math.PI + ((i + 1) / panels) * Math.PI;
    const p0 = { x: cx + r * Math.cos(a0), y: cy + r * Math.sin(a0) };
    const p1 = { x: cx + r * Math.cos(a1), y: cy + r * Math.sin(a1) };
    return `M${cx} ${cy} L${p0.x} ${p0.y} A${r} ${r} 0 0 1 ${p1.x} ${p1.y} Z`;
  };
  return (
    <g transform={`translate(${x} ${y}) rotate(${tilt})`}>
      <line x1={0} y1={0} x2={0} y2={cy} stroke={INK} strokeWidth={strokeWidth * 2} strokeLinecap="round" />
      {Array.from({ length: panels }, (_, i) => (
        <path key={i} d={panel(i)} fill={i % 2 === 0 ? OCEAN : WHITE} stroke={INK} strokeWidth={strokeWidth} strokeLinejoin="round" />
      ))}
      <circle cx={cx} cy={cy - 2} r={3} fill={SUN} stroke={INK} strokeWidth={strokeWidth} />
    </g>
  );
}

/** A beach ball: three lens stripes (sun, white, ocean) with a cap. */
export function BeachBallGlyph({ cx, cy, r, strokeWidth = STROKE }: { cx: number; cy: number; r: number; strokeWidth?: number }) {
  const top = `${cx} ${cy - r}`;
  const bottom = `${cx} ${cy + r}`;
  const inner = r * 0.42;
  return (
    <g>
      <circle cx={cx} cy={cy} r={r} fill={WHITE} />
      <path d={`M${top} A${r} ${r} 0 0 0 ${bottom} A${inner} ${r} 0 0 1 ${top} Z`} fill={SUN} />
      <path d={`M${top} A${inner} ${r} 0 0 1 ${bottom} A${r} ${r} 0 0 1 ${top} Z`} fill={OCEAN} />
      <path d={`M${top} A${inner} ${r} 0 0 0 ${bottom} M${top} A${inner} ${r} 0 0 1 ${bottom}`} fill="none" stroke={INK} strokeWidth={strokeWidth} />
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={INK} strokeWidth={strokeWidth} />
      <circle cx={cx} cy={cy - r * 0.78} r={r * 0.16} fill={WHITE} stroke={INK} strokeWidth={strokeWidth} />
    </g>
  );
}

/** A pennant on a pole in the live colour, anchored at the foot of the pole. */
export function FlagGlyph({ x, y, h, strokeWidth = STROKE }: { x: number; y: number; h: number; strokeWidth?: number }) {
  const w = h * 0.7;
  return (
    <g>
      <line x1={x} y1={y} x2={x} y2={y - h} stroke={INK} strokeWidth={strokeWidth} strokeLinecap="round" />
      <path d={`M${x} ${y - h} L${x + w} ${y - h * 0.78} L${x} ${y - h * 0.56} Z`} fill={SURF} stroke={INK} strokeWidth={strokeWidth} strokeLinejoin="round" />
    </g>
  );
}

export function Palm({ height = 96, lean = 1, className }: { height?: number; lean?: 1 | -1; className?: string }) {
  const w = height * 0.9;
  return (
    <svg {...DECORATIVE} width={w} height={height} viewBox={`0 0 ${w} ${height}`} className={className}>
      <PalmGlyph x={lean === 1 ? w * 0.3 : w * 0.7} y={height - 2} h={height * 0.8} lean={lean} />
    </svg>
  );
}

export function Umbrella({ height = 96, className }: { height?: number; className?: string }) {
  // The canopy (radius 0.55h) plus the pole must fit the box even when tilted, so the pole is 0.6 of the height.
  const w = height * 0.9;
  return (
    <svg {...DECORATIVE} width={w} height={height} viewBox={`0 0 ${w} ${height}`} className={className}>
      <UmbrellaGlyph x={w * 0.56} y={height - 2} h={height * 0.6} />
    </svg>
  );
}

export function BeachBall({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg {...DECORATIVE} width={size} height={size} viewBox="0 0 32 32" className={className}>
      <BeachBallGlyph cx={16} cy={16} r={13} />
    </svg>
  );
}

export function Flag({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg {...DECORATIVE} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <FlagGlyph x={6} y={22} h={19} />
    </svg>
  );
}
