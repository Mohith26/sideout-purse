/**
 * FLIP (first, last, invert, play) for keyed rows, in-repo per spec 6.3 rather than a
 * dependency: snapshot where each row sits, let the DOM change, snapshot again, and
 * `flipMoves` says which rows moved and by how much; `playFlip` slides each from its old
 * position with the Web Animations API and flashes a changed rank in --surf (transition 2).
 * Under reduced motion the same rows cross-fade: opacity is the only property animated.
 */
export type FlipRect = { top: number; left: number; rank: string | null };
export type FlipSnapshot = Map<string, FlipRect>;
export type FlipMove = { key: string; dx: number; dy: number; rankFrom: string | null; rankTo: string | null };
export type FlipOptions = { durationMs: number; easing: string; reducedMotion: boolean };

export function snapshotRows(rows: Iterable<HTMLElement>, keyOf: (el: HTMLElement) => string | null): FlipSnapshot {
  const out: FlipSnapshot = new Map();
  for (const el of rows) {
    const key = keyOf(el);
    const rect = el.getBoundingClientRect();
    if (key !== null) out.set(key, { top: rect.top, left: rect.left, rank: el.dataset['rank'] ?? null });
  }
  return out;
}

/** Rows present in both snapshots that moved or changed rank; a new row has nowhere to move from. */
export function flipMoves(before: FlipSnapshot, after: FlipSnapshot): FlipMove[] {
  const moves: FlipMove[] = [];
  for (const [key, last] of after) {
    const first = before.get(key);
    if (first === undefined) continue;
    const move = { key, dx: first.left - last.left, dy: first.top - last.top, rankFrom: first.rank, rankTo: last.rank };
    if (move.dx !== 0 || move.dy !== 0 || first.rank !== last.rank) moves.push(move);
  }
  return moves;
}

/** The keyframes one moved row plays: a slide from its old spot, or a cross-fade when motion is reduced. */
export function flipKeyframes(move: Pick<FlipMove, 'dx' | 'dy'>, reducedMotion: boolean): Keyframe[] {
  return reducedMotion ? [{ opacity: 0.35 }, { opacity: 1 }] : [{ transform: `translate(${move.dx}px, ${move.dy}px)` }, { transform: 'none' }];
}

/** The rank delta shown beside the rank: places climbed are positive. */
export function rankDelta(move: Pick<FlipMove, 'rankFrom' | 'rankTo'>): number {
  const from = Number(move.rankFrom);
  const to = Number(move.rankTo);
  return move.rankFrom !== null && move.rankTo !== null && Number.isFinite(from) && Number.isFinite(to) ? from - to : 0;
}

export function playFlip(rows: ReadonlyMap<string, HTMLElement>, moves: readonly FlipMove[], options: FlipOptions): void {
  for (const move of moves) {
    const el = rows.get(move.key);
    if (el === undefined) continue;
    if ((move.dx !== 0 || move.dy !== 0) && typeof el.animate === 'function') el.animate(flipKeyframes(move, options.reducedMotion), { duration: options.durationMs, easing: options.easing });
    if (move.rankFrom !== move.rankTo) flashRank(el, rankDelta(move));
  }
}

/** One --surf beat on a row whose rank changed (rank-flash in motion.css), the delta written into the row's slot. */
function flashRank(el: HTMLElement, delta: number): void {
  const slot = el.querySelector<HTMLElement>('[data-rank-delta-slot]');
  el.dataset['rankDelta'] = delta > 0 ? `+${delta}` : String(delta);
  if (slot !== null) slot.textContent = delta > 0 ? `↑${delta}` : delta < 0 ? `↓${-delta}` : '';
  el.classList.remove('rank-flash');
  void el.offsetWidth; // restart the animation when a row flashes twice in a row
  el.classList.add('rank-flash');
  const clear = () => {
    el.classList.remove('rank-flash');
    delete el.dataset['rankDelta'];
    if (slot !== null) slot.textContent = '';
  };
  el.addEventListener('animationend', clear, { once: true });
}
