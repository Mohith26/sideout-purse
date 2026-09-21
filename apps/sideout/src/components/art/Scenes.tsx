import type { ReactNode } from 'react';
import { BeachBallGlyph, FlagGlyph, PalmGlyph, UmbrellaGlyph } from './Beach';
import { CloudGlyph, SunGlyph } from './Sky';
import { DECORATIVE, FOAM, INK, OCEAN, SAND, SKY, STROKE_FINE, WHITE } from './style';
import { VolleyballGlyph } from './Volleyball';
import { cx } from '../../lib/cx';

export type SceneName = "court" | "net" | "trouble" | "shore" | "notFound";

/**
 * Small illustrated scenes, 160×96, for empty states and the error boundary:
 * an empty court, a net still folded on the sand, an umbrella blown over (the
 * friendly error), a shoreline (nothing here yet) and a lost ball. Each is a
 * composition of the glyphs; the sky and sand are part of the picture so a
 * scene reads on any surface.
 */
export function Scene({ name, className, width = 160 }: { name: SceneName; className?: string; width?: number }) {
  return (
    <svg {...DECORATIVE} viewBox="0 0 160 96" width={width} height={width * 0.6} className={cx("shrink-0", className)}>
      <Backdrop />
      {SCENES[name]}
    </svg>
  );
}

/** Sky, a sun, the sea line and the sand every scene shares. */
function Backdrop() {
  return (
    <g>
      <rect width={160} height={96} rx={12} fill={SKY} />
      <SunGlyph cx={132} cy={22} r={9} strokeWidth={STROKE_FINE} />
      <CloudGlyph x={14} y={26} w={34} strokeWidth={STROKE_FINE} />
      <path d="M0 52 Q20 46 40 52 T80 52 T120 52 T160 52 V96 H0 Z" fill={OCEAN} />
      <path d="M0 58 Q20 52 40 58 T80 58 T120 58 T160 58 V96 H0 Z" fill={FOAM} />
      <path d="M0 64 Q20 58 40 64 T80 64 T120 64 T160 64 V96 H0 Z" fill={SAND} />
      <path d="M0 64 Q20 58 40 64 T80 64 T120 64 T160 64" fill="none" stroke={INK} strokeWidth={1} opacity={0.35} />
      <rect width={160} height={96} rx={12} fill="none" stroke={INK} strokeWidth={STROKE_FINE} />
    </g>
  );
}

/** A net between two posts: `x1`–`x2` across, `top` the tape line, `bottom` where the posts meet the sand. */
function Net({ x1, x2, top, bottom }: { x1: number; x2: number; top: number; bottom: number }) {
  const cols = 8;
  const rows = 4;
  const netBottom = top + (bottom - top) * 0.62;
  const lines: string[] = [];
  for (let i = 1; i < cols; i += 1) {
    const x = x1 + ((x2 - x1) * i) / cols;
    lines.push(`M${x} ${top} V${netBottom}`);
  }
  for (let j = 1; j <= rows; j += 1) {
    const y = top + ((netBottom - top) * j) / rows;
    lines.push(`M${x1} ${y} H${x2}`);
  }
  return (
    <g>
      <line x1={x1} y1={top - 2} x2={x1} y2={bottom} stroke={INK} strokeWidth={STROKE_FINE * 2} strokeLinecap="round" />
      <line x1={x2} y1={top - 2} x2={x2} y2={bottom} stroke={INK} strokeWidth={STROKE_FINE * 2} strokeLinecap="round" />
      <path d={lines.join(" ")} fill="none" stroke={INK} strokeWidth={0.8} opacity={0.6} />
      <rect x={x1} y={top - 2} width={x2 - x1} height={4} fill={WHITE} stroke={INK} strokeWidth={STROKE_FINE} />
    </g>
  );
}

const SCENES: Record<SceneName, ReactNode> = {
  court: (
    <g>
      <Net x1={40} x2={120} top={44} bottom={82} />
      <VolleyballGlyph cx={132} cy={76} r={8} strokeWidth={STROKE_FINE} />
      <path d="M24 84 Q30 80 36 84" fill="none" stroke={INK} strokeWidth={1} opacity={0.4} />
    </g>
  ),
  net: (
    <g>
      <line x1={44} y1={40} x2={44} y2={84} stroke={INK} strokeWidth={STROKE_FINE * 2} strokeLinecap="round" />
      {/* The net still rolled at the foot of one post */}
      <ellipse cx={72} cy={80} rx={22} ry={7} fill={WHITE} stroke={INK} strokeWidth={STROKE_FINE} />
      <ellipse cx={72} cy={74} rx={22} ry={7} fill={WHITE} stroke={INK} strokeWidth={STROKE_FINE} />
      <path d="M52 74 Q60 78 72 76 Q84 78 92 74 M54 80 Q62 84 72 82 Q82 84 90 80" fill="none" stroke={INK} strokeWidth={0.8} opacity={0.6} />
      <FlagGlyph x={120} y={82} h={26} strokeWidth={STROKE_FINE} />
    </g>
  ),
  trouble: (
    <g>
      {/* An umbrella blown over, a ball rolling off: nothing broke that a hand cannot right. */}
      <UmbrellaGlyph x={70} y={84} h={38} tilt={-64} strokeWidth={STROKE_FINE} />
      <BeachBallGlyph cx={122} cy={76} r={9} strokeWidth={STROKE_FINE} />
      <path d="M100 86 Q106 82 112 86 M30 86 Q36 82 42 86" fill="none" stroke={INK} strokeWidth={1} opacity={0.4} />
    </g>
  ),
  shore: (
    <g>
      <PalmGlyph x={30} y={84} h={46} lean={1} strokeWidth={STROKE_FINE} />
      <path d="M96 86 Q104 82 112 86 M120 88 Q126 84 132 88" fill="none" stroke={INK} strokeWidth={1} opacity={0.4} />
    </g>
  ),
  notFound: (
    <g>
      <VolleyballGlyph cx={80} cy={72} r={13} strokeWidth={STROKE_FINE} />
      <path d="M44 86 Q52 82 60 86 M100 88 Q108 84 116 88" fill="none" stroke={INK} strokeWidth={1} opacity={0.4} />
      <FlagGlyph x={130} y={80} h={22} strokeWidth={STROKE_FINE} />
    </g>
  ),
};
