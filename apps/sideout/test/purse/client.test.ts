import { describe, expect, it } from 'vitest';

import { PurseApiError, PurseClient, PurseResponseError, PurseUnreachableError, redact, type CallOutcome, type CallRecorder, type CallStart } from '../../src/purse';
import { FakePurse } from './fake-purse';

/** An in-memory recorder: what `purse_calls` would hold. */
function memoryRecorder() {
  const calls: Array<{ id: string; start: CallStart; outcome: CallOutcome | null }> = [];
  const recorder: CallRecorder = {
    async begin(start) {
      await Promise.resolve();
      const id = `pcl_${calls.length + 1}`;
      calls.push({ id, start, outcome: null });
      return id;
    },
    async finish(id, outcome) {
      await Promise.resolve();
      const call = calls.find((c) => c.id === id);
      if (call === undefined) throw new Error('unknown call');
      call.outcome = outcome;
    },
  };
  return { recorder, calls };
}

describe('PurseClient', () => {
  const REQUEST_ID = 'req_0123456789';

  function client(fake: FakePurse, fetchImpl: typeof fetch = fake.fetch) {
    const { recorder, calls } = memoryRecorder();
    return { purse: new PurseClient({ baseUrl: 'http://purse.test/', secretKey: fake.secretKey, recorder, fetch: fetchImpl }), calls };
  }

  it('refuses a key that is not a secret key, and never lets the secret into a recorded call', async () => {
    expect(() => new PurseClient({ baseUrl: 'http://purse.test', secretKey: 'pk_sandbox_' + 'A'.repeat(32), recorder: memoryRecorder().recorder })).toThrow(/sk_sandbox/);
    expect(() => new PurseClient({ baseUrl: 'ftp://purse.test', secretKey: 'sk_sandbox_' + 'A'.repeat(32), recorder: memoryRecorder().recorder })).toThrow(/http/);
    const fake = new FakePurse();
    const { purse, calls } = client(fake);
    await purse.upsertUser({ externalId: 'sideout-user-1', displayName: `sk_sandbox_${'Z'.repeat(32)} leaked` }, { requestId: REQUEST_ID, idempotencyKey: 'k1' });
    expect(JSON.stringify(calls)).not.toContain(fake.secretKey);
    expect(JSON.stringify(calls)).not.toContain('Z'.repeat(32));
    expect(calls[0]?.start.requestBody).toEqual({ externalId: 'sideout-user-1', displayName: '[redacted] leaked' });
    expect(purse.environment).toBe('sandbox');
  });

  it('sends the bearer key, the request id and the idempotency key, and parses the resource', async () => {
    const fake = new FakePurse();
    const { purse, calls } = client(fake);
    const created = await purse.upsertUser({ externalId: 'sideout-user-1', displayName: 'Ana' }, { requestId: REQUEST_ID, idempotencyKey: 'k1', subject: { type: 'user', id: 'sou_1' } });
    expect(created.status).toBe(201);
    expect(created.replayed).toBe(false);
    expect(created.data.externalId).toBe('sideout-user-1');
    const sent = fake.requests[0];
    expect(sent?.headers['authorization']).toBe(`Bearer ${fake.secretKey}`);
    expect(sent?.headers['x-request-id']).toBe(REQUEST_ID);
    expect(sent?.headers['idempotency-key']).toBe('k1');
    expect(calls[0]?.start).toMatchObject({ method: 'POST', path: '/v1/users', idempotencyKey: 'k1', subject: { type: 'user', id: 'sou_1' } });
    expect(calls[0]?.outcome).toMatchObject({ status: 'succeeded', responseStatus: 201, replayed: false });

    const replay = await purse.upsertUser({ externalId: 'sideout-user-1', displayName: 'Ana' }, { requestId: REQUEST_ID, idempotencyKey: 'k1' });
    expect(replay.replayed).toBe(true);
    expect(replay.data.id).toBe(created.data.id);
    expect(calls[1]?.outcome).toMatchObject({ status: 'succeeded', replayed: true });

    const read = await purse.getUser(created.data.id, { requestId: REQUEST_ID });
    expect(read.data.id).toBe(created.data.id);
    expect(fake.requests[2]?.headers['idempotency-key']).toBeUndefined();
  });

  it('refuses a mutation without a key and a read with one, before any request leaves', async () => {
    const fake = new FakePurse();
    const { purse } = client(fake);
    await expect(purse.upsertUser({ externalId: 'x' }, { requestId: REQUEST_ID })).rejects.toThrow(/Idempotency-Key/);
    await expect(purse.getUser('usr_x', { requestId: REQUEST_ID, idempotencyKey: 'k' })).rejects.toThrow(/no Idempotency-Key/);
    expect(fake.requests).toHaveLength(0);
  });

  it('maps an error envelope to PurseApiError with the sealed type and code, and records the refusal', async () => {
    const fake = new FakePurse();
    const { purse, calls } = client(fake);
    await purse.upsertUser({ externalId: 'a' }, { requestId: REQUEST_ID, idempotencyKey: 'k1' });
    const conflict = purse.upsertUser({ externalId: 'b' }, { requestId: REQUEST_ID, idempotencyKey: 'k1' });
    await expect(conflict).rejects.toBeInstanceOf(PurseApiError);
    await expect(conflict).rejects.toMatchObject({ status: 409, type: 'conflict', code: 'idempotency_key_reused', requestId: REQUEST_ID });
    expect(calls[1]?.outcome).toMatchObject({ status: 'refused', responseStatus: 409 });
    expect((calls[1]?.outcome as { responseBody: { error: { code: string } } }).responseBody.error.code).toBe('idempotency_key_reused');
  });

  it('turns a transport failure, a non-JSON body and a body off the resource shape into their own errors, each recorded', async () => {
    const fake = new FakePurse();
    fake.failNext = 1;
    const { purse, calls } = client(fake);
    await expect(purse.getUser('usr_x', { requestId: REQUEST_ID })).rejects.toBeInstanceOf(PurseUnreachableError);
    expect(calls[0]?.outcome).toMatchObject({ status: 'failed', error: 'TypeError: fetch failed: connection refused', responseStatus: null });

    const html = client(fake, async () => {
      await Promise.resolve();
      return new Response('<html>502</html>', { status: 502 });
    });
    await expect(html.purse.getUser('usr_x', { requestId: REQUEST_ID })).rejects.toBeInstanceOf(PurseUnreachableError);
    expect(html.calls[0]?.outcome).toMatchObject({ status: 'failed', responseStatus: 502 });

    const wrongShape = client(fake, async () => {
      await Promise.resolve();
      return new Response(JSON.stringify({ data: { id: 'usr_00000000-0000-7000-8000-000000000001', externalId: 'x' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    await expect(wrongShape.purse.getUser('usr_x', { requestId: REQUEST_ID })).rejects.toBeInstanceOf(PurseResponseError);
    expect(wrongShape.calls[0]?.outcome).toMatchObject({ status: 'failed', responseStatus: 200 });

    const noEnvelope = client(fake, async () => {
      await Promise.resolve();
      return new Response(JSON.stringify({ message: 'nope' }), { status: 400, headers: { 'content-type': 'application/json' } });
    });
    await expect(noEnvelope.purse.getUser('usr_x', { requestId: REQUEST_ID })).rejects.toBeInstanceOf(PurseResponseError);
  });

  it('waits out a rate limit and sends the same request again, recording every attempt; a limit that never lifts is the answer', async () => {
    const fake = new FakePurse();
    const { recorder, calls } = memoryRecorder();
    const waits: number[] = [];
    let answers = 0;
    const limited: typeof fetch = async (input, init) => {
      answers += 1;
      if (answers <= 2) return new Response(JSON.stringify({ error: { type: 'rate_limited', code: 'too_many_requests', message: 'Rate limit exceeded; retry in 1s' } }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '1' } });
      return fake.fetch(input, init);
    };
    const purse = new PurseClient({ baseUrl: 'http://purse.test', secretKey: fake.secretKey, recorder, fetch: limited, sleep: async (ms) => { waits.push(ms); await Promise.resolve(); } });
    const created = await purse.upsertUser({ externalId: 'limited' }, { requestId: REQUEST_ID, idempotencyKey: 'k-limited' });
    expect(created.status).toBe(201);
    expect(waits).toEqual([1000, 1000]);
    expect(calls.map((c) => c.outcome?.status)).toEqual(['refused', 'refused', 'succeeded']);
    expect(fake.requests).toHaveLength(1);

    answers = -100;
    const always = purse.getUser('usr_x', { requestId: REQUEST_ID });
    await expect(always).rejects.toMatchObject({ status: 429, code: 'too_many_requests', retryAfterMs: 1000 });
    expect(waits).toHaveLength(2 + 3);
  });

  it('redacts every credential shape and secret-named field, and renders bigint as a decimal string', () => {
    expect(redact({ token: 'embt_abc', secret: 'whsec_x', nested: { key: `sk_live_${'B'.repeat(32)}`, amount: 5n }, list: ['whsec_' + 'C'.repeat(10)] })).toEqual({
      token: '[redacted]',
      secret: '[redacted]',
      nested: { key: '[redacted]', amount: '5' },
      list: ['[redacted]'],
    });
    expect(redact({ token: '' })).toEqual({ token: '' });
  });
});
