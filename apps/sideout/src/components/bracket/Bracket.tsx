'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { IconButton, Icons, LiveDot, StatusPill } from '@sideout/ui';

import type { MatchStatus } from '../../db/schema';
import { cx } from '../../lib/cx';
import { formatTime } from '../../lib/format';
import { bracketRoundLabel } from '../../lib/rounds';
import { ScoreDisplay } from '../motion/ScoreDisplay';
import { MATCH_STATUS_PILL } from '../status/pills';
import { fitText, HEADER_HEIGHT, layoutBracket, neighborOf, NODE_HEIGHT, NODE_WIDTH, PADDING, pickCurrentMatch, type BracketNode, type BracketTeamRef, type Direction, type PlacedNode } from './model';

/**
 * The SVG bracket (spec 5.3, "Tournament"): rounds as columns, byes rendered as what they
 * are, the current match pinned above the canvas, pan and zoom by pointer (drag, pinch,
 * wheel) with explicit controls, and full keyboard operability (spec 6.4).
 *
 * Accessibility: the canvas is a list of rounds, each a list of matches, with `aria-label`s
 * throughout, no `role="application"`. Every match is a real link (`<a>` inside the SVG) so
 * Enter opens it; arrow keys move between matches with a roving tabindex, and a visible 2px
 * volt ring at 2px offset follows focus. Winner paths are separate `<path>` elements
 * carrying `data-from`/`data-to`; one that becomes advanced after mount draws itself in
 * with a `stroke-dashoffset` animation over --d-draw (spec 6.3, transition 3), which the
 * live refresh triggers when a winner advances.
 */
export type BracketProps = {
  nodes: readonly BracketNode[];
  /** The venue zone for scheduled times. */
  timeZone: string;
  /** Accessible name for the canvas. */
  label?: string;
};

type Transform = { x: number; y: number; k: number };

const MIN_SCALE = 0.4;
const MAX_SCALE = 2.5;
const ZOOM_STEP = 1.25;
const DRAG_THRESHOLD = 5;
/** Below this fit scale the bracket would be unreadable, so the view opens at 1:1 on the current match instead. */
const MIN_FIT_SCALE = 0.72;

const KEY_DIRECTION: Record<string, Direction> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Home: 'home', End: 'end' };

function clampScale(k: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, k));
}

/** Keep the content on screen: centred when it fits, never scrolled past its edge when it does not. */
function clampTransform(t: Transform, viewW: number, viewH: number, contentW: number, contentH: number): Transform {
  const w = contentW * t.k;
  const h = contentH * t.k;
  const x = w <= viewW ? (viewW - w) / 2 : Math.min(0, Math.max(viewW - w, t.x));
  const y = h <= viewH ? (viewH - h) / 2 : Math.min(0, Math.max(viewH - h, t.y));
  return { x, y, k: t.k };
}

function fitTransform(viewW: number, viewH: number, contentW: number, contentH: number): Transform {
  const k = clampScale(Math.min(1, viewW / contentW, viewH / contentH));
  return clampTransform({ x: 0, y: 0, k }, viewW, viewH, contentW, contentH);
}

function centerOn(p: PlacedNode, k: number, viewW: number, viewH: number, contentW: number, contentH: number): Transform {
  const cx0 = (p.x + NODE_WIDTH / 2) * k;
  const cy0 = (p.y + NODE_HEIGHT / 2) * k;
  return clampTransform({ x: viewW / 2 - cx0, y: viewH / 2 - cy0, k }, viewW, viewH, contentW, contentH);
}

function statusNote(node: BracketNode, timeZone: string): string {
  switch (node.status) {
    case 'in_progress':
      return 'Live';
    case 'awaiting_scores':
      return 'Awaiting scores';
    case 'disputed':
      return 'Disputed';
    case 'final':
      return 'Final';
    case 'forfeited':
      return 'Forfeit';
    case 'bye':
      return 'Bye';
    case 'scheduled':
      return node.scheduledAt === null ? 'Scheduled' : formatTime(node.scheduledAt, timeZone);
  }
}

function teamLabel(team: BracketTeamRef | null, bye: boolean): string {
  if (team !== null) return team.seed === null ? team.name : `${team.seed} ${team.name}`;
  return bye ? 'bye' : 'to be decided';
}

