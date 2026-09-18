// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { Bracket } from '../../src/components/bracket/Bracket';
import { layoutBracket, neighborOf, nodesFromDraw, nodesFromMatches, pickCurrentMatch, type BracketNode } from '../../src/components/bracket/model';

/**
 * The SVG bracket (spec 5.3, 6.4): rounds as columns, byes rendered as what they are,
 * winner paths as separate connectors that draw in when a winner advances, full keyboard
 * operability with a roving tabindex, and links Enter can follow.
 */
const VIEW = { width: 400, height: 300 };

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    class RO {
      constructor(private readonly callback: (entries: Array<{ contentRect: typeof VIEW }>) => void) {}
      observe() {
        this.callback([{ contentRect: VIEW }]);
      }
      disconnect() {
        return undefined;
      }
      unobserve() {
        return undefined;
      }
    }
    Object.defineProperty(globalThis, 'ResizeObserver', { value: RO, configurable: true });
  }
  const captured = new Set<number>();
  Object.assign(Element.prototype, {
    setPointerCapture(id: number) {
      captured.add(id);
    },
    releasePointerCapture(id: number) {
      captured.delete(id);
    },
    hasPointerCapture(id: number) {
      return captured.has(id);
    },
  });
});

const team = (n: number) => ({ id: `t${n}`, name: `Team ${n}`, seed: n, members: [`Player ${n}a`, `Player ${n}b`] });

/** Six teams in an eight-slot bracket: seeds 1 and 2 draw byes into the semifinals. */
function sixTeamBracket(): BracketNode[] {
  const base = (position: number, round: number, nextId: string | null, nextSlot: 'a' | 'b' | null): BracketNode => ({
    id: `m${position}`,
    round,
    position,
    teamA: null,
    teamB: null,
    status: 'scheduled',
    winnerId: null,
    nextId,
    nextSlot,
    courtLabel: `Court ${((position - 1) % 2) + 1}`,
    scheduledAt: new Date(1_700_000_000_000 + position * 3_600_000).toISOString(),
    sets: [],
    href: `/m/m${position}`,
  });
  return [
    { ...base(1, 1, 'm5', 'a'), teamA: team(1), teamB: null, status: 'bye', winnerId: 't1' },
    { ...base(2, 1, 'm5', 'b'), teamA: team(4), teamB: team(5), status: 'final', winnerId: 't4', sets: [{ a: 21, b: 17 }, { a: 21, b: 19 }] },
    { ...base(3, 1, 'm6', 'a'), teamA: team(2), teamB: null, status: 'bye', winnerId: 't2' },
    { ...base(4, 1, 'm6', 'b'), teamA: team(3), teamB: team(6), status: 'in_progress', sets: [{ a: 21, b: 18 }, { a: 12, b: 15 }] },
    { ...base(5, 2, 'm7', 'a'), teamA: team(1), teamB: team(4) },
    { ...base(6, 2, 'm7', 'b'), teamA: team(2), teamB: null },
    base(7, 3, null, null),
  ];
}

const TZ = 'America/Los_Angeles';

afterEach(cleanup);

describe('bracket model', () => {
  it('lays rounds out as columns with a connector per feeder, and picks the live match as current', () => {
    const layout = layoutBracket(sixTeamBracket());
    expect(layout.rounds).toBe(3);
    expect(layout.columns.map((c) => c.label)).toEqual(['Quarterfinals', 'Semifinals', 'Final']);
    expect(layout.connectors).toHaveLength(6);
    expect(layout.connectors.filter((c) => c.advanced).map((c) => c.fromId)).toEqual(['m1', 'm2', 'm3']);
    expect(pickCurrentMatch(sixTeamBracket())?.id).toBe('m4');
    expect(neighborOf(layout, 'm4', 'up')).toBe('m3');
    expect(neighborOf(layout, 'm4', 'right')).toBe('m6');
    expect(neighborOf(layout, 'm7', 'right')).toBeNull();
    expect(neighborOf(layout, 'm7', 'left')).toBe('m5');
  });

  it('builds nodes from public matches and from a draw preview, dropping pool matches and disputed numbers', () => {
    const nodes = nodesFromMatches(
      [
        { id: 'x', round: 1, bracketPosition: 1, poolId: null, status: 'disputed', teamAId: 't1', teamBId: 't2', winnerTeamId: null, nextMatchId: null, nextMatchSlot: null, courtLabel: 'Court 1', scheduledAt: null, sets: [{ teamAPoints: 21, teamBPoints: 19 }] },
        { id: 'p', round: 1, bracketPosition: null, poolId: 'pool', status: 'final', teamAId: 't1', teamBId: 't2', winnerTeamId: 't1', nextMatchId: null, nextMatchSlot: null, courtLabel: null, scheduledAt: null, sets: [] },
      ],
      [
        { id: 't1', name: 'One', seed: 1, members: [{ displayName: 'A B' }] },
        { id: 't2', name: 'Two', seed: null, members: [] },
      ],
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.sets).toEqual([]);
    expect(nodes[0]?.teamA?.members).toEqual(['A B']);
    const preview = nodesFromDraw(
      [
        { poolSequence: null, round: 1, bracketPosition: 1, courtLabel: 'Court 1', teamAId: 't1', teamBId: null, teamASeed: 1, teamBSeed: null, status: 'bye', scheduledAt: '2026-09-18T16:00:00.000Z', nextPosition: 3, nextSlot: 'a' },
        { poolSequence: 0, round: 1, bracketPosition: null, courtLabel: 'Court 2', teamAId: 't1', teamBId: 't2', teamASeed: null, teamBSeed: null, status: 'scheduled', scheduledAt: '2026-09-18T16:00:00.000Z', nextPosition: null, nextSlot: null },
      ],
      { t1: { name: 'One', seed: 1 } },
    );
    expect(preview).toHaveLength(1);
    expect(preview[0]).toMatchObject({ id: 'p1', nextId: 'p3', winnerId: 't1', href: null });
  });
});

