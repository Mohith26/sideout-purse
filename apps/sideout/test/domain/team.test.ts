import { describe, expect, it } from 'vitest';

import { assertTeamRoster, checkTeamRoster } from '../../src/domain/team';

const reason = (verdict: { ok: boolean; reason?: string }): string => (verdict.ok ? '' : (verdict.reason ?? ''));

describe('team roster', () => {
  it('accepts exactly one captain and one player', () => {
    expect(checkTeamRoster([{ userId: 'u1', role: 'captain' }, { userId: 'u2', role: 'player' }])).toEqual({ ok: true });
  });

  it('rejects wrong sizes, duplicates, and captain counts', () => {
    expect(reason(checkTeamRoster([{ userId: 'u1', role: 'captain' }]))).toContain('exactly 2');
    expect(
      checkTeamRoster([
        { userId: 'u1', role: 'captain' },
        { userId: 'u2', role: 'player' },
        { userId: 'u3', role: 'player' },
      ]),
    ).toMatchObject({ ok: false });
    expect(reason(checkTeamRoster([{ userId: 'u1', role: 'captain' }, { userId: 'u1', role: 'player' }]))).toContain('twice');
    expect(reason(checkTeamRoster([{ userId: 'u1', role: 'player' }, { userId: 'u2', role: 'player' }]))).toContain('captain');
    expect(() => assertTeamRoster([])).toThrow(/Invalid team roster/);
  });
});