function describe(node: BracketNode, rounds: number, timeZone: string): string {
  const bye = node.status === 'bye';
  const who = bye ? `${teamLabel(node.teamA, false)} advances on a bye` : `${teamLabel(node.teamA, false)} versus ${teamLabel(node.teamB, false)}`;
  const score = node.sets.length > 0 ? `, sets ${node.sets.map((s) => `${s.a}–${s.b}`).join(', ')}` : '';
  const court = node.courtLabel === null ? '' : `, ${node.courtLabel}`;
  return `${bracketRoundLabel(node.round, rounds)}: ${who}${score}${court}, ${statusNote(node, timeZone).toLowerCase()}`;
}

const STROKE_FOR_STATUS: Partial<Record<MatchStatus, string>> = { in_progress: 'stroke-surf', disputed: 'stroke-fault' };

export function Bracket({ nodes, timeZone, label = 'Bracket' }: BracketProps) {
  const layout = useMemo(() => layoutBracket(nodes), [nodes]);
  const current = useMemo(() => pickCurrentMatch(nodes), [nodes]);
  const headingId = useId();

  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const nodeRefs = useRef(new Map<string, HTMLElement | SVGElement>());
  const [view, setView] = useState<{ w: number; h: number } | null>(null);
  /** Null until the user pans, zooms or navigates; before that the view is derived from the layout. */
  const [userTransform, setUserTransform] = useState<Transform | null>(null);
  const [tabbableId, setTabbableId] = useState<string | null>(current?.id ?? layout.columns[0]?.nodes[0]?.node.id ?? null);

  const canvasHeight = Math.min(560, Math.max(280, layout.height));

  // Transition 3: a connector advanced since the last render draws itself in.
  const advancedIds = useMemo(() => new Set(layout.connectors.filter((c) => c.advanced).map((c) => c.id)), [layout]);
  const seenAdvanced = useRef<Set<string> | null>(null);
  const [drawing, setDrawing] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    const seen = seenAdvanced.current;
    seenAdvanced.current = advancedIds;
    if (seen === null) return;
    const fresh = [...advancedIds].filter((id) => !seen.has(id));
    if (fresh.length > 0) setDrawing((prev) => new Set([...prev, ...fresh]));
  }, [advancedIds]);
  const drawn = useCallback((id: string) => {
    setDrawing((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  // Measure the canvas; the SVG is sized in CSS pixels so text stays crisp at scale 1.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (el === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect !== undefined) setView({ w: rect.width, h: rect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Opening view: the whole bracket when it fits legibly, otherwise 1:1 on the current match.
  const transform = useMemo<Transform>(() => {
    if (userTransform !== null) return userTransform;
    if (view === null || layout.width === 0) return { x: 0, y: 0, k: 1 };
    const fit = fitTransform(view.w, view.h, layout.width, layout.height);
    if (fit.k >= MIN_FIT_SCALE) return fit;
    const target = current === null ? undefined : layout.byId.get(current.id);
    return target === undefined ? clampTransform({ x: 0, y: 0, k: 1 }, view.w, view.h, layout.width, layout.height) : centerOn(target, 1, view.w, view.h, layout.width, layout.height);
  }, [userTransform, view, layout, current]);

  /** The transform as of the last mutation, which wheel bursts and pinches advance faster than React renders. */
  const latest = useRef(transform);
  useLayoutEffect(() => {
    latest.current = transform;
  }, [transform]);

  const apply = useCallback(
    (next: Transform) => {
      if (view === null) return;
      const clamped = clampTransform({ ...next, k: clampScale(next.k) }, view.w, view.h, layout.width, layout.height);
      latest.current = clamped;
      setUserTransform(clamped);
    },
    [view, layout],
  );

  const zoomAt = useCallback(
    (factor: number, px: number, py: number) => {
      const t = latest.current;
      const k = clampScale(t.k * factor);
      const ratio = k / t.k;
      apply({ x: px - (px - t.x) * ratio, y: py - (py - t.y) * ratio, k });
    },
    [apply],
  );

  const locate = useCallback(
    (id: string) => {
      const target = layout.byId.get(id);
      if (target === undefined || view === null) return;
      apply(centerOn(target, Math.max(latest.current.k, 1), view.w, view.h, layout.width, layout.height));
    },
    [layout, view, apply],
  );

  const fit = useCallback(() => {
    if (view === null) return;
    apply(fitTransform(view.w, view.h, layout.width, layout.height));
  }, [view, layout, apply]);

  /** Nudge the view so a keyboard-focused node is fully visible. */
  const reveal = useCallback(
    (id: string) => {
      const p = layout.byId.get(id);
      if (p === undefined || view === null) return;
      const t = latest.current;
      const left = p.x * t.k + t.x;
      const top = p.y * t.k + t.y;
      const right = left + NODE_WIDTH * t.k;
      const bottom = top + NODE_HEIGHT * t.k;
      let { x, y } = t;
      if (left < PADDING) x += PADDING - left;
      else if (right > view.w - PADDING) x -= right - (view.w - PADDING);
      if (top < HEADER_HEIGHT) y += HEADER_HEIGHT - top;
      else if (bottom > view.h - PADDING) y -= bottom - (view.h - PADDING);
      apply({ x, y, k: t.k });
    },
    [layout, view, apply],
  );

  const focusNode = useCallback(
    (id: string) => {
      setTabbableId(id);
      reveal(id);
      nodeRefs.current.get(id)?.focus({ preventScroll: true });
    },
    [reveal],
  );

  // --- Pointer pan and pinch -----------------------------------------------------------------
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ start: Transform; origin: { x: number; y: number }; distance: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);

  const localPoint = (e: { clientX: number; clientY: number }) => {
    const rect = svgRef.current?.getBoundingClientRect();
    return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
  };

  // Capture only once a drag or pinch is under way: a plain tap must still reach the match link underneath.
  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    suppressClick.current = false;
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    pointers.current.set(e.pointerId, localPoint(e));
    if (pointers.current.size >= 2) for (const id of pointers.current.keys()) e.currentTarget.setPointerCapture(id);
    const list = [...pointers.current.values()];
    const origin = list.length >= 2 ? { x: ((list[0]?.x ?? 0) + (list[1]?.x ?? 0)) / 2, y: ((list[0]?.y ?? 0) + (list[1]?.y ?? 0)) / 2 } : (list[0] ?? { x: 0, y: 0 });
    const distance = list.length >= 2 ? Math.hypot((list[0]?.x ?? 0) - (list[1]?.x ?? 0), (list[0]?.y ?? 0) - (list[1]?.y ?? 0)) : 0;
    gesture.current = { start: latest.current, origin, distance, moved: gesture.current?.moved ?? false };
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!pointers.current.has(e.pointerId) || gesture.current === null) return;
    pointers.current.set(e.pointerId, localPoint(e));
    const list = [...pointers.current.values()];
    const g = gesture.current;
    if (list.length >= 2) {
      const a = list[0] ?? { x: 0, y: 0 };
      const b = list[1] ?? { x: 0, y: 0 };
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const ratio = g.distance > 0 ? distance / g.distance : 1;
      const k = clampScale(g.start.k * ratio);
      const scaleRatio = k / g.start.k;
      g.moved = true;
      apply({ x: mid.x - (g.origin.x - g.start.x) * scaleRatio, y: mid.y - (g.origin.y - g.start.y) * scaleRatio, k });
      return;
    }
    const p = list[0] ?? { x: 0, y: 0 };
    const dx = p.x - g.origin.x;
    const dy = p.y - g.origin.y;
    if (!g.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    if (!g.moved) e.currentTarget.setPointerCapture(e.pointerId);
    g.moved = true;
    apply({ x: g.start.x + dx, y: g.start.y + dy, k: g.start.k });
  };

  const endPointer = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.delete(e.pointerId);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (pointers.current.size === 0) {
      suppressClick.current = e.type === 'pointerup' && (gesture.current?.moved ?? false);
      gesture.current = null;
    } else {
      // One finger lifted mid-pinch: restart the gesture from the remaining pointer.
      const rest = [...pointers.current.values()];
      gesture.current = { start: latest.current, origin: rest[0] ?? { x: 0, y: 0 }, distance: 0, moved: true };
    }
  };

  // Wheel: ctrl/meta zooms around the cursor; a plain wheel pans while the bracket can still move that way, then lets the page scroll.
  useEffect(() => {
    const el = svgRef.current;
    if (el === null || view === null) return;
    const handler = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        zoomAt(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, e.clientX - rect.left, e.clientY - rect.top);
        return;
      }
      const t = latest.current;
      const next = clampTransform({ x: t.x - e.deltaX, y: t.y - e.deltaY, k: t.k }, view.w, view.h, layout.width, layout.height);
      if (next.x === t.x && next.y === t.y) return;
      e.preventDefault();
      apply(next);
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [view, layout, zoomAt, apply]);

  const onClickCapture = (e: ReactMouseEvent) => {
    if (suppressClick.current) {
      e.preventDefault();
      e.stopPropagation();
      suppressClick.current = false;
    }
  };

  // --- Keyboard ------------------------------------------------------------------------------
  const onKeyDown = (e: ReactKeyboardEvent<SVGSVGElement>) => {
    suppressClick.current = false;
    const target = (e.target as Element | null)?.closest<SVGElement>('[data-node-id]');
    const id = target?.dataset['nodeId'];
    if (id === undefined) return;
    const direction = KEY_DIRECTION[e.key];
    if (direction === undefined) return;
    e.preventDefault();
    const next = neighborOf(layout, id, direction);
    if (next !== null) focusNode(next);
  };

  if (layout.rounds === 0) return null;

  const currentPlaced = current === null ? undefined : layout.byId.get(current.id);

  return (
    <section aria-labelledby={headingId} className="surface-raised overflow-hidden rounded-card" data-testid="bracket">
      <h3 id={headingId} className="sr-only">
        {label}
      </h3>
      {current === null ? null : <PinnedMatch node={current} rounds={layout.rounds} onLocate={() => locate(current.id)} />}
      <div className="relative border-t border-border-subtle bg-bg-inset">
        <div className="absolute top-2 right-2 z-10 flex flex-col gap-1" role="group" aria-label="Bracket view controls">
          <IconButton raised label="Zoom in" onClick={() => view !== null && zoomAt(ZOOM_STEP, view.w / 2, view.h / 2)}>
            <Icons.zoomIn size={18} />
          </IconButton>
          <IconButton raised label="Zoom out" onClick={() => view !== null && zoomAt(1 / ZOOM_STEP, view.w / 2, view.h / 2)}>
            <Icons.zoomOut size={18} />
          </IconButton>
          <IconButton raised label="Fit whole bracket" onClick={fit}>
            <Icons.maximize size={18} />
          </IconButton>
          {currentPlaced === undefined ? null : (
            <IconButton raised label="Go to current match" onClick={() => locate(currentPlaced.node.id)}>
              <Icons.locate size={18} />
            </IconButton>
          )}
        </div>
        <div ref={containerRef} style={{ height: canvasHeight }} className="w-full max-h-[360px] touch-pan-y select-none md:max-h-none">
          <svg
            ref={svgRef}
            role="group"
            aria-label={`${label} canvas. Use the arrow keys to move between matches and Enter to open one.`}
            width={view?.w ?? '100%'}
            height={view?.h ?? canvasHeight}
            className="block cursor-grab active:cursor-grabbing"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endPointer}
            onPointerCancel={endPointer}
            onPointerLeave={endPointer}
            onKeyDown={onKeyDown}
            onClickCapture={onClickCapture}
          >
            <g transform={`translate(${transform.x} ${transform.y}) scale(${transform.k})`}>
              <g aria-hidden="true" data-layer="connectors">
                {layout.connectors.map((c) => (
                  <path
                    key={c.id}
                    d={c.d}
                    data-from={c.fromId}
                    data-to={c.toId}
                    data-slot={c.slot}
                    data-advanced={c.advanced ? 'true' : 'false'}
                    data-drawing={drawing.has(c.id) ? 'true' : undefined}
                    pathLength={1}
                    fill="none"
                    onAnimationEnd={() => drawn(c.id)}
                    className={cx('stroke-[1.5]', c.advanced ? 'stroke-surf' : 'stroke-border-strong', drawing.has(c.id) && 'path-draw')}
                  />
                ))}
              </g>
              <g role="list" aria-label={`${label} rounds`}>
                {layout.columns.map((column) => (
                  <g key={column.round} role="listitem" aria-label={column.label}>
                    <text x={column.x} y={PADDING + 12} className="type-label fill-text-tertiary" aria-hidden="true">
                      {column.label}
                    </text>
                    <g role="list" aria-label={`${column.label} matches`}>
                      {column.nodes.map((p) => (
                        <MatchNode
                          key={p.node.id}
                          placed={p}
                          rounds={layout.rounds}
                          timeZone={timeZone}
                          tabbable={p.node.id === tabbableId}
                          pinned={p.node.id === current?.id}
                          register={(el) => {
                            if (el === null) nodeRefs.current.delete(p.node.id);
                            else nodeRefs.current.set(p.node.id, el);
                          }}
                          onFocus={() => setTabbableId(p.node.id)}
                        />
                      ))}
                    </g>
                  </g>
                ))}
              </g>
            </g>
          </svg>
        </div>
        <p className="border-t border-border-subtle px-3 py-2 type-label text-text-tertiary">Drag to pan · pinch or Ctrl+scroll to zoom · arrow keys move between matches, Enter opens one</p>
      </div>
    </section>
  );
}

