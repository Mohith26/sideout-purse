import { BASE, CREAM, DECORATIVE, FOAM, OCEAN, SAND, SKY, STROKE } from './style';
import { cx } from '../../lib/cx';

export type WaveFill = "foam" | "base" | "raised" | "ocean" | "sand" | "sky";

const FILL: Record<WaveFill, string> = { foam: FOAM, base: BASE, raised: CREAM, ocean: OCEAN, sand: SAND, sky: SKY };

/** One wave period in px and its amplitude; the strip is two screens of periods so the drift can loop on one. */
const PERIOD = 96;
const HALF = 1600;

/**
 * A wave-edged strip. With `edge="top"` the wave is its upper edge and the fill
 * runs to the bottom, which makes it a section divider or, placed at the foot of
 * a band in the colour of what follows, that band's wavy bottom edge. `line`
 * draws the shoreline in ocean over it. The strip drifts sideways by one period
 * set on `--d-drift` (motion.css) and holds still under reduced motion; it is
 * decoration, so it is hidden from assistive tech and never carries data.
 */
export function WaveDivider({
  fill = "foam",
  height = 16,
  edge = "top",
  line = false,
  drift = true,
  className,
}: {
  fill?: WaveFill;
  height?: number;
  edge?: "top" | "bottom";
  line?: boolean;
  drift?: boolean;
  className?: string;
}) {
  const amplitude = Math.min(height / 2, 8);
  const periods = (HALF * 2) / PERIOD;
  let d = `M0 ${amplitude}`;
  for (let i = 0; i < periods; i += 1) {
    const x = i * PERIOD;
    d += ` Q${x + PERIOD / 4} ${-amplitude} ${x + PERIOD / 2} ${amplitude} Q${x + (PERIOD * 3) / 4} ${amplitude * 3} ${x + PERIOD} ${amplitude}`;
  }
  const area = `${d} V${height} H0 Z`;
  return (
    <div aria-hidden="true" className={cx("pointer-events-none w-full overflow-hidden", className)} style={{ height }}>
      <svg
        {...DECORATIVE}
        viewBox={`0 0 ${HALF * 2} ${height}`}
        preserveAspectRatio="none"
        className={cx("block h-full", drift && "wave-drift")}
        style={{ width: HALF * 2 }}
      >
        <g transform={edge === "bottom" ? `translate(0 ${height}) scale(1 -1)` : undefined}>
          <path d={area} fill={FILL[fill]} />
          {line ? <path d={d} fill="none" stroke={OCEAN} strokeWidth={STROKE} /> : null}
        </g>
      </svg>
    </div>
  );
}
