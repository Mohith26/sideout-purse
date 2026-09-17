import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { createLogger, errorFields, resolveBuildSha } from '../src/index';

describe('logger', () => {
  it('emits one JSON object per line with service, level, time and bound fields', () => {
    const lines: string[] = [];
    const logger = createLogger({ service: 'purse-api', level: 'info', write: (l) => lines.push(l) });
    logger.child({ requestId: 'req-1' }).info('hello', { n: 1n });
    logger.debug('hidden below threshold');

    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(record).toMatchObject({ service: 'purse-api', level: 'info', msg: 'hello', requestId: 'req-1', n: '1' });
    expect(typeof record['time']).toBe('string');
    expect(Number.isNaN(Date.parse(record['time'] as string))).toBe(false);
  });

  it('serialises errors without throwing on non-Error values', () => {
    expect(errorFields(new Error('boom'))).toMatchObject({ err: { name: 'Error', message: 'boom' } });
    expect(errorFields('string failure')).toEqual({ err: { message: 'string failure' } });
  });
});

describe('build sha', () => {
  it('prefers the sha the deploy set', () => {
    expect(resolveBuildSha('deadbeef')).toBe('deadbeef');
  });

  it('falls back to the git HEAD of the checkout it runs in', () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    expect(resolveBuildSha(undefined)).toBe(head);
    expect(resolveBuildSha('')).toBe(head);
  });
});