// ---- Nodes --------------------------------------------------------------------------------

const ROW_A_Y = 24;
const ROW_B_Y = 48;
const STATUS_Y = 71;
const SET_COLUMN = 26;
const TEXT_INSET = 12;
/** Average glyph widths for `fitText`: body-size names and label-size seeds. */
const NAME_CHAR_PX = 7.6;
const SEED_CHAR_PX = 7.2;
const SEED_GAP = 5;

type MatchNodeProps = {
  placed: PlacedNode;
  rounds: number;
  timeZone: string;
  tabbable: boolean;
  pinned: boolean;
  register: (el: HTMLElement | SVGElement | null) => void;
  onFocus: () => void;
};

function MatchNode({ placed, rounds, timeZone, tabbable, pinned, register, onFocus }: MatchNodeProps) {
  const { node, x, y } = placed;
  const bye = node.status === 'bye';
  const description = describe(node, rounds, timeZone);
  const stroke = STROKE_FOR_STATUS[node.status] ?? (pinned ? 'stroke-border-strong' : 'stroke-border-subtle');
  const setsWidth = node.sets.length * SET_COLUMN;
  const nameWidth = NODE_WIDTH - TEXT_INSET * 2 - setsWidth - (setsWidth > 0 ? 8 : 0);

  const body = (
    <>
      <rect x={-2} y={-2} width={NODE_WIDTH + 4} height={NODE_HEIGHT + 4} rx={8} className="fill-none stroke-volt stroke-2 opacity-0 group-focus-visible:opacity-100" />
      <rect width={NODE_WIDTH} height={NODE_HEIGHT} rx={6} className={cx('fill-bg-raised', stroke, node.status === 'in_progress' || node.status === 'disputed' ? 'stroke-[1.5]' : 'stroke-1')} />
      <TeamRow team={node.teamA} y={ROW_A_Y} points={node.sets.map((s) => s.a)} won={node.winnerId !== null && node.winnerId === node.teamA?.id} nameWidth={nameWidth} live={node.status === 'in_progress'} />
      {bye ? (
        <text x={TEXT_INSET} y={ROW_B_Y} className="type-label fill-text-tertiary">
          Bye
        </text>
      ) : (
        <TeamRow team={node.teamB} y={ROW_B_Y} points={node.sets.map((s) => s.b)} won={node.winnerId !== null && node.winnerId === node.teamB?.id} nameWidth={nameWidth} live={node.status === 'in_progress'} />
      )}
      <text x={TEXT_INSET} y={STATUS_Y} className={cx('type-label', node.status === 'in_progress' ? 'fill-surf' : node.status === 'disputed' ? 'fill-fault' : 'fill-text-tertiary')}>
        {[node.courtLabel, statusNote(node, timeZone)].filter((part) => part !== null).join(' · ')}
      </text>
    </>
  );

  const shared = {
    transform: `translate(${x} ${y})`,
    className: 'group cursor-pointer outline-none',
    tabIndex: tabbable ? 0 : -1,
    'data-node-id': node.id,
    'data-round': node.round,
    'data-status': node.status,
    'aria-label': description,
    onFocus,
  } as const;

  if (node.href !== null) {
    return (
      <g role="listitem">
        <a href={node.href} ref={register} {...shared}>
          <title>{description}</title>
          {body}
        </a>
      </g>
    );
  }
  return (
    <g role="listitem">
      <g ref={register} role="group" {...shared}>
        <title>{description}</title>
        {body}
      </g>
    </g>
  );
}