describe('Bracket', () => {
  it('renders rounds as a list of lists with labels and one link per match', () => {
    render(<Bracket nodes={sixTeamBracket()} timeZone={TZ} label="Sandbar bracket" />);
    const rounds = screen.getByRole('list', { name: 'Sandbar bracket rounds' });
    const columns = within(rounds)
      .getAllByRole('listitem')
      .filter((li) => li.getAttribute('aria-label') !== null);
    expect(columns.map((c) => c.getAttribute('aria-label'))).toEqual(['Quarterfinals', 'Semifinals', 'Final']);
    const links = screen.getAllByRole('link').filter((l) => l.getAttribute('href')?.startsWith('/m/') === true);
    expect(links).toHaveLength(7 + 1);
    expect(screen.getByRole('link', { name: /Quarterfinals: 4 Team 4 versus 5 Team 5, sets 21–17, 21–19, Court 2, final/ }).getAttribute('href')).toBe('/m/m2');
  });

  it('renders byes honestly: one team, the word Bye, and an advanced connector', () => {
    const { container } = render(<Bracket nodes={sixTeamBracket()} timeZone={TZ} />);
    const bye = screen.getByRole('link', { name: /Quarterfinals: 1 Team 1 advances on a bye, Court 1, bye/ });
    expect(bye.getAttribute('data-status')).toBe('bye');
    expect(within(bye).getByText('Bye')).toBeTruthy();
    expect(within(bye).queryByText('TBD')).toBeNull();
    const paths = container.querySelectorAll('path[data-from="m1"]');
    expect(paths).toHaveLength(1);
    expect(paths[0]?.getAttribute('data-to')).toBe('m5');
    expect(paths[0]?.getAttribute('data-advanced')).toBe('true');
    expect(container.querySelector('path[data-from="m5"]')?.getAttribute('data-advanced')).toBe('false');
    const final = screen.getByRole('link', { name: /^Final: to be decided versus to be decided/ });
    expect(within(final).getAllByText('TBD')).toHaveLength(2);
  });

  it('pins the live match with its scores in a polite live region', () => {
    const { container } = render(<Bracket nodes={sixTeamBracket()} timeZone={TZ} />);
    const pinned = container.querySelector<HTMLElement>('[aria-label="Current match"]')!;
    expect(within(pinned).getByText('On the sand')).toBeTruthy();
    const live = pinned.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toContain('Team 3');
    expect(live?.textContent).toContain('Team 6');
    expect(within(pinned).getByRole('link', { name: /Open/ }).getAttribute('href')).toBe('/m/m4');
  });

  it('moves focus with the arrow keys along a roving tabindex and stays on links Enter can follow', () => {
    const { container } = render(<Bracket nodes={sixTeamBracket()} timeZone={TZ} />);
    const node = (id: string) => container.querySelector<HTMLElement>(`[data-node-id="${id}"]`)!;
    expect(node('m4').getAttribute('tabindex')).toBe('0');
    expect(node('m1').getAttribute('tabindex')).toBe('-1');
    node('m4').focus();
    expect(document.activeElement).toBe(node('m4'));
    fireEvent.keyDown(node('m4'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(node('m3'));
    expect(node('m3').getAttribute('tabindex')).toBe('0');
    expect(node('m4').getAttribute('tabindex')).toBe('-1');
    fireEvent.keyDown(node('m3'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(node('m6'));
    fireEvent.keyDown(node('m6'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(node('m7'));
    fireEvent.keyDown(node('m7'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(node('m7'));
    fireEvent.keyDown(node('m7'), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(node('m5'));
    fireEvent.keyDown(node('m5'), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(node('m1'));
    fireEvent.keyDown(node('m1'), { key: 'End' });
    expect(document.activeElement).toBe(node('m4'));
    fireEvent.keyDown(node('m4'), { key: 'Home' });
    expect(document.activeElement).toBe(node('m1'));
    expect(node('m1').tagName.toLowerCase()).toBe('a');
    expect(node('m1').getAttribute('href')).toBe('/m/m1');
  });

  it('draws a connector that becomes advanced after mount over --d-draw, and never on first paint', () => {
    const { container, rerender } = render(<Bracket nodes={sixTeamBracket()} timeZone={TZ} />);
    expect(container.querySelectorAll('path.path-draw')).toHaveLength(0);
    for (const path of container.querySelectorAll('path[data-from]')) expect(path.getAttribute('pathLength')).toBe('1');
    const advanced = sixTeamBracket().map((n) => (n.id === 'm4' ? { ...n, status: 'final' as const, winnerId: 't3', sets: [{ a: 21, b: 18 }, { a: 21, b: 15 }] } : n.id === 'm6' ? { ...n, teamB: team(3) } : n));
    rerender(<Bracket nodes={advanced} timeZone={TZ} />);
    const path = container.querySelector('path[data-from="m4"]');
    expect(path?.getAttribute('data-advanced')).toBe('true');
    expect(path?.getAttribute('data-drawing')).toBe('true');
    expect(path?.classList.contains('path-draw')).toBe(true);
    expect(container.querySelectorAll('path.path-draw')).toHaveLength(1);
    act(() => {
      fireEvent(path!, new Event('webkitAnimationEnd', { bubbles: true }));
    });
    expect(path?.classList.contains('path-draw')).toBe(false);
    rerender(<Bracket nodes={advanced.map((n) => ({ ...n }))} timeZone={TZ} />);
    expect(container.querySelectorAll('path.path-draw')).toHaveLength(0);
  });

  it('renders a preview without links as focusable groups and offers the view controls', () => {
    const nodes = sixTeamBracket().map((n) => ({ ...n, href: null }));
    render(<Bracket nodes={nodes} timeZone={TZ} label="Preview" />);
    expect(screen.queryAllByRole('link').filter((l) => l.getAttribute('href')?.startsWith('/m/') === true)).toHaveLength(0);
    expect(screen.getByRole('group', { name: /Quarterfinals: 1 Team 1 advances on a bye/ }).getAttribute('tabindex')).toBe('-1');
    for (const name of ['Zoom in', 'Zoom out', 'Fit whole bracket', 'Go to current match']) expect(screen.getByRole('button', { name })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Locate' })).toBeTruthy();
  });

  it('renders nothing for an empty bracket', () => {
    const { container } = render(<Bracket nodes={[]} timeZone={TZ} />);
    expect(container.innerHTML).toBe('');
  });

  const canvas = () => screen.getByRole('group', { name: /^Bracket canvas/ }) as unknown as SVGSVGElement;
  const canvasTransform = () => {
    const g = canvas().querySelector<SVGGElement>(':scope > g')!;
    const m = /translate\((-?[\d.]+) (-?[\d.]+)\) scale\(([\d.]+)\)/.exec(g.getAttribute('transform') ?? '');
    if (m === null) throw new Error(`unexpected transform ${g.getAttribute('transform')}`);
    return { x: Number(m[1]), y: Number(m[2]), k: Number(m[3]) };
  };

  it('pans on a wheel burst while it can move, then lets the page scroll', () => {
    render(<Bracket nodes={sixTeamBracket()} timeZone={TZ} />);
    const svg = canvas();
    const start = canvasTransform();
    expect(start.k).toBe(1);
    const events = [0, 1].map(() => new WheelEvent('wheel', { deltaY: -50, bubbles: true, cancelable: true }));
    const consumed: boolean[] = [];
    act(() => {
      for (const e of events) {
        svg.dispatchEvent(e);
        consumed.push(e.defaultPrevented);
      }
    });
    expect(consumed).toEqual([true, true]);
    expect(canvasTransform().y).toBe(start.y + 100);
    const over = new WheelEvent('wheel', { deltaY: -10_000, bubbles: true, cancelable: true });
    const stuck = new WheelEvent('wheel', { deltaY: -50, bubbles: true, cancelable: true });
    act(() => {
      svg.dispatchEvent(over);
      consumed.push(over.defaultPrevented);
      svg.dispatchEvent(stuck);
      consumed.push(stuck.defaultPrevented);
    });
    expect(consumed).toEqual([true, true, true, false]);
    expect(canvasTransform().y).toBe(0);
  });

  it('swallows the click that follows a drag, never the next Enter or tap', () => {
    const { container } = render(<Bracket nodes={sixTeamBracket()} timeZone={TZ} />);
    const svg = canvas();
    const link = container.querySelector<HTMLElement>('[data-node-id="m4"]')!;
    const clickAllowed = (target: Element) => {
      const click = new MouseEvent('click', { bubbles: true, cancelable: true });
      act(() => {
        target.dispatchEvent(click);
      });
      return !click.defaultPrevented;
    };
    fireEvent.pointerDown(svg, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(svg, { pointerId: 1, pointerType: 'mouse', clientX: 10, clientY: 60 });
    fireEvent.pointerUp(svg, { pointerId: 1, pointerType: 'mouse', clientX: 10, clientY: 60 });
    expect(clickAllowed(link)).toBe(false);
    expect(clickAllowed(link)).toBe(true);
    fireEvent.pointerDown(svg, { pointerId: 2, pointerType: 'touch', clientX: 30, clientY: 30 });
    fireEvent.pointerUp(svg, { pointerId: 2, pointerType: 'touch', clientX: 30, clientY: 30 });
    expect(clickAllowed(link)).toBe(true);
  });
});
