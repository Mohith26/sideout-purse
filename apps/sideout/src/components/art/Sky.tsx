import { DECORATIVE, INK, STROKE, STROKE_FINE, SUN, WHITE } from './style';

/** A sun disc with eight chunky rays: an ink line under a sun line, so the rays read as outlined shapes. */
export function SunGlyph({ cx, cy, r, rays = 8, strokeWidth = STROKE }: { cx: number; cy: number; r: number; rays?: number; strokeWidth?: number }) {
  const inner = r * 1.38;
  const outer = r * 1.8;
  const lines = Array.from({ length: rays }, (_, i) => {
    const a = (i / rays) * Math.PI * 2 - Math.PI / 2;
    return { x1: cx + inner * Math.cos(a), y1: cy + inner * Math.sin(a), x2: cx + outer * Math.cos(a), y2: cy + outer * Math.sin(a) };
  });
  return (
    <g>
      {lines.map((l, i) => (
        <line key={`ink-${i}`} {...l} stroke={INK} strokeWidth={strokeWidth * 2.6} strokeLinecap="round" />
      ))}
      {lines.map((l, i) => (
        <line key={`sun-${i}`} {...l} stroke={SUN} strokeWidth={strokeWidth * 1.2} strokeLinecap="round" />
      ))}
      <circle cx={cx} cy={cy} r={r} fill={SUN} stroke={INK} strokeWidth={strokeWidth} />
    </g>
  );
}

/** A puffy cloud, anchored at its bottom-left corner; `w` is its width and the height follows. */
export function CloudGlyph({ x, y, w, strokeWidth = STROKE_FINE }: { x: number; y: number; w: number; strokeWidth?: number }) {
  const h = w * 0.46;
  const d = [
    `M${x + w * 0.12} ${y}`,
    `H${x + w * 0.86}`,
    `A${w * 0.12} ${w * 0.12} 0 0 0 ${x + w * 0.84} ${y - h * 0.52}`,
    `A${w * 0.17} ${w * 0.17} 0 0 0 ${x + w * 0.54} ${y - h * 0.86}`,
    `A${w * 0.16} ${w * 0.16} 0 0 0 ${x + w * 0.24} ${y - h * 0.58}`,
    `A${w * 0.12} ${w * 0.12} 0 0 0 ${x + w * 0.12} ${y}`,
    "Z",
  ].join(" ");
  return <path d={d} fill={WHITE} stroke={INK} strokeWidth={strokeWidth} strokeLinejoin="round" />;
}

export function Sun({ size = 40, className }: { size?: number; className?: string }) {
  return (
    <svg {...DECORATIVE} width={size} height={size} viewBox="0 0 64 64" className={className}>
      <SunGlyph cx={32} cy={32} r={15} />
    </svg>
  );
}

export function Cloud({ width = 64, className }: { width?: number; className?: string }) {
  return (
    <svg {...DECORATIVE} width={width} height={width * 0.5} viewBox="0 0 64 32" className={className}>
      <CloudGlyph x={2} y={29} w={60} />
    </svg>
  );
}