function TeamRow({ team, y, points, won, nameWidth, live }: { team: BracketTeamRef | null; y: number; points: number[]; won: boolean; nameWidth: number; live: boolean }) {
  const seed = team?.seed ?? null;
  const seedWidth = seed === null ? 0 : String(seed).length * SEED_CHAR_PX + SEED_GAP;
  const name = team === null ? 'TBD' : fitText(team.name, nameWidth - seedWidth, NAME_CHAR_PX);
  return (
    <g aria-hidden="true">
      <text x={TEXT_INSET} y={y} className={cx('text-body font-medium', team === null ? 'fill-text-tertiary' : won ? 'fill-text-primary' : 'fill-text-secondary')}>
        {seed === null ? (
          name
        ) : (
          <>
            <tspan className="type-label fill-text-tertiary">{seed}</tspan>
            <tspan dx={SEED_GAP}>{name}</tspan>
          </>
        )}
      </text>
      {points.map((p, i) => (
        <text key={i} x={NODE_WIDTH - TEXT_INSET - (points.length - 1 - i) * SET_COLUMN} y={y} textAnchor="end" className={cx('tabular text-body font-medium', live ? 'fill-surf' : won ? 'fill-text-primary' : 'fill-text-secondary')}>
          {p}
        </text>
      ))}
    </g>
  );
}

