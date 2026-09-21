import { CloudGlyph, SunGlyph } from './Sky';
import { DECORATIVE, INK, SAND, SKY, STROKE_FINE } from './style';
import { cx } from '../../lib/cx';

/**
 * The sky behind the app header and the console's header band: a sky fill, the
 * sun kept at the right edge whatever the width (`xMaxYMid slice`), and a few
 * clouds. It fills a `relative` parent and sits behind its content; the parent
 * adds the wave-edged bottom (`WaveDivider`) in the colour of what follows.
 */
export function SkyBand({ variant = "header", className }: { variant?: "header" | "rail" | "console"; className?: string }) {
  // The console strip is short and wide, so it draws in its own space; the header and rail share one.
  const w = variant === "console" ? 1200 : 400;
  const h = variant === "console" ? 40 : 64;
  return (
    <svg {...DECORATIVE} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMaxYMid slice" className={cx("absolute inset-0 h-full w-full", className)}>
      <rect width={w} height={h} fill={SKY} />
      {variant === "header" ? (
        <>
          <CloudGlyph x={214} y={46} w={54} />
          <CloudGlyph x={296} y={30} w={36} />
          <SunGlyph cx={364} cy={30} r={13} strokeWidth={STROKE_FINE} />
        </>
      ) : variant === "rail" ? (
        // The rail is 232px wide: only the right 195 units show and the wordmark owns most of them, so the sun alone.
        <SunGlyph cx={370} cy={32} r={12} strokeWidth={STROKE_FINE} />
      ) : (
        <>
          <CloudGlyph x={1030} y={34} w={44} />
          <CloudGlyph x={1096} y={22} w={28} />
          <SunGlyph cx={1162} cy={21} r={9} strokeWidth={STROKE_FINE} />
        </>
      )}
    </svg>
  );
}

/**
 * The sand-grain edge the tab bar wears: a repeating dune line with a few grains
 * beneath it, on the sand tone. No drift; a floor does not move.
 */
export function SandEdge({ height = 10, className }: { height?: number; className?: string }) {
  const id = "sand-grain";
  return (
    <svg {...DECORATIVE} className={cx("block w-full", className)} style={{ height }} preserveAspectRatio="none">
      <defs>
        <pattern id={id} width={48} height={height} patternUnits="userSpaceOnUse">
          <path d={`M0 ${height} V5 Q6 0 12 4 Q18 8 24 3 Q30 -1 36 4 Q42 8 48 5 V${height} Z`} fill={SAND} />
          <path d={`M0 5 Q6 0 12 4 Q18 8 24 3 Q30 -1 36 4 Q42 8 48 5`} fill="none" stroke={INK} strokeWidth={1} opacity={0.35} />
          <circle cx={9} cy={8} r={0.9} fill={INK} opacity={0.3} />
          <circle cx={27} cy={7.5} r={0.9} fill={INK} opacity={0.3} />
          <circle cx={40} cy={8.2} r={0.9} fill={INK} opacity={0.3} />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${id})`} />
    </svg>
  );
}
