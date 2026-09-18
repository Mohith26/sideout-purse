// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FlipRows } from '../../src/components/motion/FlipRows';
import { easeOutExpo, ScoreDisplay } from '../../src/components/motion/ScoreDisplay';
import { motionDurationMs, prefersReducedMotion } from '../../src/components/motion/reduced-motion';

/**
 * The JavaScript-driven transitions (spec 6.3): the score count-up rolls to its value
 * over --d-base and settles with a fade, the FLIP wrapper slides moved rows, and both
 * collapse to opacity under `prefers-reduced-motion`.
 */
function reduceMotion(reduce: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ matches: reduce && query.includes('reduce'), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }),
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: undefined });
});

/** Drive requestAnimationFrame by hand so the roll can be stepped through. */
function frameClock() {
  let now = 0;
  const queue: FrameRequestCallback[] = [];
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    queue.push(cb);
    return queue.length;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  return {
    advance(ms: number) {
      now += ms;
      const pending = queue.splice(0);
      act(() => {
        for (const cb of pending) cb(now);
      });
    },
  };
}

describe('reduced-motion helpers', () => {
  it('reads the preference and the token defaults without computed styles', () => {
    expect(prefersReducedMotion()).toBe(false);
    reduceMotion(true);
    expect(prefersReducedMotion()).toBe(true);
    expect(motionDurationMs('--d-base')).toBe(220);
    expect(motionDurationMs('--d-draw')).toBe(700);
  });
});

describe('ScoreDisplay (transition 1)', () => {
  beforeEach(() => reduceMotion(false));

  it('renders the value as is on first paint, tabular', () => {
    render(<ScoreDisplay value={17} />);
    const el = screen.getByText('17');
    expect(el.className).toContain('score-roll');
    expect(el.dataset['value']).toBe('17');
    expect(el.dataset['rolling']).toBeUndefined();
  });

  it('rolls from the previous value to the new one over --d-base and settles exactly on it', () => {
    const clock = frameClock();
    const { rerender } = render(<ScoreDisplay value={10} />);
    rerender(<ScoreDisplay value={20} />);
    expect(screen.getByText('10').dataset['rolling']).toBe('true');
    clock.advance(110);
    const mid = Number(screen.getByText(/^\d+$/).textContent);
    expect(mid).toBeGreaterThan(10);
    expect(mid).toBeLessThanOrEqual(20);
    expect(mid).toBe(Math.round(10 + 10 * easeOutExpo(0.5)));
    clock.advance(200);
    const el = screen.getByText('20');
    expect(el.dataset['rolling']).toBeUndefined();
    expect(el.className).toContain('score-settle');
  });

  it('under reduced motion the number changes at once and only the opacity settle remains', () => {
    reduceMotion(true);
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    const { rerender } = render(<ScoreDisplay value={3} />);
    rerender(<ScoreDisplay value={9} />);
    expect(screen.getByText('9').className).toContain('score-settle');
    expect(raf).not.toHaveBeenCalled();
  });
});

/** jsdom has no layout: rows report a top of 40px times their index in the table. */
function layoutByIndex() {
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: HTMLElement) {
      const parent = this.parentElement;
      const index = parent === null ? 0 : Array.from(parent.children).indexOf(this);
      const top = index * 40;
      return { top, left: 0, width: 300, height: 40, right: 300, bottom: top + 40, x: 0, y: top, toJSON: () => ({}) };
    },
  });
}

function Table({ order }: { order: string[] }) {
  return (
    <table>
      <tbody>
        {order.map((id, i) => (
          <tr key={id} data-team-id={id} data-rank={i + 1}>
            <td>
              <span data-rank-delta-slot="" />
              {id}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

describe('FlipRows (transition 2)', () => {
  const animate = vi.fn();
  beforeEach(() => {
    reduceMotion(false);
    layoutByIndex();
    animate.mockReset();
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
  });

  it('plays nothing on first render and slides the rows that moved on a re-render', () => {
    const onFlip = vi.fn();
    const { rerender, container } = render(
      <FlipRows onFlip={onFlip}>
        <Table order={['a', 'b', 'c']} />
      </FlipRows>,
    );
    expect(onFlip).not.toHaveBeenCalled();
    rerender(
      <FlipRows onFlip={onFlip}>
        <Table order={['b', 'a', 'c']} />
      </FlipRows>,
    );
    expect(onFlip).toHaveBeenCalledWith(['b', 'a']);
    expect(animate).toHaveBeenCalledTimes(2);
    expect(animate.mock.calls[0]?.[0]).toEqual([{ transform: 'translate(0px, 40px)' }, { transform: 'none' }]);
    expect(animate.mock.calls[0]?.[1]).toMatchObject({ duration: 220 });
    const b = container.querySelector<HTMLElement>("[data-team-id='b']");
    expect(b?.classList.contains('rank-flash')).toBe(true);
    expect(b?.querySelector('[data-rank-delta-slot]')?.textContent).toBe('↑1');
  });

  it('under reduced motion the slide becomes an opacity-only cross-fade', () => {
    reduceMotion(true);
    const { rerender } = render(
      <FlipRows>
        <Table order={['a', 'b']} />
      </FlipRows>,
    );
    rerender(
      <FlipRows>
        <Table order={['b', 'a']} />
      </FlipRows>,
    );
    expect(animate).toHaveBeenCalled();
    for (const call of animate.mock.calls) for (const frame of call[0] as Keyframe[]) expect(Object.keys(frame)).toEqual(['opacity']);
  });
});