// ---- Pinned current match -----------------------------------------------------------------

function PinnedMatch({ node, rounds, onLocate }: { node: BracketNode; rounds: number; onLocate: () => void }) {
  const winner = node.winnerId;
  const lead = node.status === 'in_progress' ? 'On the sand' : node.status === 'awaiting_scores' ? 'Waiting for scores' : node.status === 'disputed' ? 'Under review' : node.status === 'scheduled' ? 'Up next' : 'Latest result';
  return (
    <section className="flex flex-wrap items-center gap-x-4 gap-y-3 p-3 md:p-4" aria-label="Current match">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 type-label text-text-tertiary">
          <span className={cx('inline-flex items-center gap-2', node.status === 'in_progress' && 'text-surf')}>
            {node.status === 'in_progress' ? <LiveDot /> : null}
            {lead}
          </span>
          <span>·</span>
          <span>{bracketRoundLabel(node.round, rounds)}</span>
          {node.courtLabel === null ? null : (
            <>
              <span>·</span>
              <span>{node.courtLabel}</span>
            </>
          )}
          <StatusPill spec={MATCH_STATUS_PILL[node.status]} size="sm" />
        </div>
        <div className="mt-2 space-y-1" aria-live="polite">
          <PinnedRow team={node.teamA} points={node.sets.map((s) => s.a)} won={winner !== null && winner === node.teamA?.id} live={node.status === 'in_progress'} />
          {node.status === 'bye' ? <div className="type-label text-text-tertiary">Bye</div> : <PinnedRow team={node.teamB} points={node.sets.map((s) => s.b)} won={winner !== null && winner === node.teamB?.id} live={node.status === 'in_progress'} />}
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        <button type="button" onClick={onLocate} className="target surface-raised inline-flex items-center gap-2 rounded-input px-3 type-label text-text-secondary hover:text-text-primary">
          <Icons.locate size={16} />
          Locate
        </button>
        {node.href === null ? null : (
          <Link href={node.href} className="target inline-flex items-center gap-1 rounded-input px-3 type-label text-text-primary hover:text-volt">
            Open
            <Icons.chevronRight size={14} />
          </Link>
        )}
      </div>
    </section>
  );
}

function PinnedRow({ team, points, won, live }: { team: BracketTeamRef | null; points: number[]; won: boolean; live: boolean }) {
  return (
    <div className={cx('flex items-center justify-between gap-3', won ? 'text-text-primary' : 'text-text-secondary')}>
      <span className="flex min-w-0 items-baseline gap-2 font-medium">
        {team?.seed !== null && team?.seed !== undefined ? <span className="tabular type-label text-text-tertiary">{team.seed}</span> : null}
        <span className="truncate">{team === null ? 'TBD' : team.name}</span>
        {team !== null && team.members.length > 0 ? <span className="hidden truncate type-label text-text-tertiary sm:inline">{team.members.map((m) => m.split(' ')[0]).join(' & ')}</span> : null}
      </span>
      {points.length > 0 ? (
        <span className={cx('tabular flex shrink-0 gap-2 type-stat', live && 'text-surf')}>
          {points.map((p, i) => (
            <ScoreDisplay key={i} value={p} className="w-6 text-end" />
          ))}
        </span>
      ) : null}
    </div>
  );
}
