import { describe, expect, it } from 'vitest';

import { createLogger, errorFields } from '../src/logger';

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
