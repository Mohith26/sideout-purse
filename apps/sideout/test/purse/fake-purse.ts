import { createHash, randomUUID } from 'node:crypto';

import { IDEMPOTENCY_KEY_HEADER, IDEMPOTENT_REPLAYED_HEADER, type ApiError, type ContestState, type PrizeStructure } from '@purse/types';

/**
 * An in-memory Purse behind a `fetch`: enough of the v1 contract (spec 4.7) for the
 * server tests to exercise Sideout's side of the boundary without a Purse process:
 * bearer secret keys, `Idempotency-Key` replay and conflict, users and wallets, contests
 * with the lifecycle, entries with escrow, scores with the finished-attempt rule and the
 * automatic move to `awaiting_settlement`, a preview whose hash the close checks, and
 * void. Every request is logged for assertions, and failures can be injected. It is not
 * Purse: the integration test (`test/integration`) runs the real one.
 */
type Stored = { status: number; body: unknown; requestHash: string };
type FakeUser = { id: string; externalId: string; displayName: string | null; phoneE164: string | null; wallet: Record<string, bigint>; verification: string };
type Participant = { id: string; userId: string; state: 'entered' | 'withdrawn'; joinedAt: string; journalEntryId: string; seed: number | null; teamRef: string | null };
type Score = { id: string; userId: string; score: number | null; attemptFinished: boolean; submittedAt: string; sourceRef: string | null; superseded: boolean };
type FakeContest = {
  id: string;
  externalId: string;
  title: string;
  kind: string;
  asset: 'POINTS' | 'CREDIT';
  entryAmount: bigint;
  maxParticipants: number | null;
  prizeStructure: PrizeStructure;
  state: ContestState;
  escrow: bigint;
  participants: Participant[];
  scores: Score[];
  settledAt: string | null;
  results: Array<{ id: string; contestId: string; userId: string; placement: number; score: number | null; payoutAmount: string; payoutJournalEntryId: string; computedAt: string }> | null;
  payoutHash: string | null;
};

export type LoggedRequest = { method: string; path: string; headers: Record<string, string>; body: unknown; idempotencyKey: string | null; replayed: boolean; status: number };

const uuid = (): string => randomUUID().replace(/^(.{14})./, '$17');
const id = (prefix: string): string => `${prefix}_${uuid()}`;

function fail(status: number, error: ApiError): Response {
  return new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json' } });
}

function hashOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export class FakePurse {
  readonly secretKey = `sk_sandbox_${'A'.repeat(32)}`;
  readonly users = new Map<string, FakeUser>();
  readonly contests = new Map<string, FakeContest>();
  readonly requests: LoggedRequest[] = [];
  readonly idempotency = new Map<string, Stored>();
  readonly endpoints: Array<{ id: string; url: string; secret: string }> = [];
  /** The next `n` requests fail at the transport (no response at all). */
  failNext = 0;
  /** The next request is refused with this envelope. */
  refuseNext: { status: number; error: ApiError } | null = null;
  /** A request this returns true for fails at the transport; `seen` counts earlier requests to the same path. */
  failWhen: ((request: { method: string; path: string; seen: number }) => boolean) | null = null;
  private now = 0;

  readonly fetch: typeof fetch = async (input, init) => {
    await Promise.resolve();
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const raw = typeof init?.body === 'string' ? init.body : null;
    const body: unknown = raw === null || raw.length === 0 ? null : JSON.parse(raw);
    const key = headers[IDEMPOTENCY_KEY_HEADER.toLowerCase()] ?? null;
    const log: LoggedRequest = { method, path: url.pathname, headers, body, idempotencyKey: key, replayed: false, status: 0 };
    this.requests.push(log);

    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new TypeError('fetch failed: connection refused');
    }
    if (this.failWhen?.({ method, path: url.pathname, seen: this.requests.filter((r) => r.path === url.pathname && r.method === method).length - 1 }) === true) {
      throw new TypeError('fetch failed: connection reset');
    }
    if (headers['authorization'] !== `Bearer ${this.secretKey}`) return this.answer(log, fail(401, { type: 'authentication_error', code: 'invalid_api_key', message: 'The API key is not valid' }));
    if (this.refuseNext !== null) {
      const refusal = this.refuseNext;
      this.refuseNext = null;
      return this.answer(log, fail(refusal.status, refusal.error));
    }
    if (method !== 'GET') {
      if (key === null) return this.answer(log, fail(400, { type: 'invalid_request', code: 'missing_idempotency_key', message: 'Idempotency-Key is required' }));
      const stored = this.idempotency.get(key);
      const requestHash = hashOf({ method, path: url.pathname, body });
      if (stored !== undefined) {
        if (stored.requestHash !== requestHash) {
          return this.answer(log, fail(409, { type: 'conflict', code: 'idempotency_key_reused', message: `Idempotency-Key ${key} was already used for a different request`, detail: { idempotencyKey: key } }));
        }
        log.replayed = true;
        return this.answer(log, new Response(JSON.stringify(stored.body), { status: stored.status, headers: { 'content-type': 'application/json', [IDEMPOTENT_REPLAYED_HEADER]: 'true' } }));
      }
      const response = this.route(method, url.pathname, body);
      if (response.status < 500) {
        const text = await response.clone().text();
        this.idempotency.set(key, { status: response.status, body: JSON.parse(text), requestHash });
      }
      return this.answer(log, response);
    }
    return this.answer(log, this.route(method, url.pathname, body));
  };

  private answer(log: LoggedRequest, response: Response): Response {
    log.status = response.status;
    return response;
  }

  private tick(): string {
    this.now += 1;
    return new Date(Date.UTC(2026, 8, 19, 16, 0, this.now)).toISOString();
  }

  private ok(data: unknown, status = 200): Response {
    return new Response(JSON.stringify({ data }), { status, headers: { 'content-type': 'application/json' } });
  }

  // ---- Routing ------------------------------------------------------------------------------

  private route(method: string, path: string, body: unknown): Response {
    const b = (body ?? {}) as Record<string, unknown>;
    let m: RegExpExecArray | null;
    if (method === 'POST' && path === '/v1/users') return this.upsertUser(b);
    if ((m = /^\/v1\/users\/([^/]+)$/.exec(path)) && method === 'GET') return this.getUser(m[1] ?? '');
    if ((m = /^\/v1\/users\/([^/]+)\/wallet$/.exec(path)) && method === 'GET') return this.getWallet(m[1] ?? '');
    if ((m = /^\/v1\/users\/([^/]+)\/credits$/.exec(path)) && method === 'POST') return this.credit(m[1] ?? '', b);
    if (method === 'POST' && path === '/v1/embed/tokens') return this.embedToken(b);
    if (method === 'POST' && path === '/v1/contests') return this.createContest(b);
    if ((m = /^\/v1\/contests\/([^/]+)$/.exec(path)) && method === 'GET') return this.withContest(m[1] ?? '', (c) => this.ok(this.contestResource(c)));
    if ((m = /^\/v1\/contests\/([^/]+)\/(open|lock|start|finish)$/.exec(path)) && method === 'POST') return this.withContest(m[1] ?? '', (c) => this.transition(c, m?.[2] ?? ''));
    if ((m = /^\/v1\/contests\/([^/]+)\/entries$/.exec(path)) && method === 'POST') return this.withContest(m[1] ?? '', (c) => this.enter(c, b));
    if ((m = /^\/v1\/contests\/([^/]+)\/scores$/.exec(path)) && method === 'POST') return this.withContest(m[1] ?? '', (c) => this.submitScores(c, b));
    if ((m = /^\/v1\/contests\/([^/]+)\/preview$/.exec(path)) && method === 'GET') return this.withContest(m[1] ?? '', (c) => this.ok(this.preview(c)));
    if ((m = /^\/v1\/contests\/([^/]+)\/close$/.exec(path)) && method === 'POST') return this.withContest(m[1] ?? '', (c) => this.close(c, b));
    if ((m = /^\/v1\/contests\/([^/]+)\/void$/.exec(path)) && method === 'POST') return this.withContest(m[1] ?? '', (c) => this.voidContest(c));
    if ((m = /^\/v1\/contests\/([^/]+)\/results$/.exec(path)) && method === 'GET') return this.withContest(m[1] ?? '', (c) => this.ok({ contestId: c.id, state: c.state, settledAt: c.settledAt, results: c.results ?? [] }));
    if (method === 'POST' && path === '/v1/webhooks/endpoints') {
      const endpoint = { id: id('whe'), url: String(b['url']), secret: `whsec_${'B'.repeat(32)}` };
      this.endpoints.push(endpoint);
      return this.ok({ ...endpoint, subscribedEvents: b['subscribedEvents'], status: 'enabled', description: null, createdAt: this.tick(), updatedAt: this.tick() }, 201);
    }
    return fail(404, { type: 'invalid_request', code: 'not_found', message: `No route ${method} ${path}` });
  }

  private withContest(contestId: string, fn: (contest: FakeContest) => Response): Response {
    const contest = this.contests.get(contestId);
    if (contest === undefined) return fail(400, { type: 'invalid_request', code: 'contest_not_found', message: `No contest ${contestId}` });
    return fn(contest);
  }

  // ---- Users ---------------------------------------------------------------------------------

  private userResource(user: FakeUser) {
    return {
      id: user.id,
      externalId: user.externalId,
      displayName: user.displayName,
      phoneE164: user.phoneE164,
      dateOfBirth: null,
      verification: { state: user.verification, provider: null, verifiedAt: null, reverifyAfter: null },
      restrictions: [],
      location: null,
      createdAt: '2026-09-19T16:00:00.000Z',
      updatedAt: this.tick(),
    };
  }

  private upsertUser(b: Record<string, unknown>): Response {
    const externalId = String(b['externalId']);
    let user = [...this.users.values()].find((u) => u.externalId === externalId);
    const created = user === undefined;
    if (user === undefined) {
      user = { id: id('usr'), externalId, displayName: null, phoneE164: null, wallet: {}, verification: 'unstarted' };
      this.users.set(user.id, user);
    }
    if (typeof b['displayName'] === 'string') user.displayName = b['displayName'];
    if (typeof b['phoneE164'] === 'string') user.phoneE164 = b['phoneE164'];
    return this.ok(this.userResource(user), created ? 201 : 200);
  }

  private getUser(userId: string): Response {
    const user = this.users.get(userId);
    if (user === undefined) return fail(400, { type: 'invalid_request', code: 'user_not_found', message: `No user ${userId}` });
    return this.ok(this.userResource(user));
  }

  private walletResource(user: FakeUser) {
    return { userId: user.id, balances: ['POINTS', 'CREDIT'].map((asset) => ({ asset, balance: (user.wallet[asset] ?? 0n).toString(), accountId: user.wallet[asset] === undefined ? null : `acct_${asset.toLowerCase()}` })) };
  }

  private getWallet(userId: string): Response {
    const user = this.users.get(userId);
    if (user === undefined) return fail(400, { type: 'invalid_request', code: 'user_not_found', message: `No user ${userId}` });
    return this.ok(this.walletResource(user));
  }

  private credit(userId: string, b: Record<string, unknown>): Response {
    const user = this.users.get(userId);
    if (user === undefined) return fail(400, { type: 'invalid_request', code: 'user_not_found', message: `No user ${userId}` });
    const asset = String(b['asset']);
    const amount = BigInt(String(b['amount']));
    user.wallet[asset] = (user.wallet[asset] ?? 0n) + amount;
    return this.ok({ userId, asset, amount: amount.toString(), journalEntryId: id('je'), balance: (user.wallet[asset] ?? 0n).toString() }, 201);
  }

  private embedToken(b: Record<string, unknown>): Response {
    const user = this.users.get(String(b['userId']));
    if (user === undefined) return fail(400, { type: 'invalid_request', code: 'user_not_found', message: 'No such user' });
    return this.ok({ token: `embt_${'C'.repeat(43)}`, replayed: false, flow: b['flow'], userId: user.id, expiresAt: this.tick() }, 201);
  }

  // ---- Contests ------------------------------------------------------------------------------

  contestResource(c: FakeContest) {
    return {
      id: c.id,
      externalId: c.externalId,
      kind: c.kind,
      title: c.title,
      asset: c.asset,
      entryAmount: c.entryAmount.toString(),
      maxParticipants: c.maxParticipants,
      prizeStructure: c.prizeStructure,
      tieBreak: 'split_evenly',
      settlementPolicy: 'operator_close',
      eligibilityRulesetVersion: '2026.09.1',
      state: c.state,
      opensAt: null,
      locksAt: null,
      escrowAccountId: `acct_${c.id}`,
      escrowBalance: c.escrow.toString(),
      participantCount: c.participants.filter((p) => p.state === 'entered').length,
      settledAt: c.settledAt,
      createdAt: '2026-09-19T16:00:00.000Z',
      updatedAt: this.tick(),
    };
  }

  private createContest(b: Record<string, unknown>): Response {
    const externalId = String(b['externalId']);
    if ([...this.contests.values()].some((c) => c.externalId === externalId)) {
      return fail(409, { type: 'conflict', code: 'external_id_taken', message: `A contest with external_id ${externalId} already exists` });
    }
    const contest: FakeContest = {
      id: id('cnt'),
      externalId,
      title: String(b['title']),
      kind: String(b['kind']),
      asset: b['asset'] === 'CREDIT' ? 'CREDIT' : 'POINTS',
      entryAmount: BigInt(String(b['entryAmount'])),
      maxParticipants: typeof b['maxParticipants'] === 'number' ? b['maxParticipants'] : null,
      prizeStructure: b['prizeStructure'] as PrizeStructure,
      state: 'draft',
      escrow: 0n,
      participants: [],
      scores: [],
      settledAt: null,
      results: null,
      payoutHash: null,
    };
    this.contests.set(contest.id, contest);
    return this.ok(this.contestResource(contest), 201);
  }

  private static readonly NEXT: Record<string, [from: ContestState, to: ContestState]> = {
    open: ['draft', 'open'],
    lock: ['open', 'locked'],
    start: ['locked', 'in_progress'],
    finish: ['in_progress', 'awaiting_settlement'],
  };

  private transition(c: FakeContest, name: string): Response {
    const edge = FakePurse.NEXT[name];
    if (edge?.[0] !== c.state) {
      return fail(409, { type: 'invalid_state', code: 'invalid_transition', message: `Contest ${c.id} is ${c.state} and cannot ${name}`, detail: { contestId: c.id, from: c.state } });
    }
    c.state = edge[1];
    return this.ok(this.contestResource(c));
  }

  private enter(c: FakeContest, b: Record<string, unknown>): Response {
    const user = this.users.get(String(b['userId']));
    if (user === undefined) return fail(400, { type: 'invalid_request', code: 'user_not_found', message: 'No such user' });
    if (c.state !== 'open') return fail(403, { type: 'not_eligible', code: 'not_eligible', message: 'The contest is not open', detail: { reasons: ['contest_not_open'], rulesetVersion: '2026.09.1' } });
    if (c.participants.some((p) => p.userId === user.id && p.state === 'entered')) return fail(409, { type: 'conflict', code: 'already_entered', message: 'Already entered' });
    if ((user.wallet[c.asset] ?? 0n) < c.entryAmount) return fail(402, { type: 'insufficient_funds', code: 'insufficient_funds', message: 'Not enough balance', detail: { reasons: ['insufficient_balance'], requiredAction: 'add_funds', rulesetVersion: '2026.09.1' } });
    user.wallet[c.asset] = (user.wallet[c.asset] ?? 0n) - c.entryAmount;
    c.escrow += c.entryAmount;
    const participant: Participant = { id: id('ent'), userId: user.id, state: 'entered', joinedAt: this.tick(), journalEntryId: id('je'), seed: typeof b['seed'] === 'number' ? b['seed'] : null, teamRef: typeof b['teamRef'] === 'string' ? b['teamRef'] : null };
    c.participants.push(participant);
    return this.ok({ contest: this.contestResource(c), participant: this.participantResource(c, participant), eligibility: { allowed: true, rulesetVersion: '2026.09.1' }, journalEntryId: participant.journalEntryId }, 201);
  }

  private participantResource(c: FakeContest, p: Participant) {
    return { id: p.id, contestId: c.id, userId: p.userId, teamRef: p.teamRef, seed: p.seed, state: p.state, joinedAt: p.joinedAt, entryJournalEntryId: p.journalEntryId };
  }

  private submitScores(c: FakeContest, b: Record<string, unknown>): Response {
    if (c.state !== 'in_progress' && c.state !== 'awaiting_settlement') {
      return fail(409, { type: 'invalid_state', code: 'scores_not_accepted', message: `Contest ${c.id} is ${c.state}`, detail: { contestId: c.id, state: c.state } });
    }
    const batch = b['scores'] as Array<{ userId: string; score: number | null; attemptFinished: boolean; sourceRef?: string | null }>;
    for (const each of batch) {
      const participant = c.participants.find((p) => p.userId === each.userId);
      if (participant === undefined) return fail(400, { type: 'invalid_request', code: 'not_a_participant', message: `User ${each.userId} has not entered contest ${c.id}` });
      if (participant.state !== 'entered') return fail(409, { type: 'invalid_state', code: 'participant_not_active', message: `User ${each.userId} is ${participant.state}` });
      const finished = c.scores.find((s) => s.userId === each.userId && !s.superseded && s.attemptFinished);
      if (finished !== undefined) return fail(409, { type: 'invalid_state', code: 'attempt_already_finished', message: `User ${each.userId} already has a finished attempt`, detail: { userId: each.userId } });
    }
    const written: Score[] = [];
    for (const each of batch) {
      for (const old of c.scores) if (old.userId === each.userId && !old.superseded) old.superseded = true;
      const row: Score = { id: id('sco'), userId: each.userId, score: each.score, attemptFinished: each.attemptFinished, submittedAt: this.tick(), sourceRef: each.sourceRef ?? null, superseded: false };
      c.scores.push(row);
      written.push(row);
    }
    const entered = c.participants.filter((p) => p.state === 'entered');
    if (c.state === 'in_progress' && entered.every((p) => c.scores.some((s) => s.userId === p.userId && !s.superseded && s.attemptFinished))) c.state = 'awaiting_settlement';
    return this.ok({ contest: this.contestResource(c), scores: written.map((s) => ({ id: s.id, contestId: c.id, userId: s.userId, score: s.score, attemptFinished: s.attemptFinished, submittedAt: s.submittedAt, sourceRef: s.sourceRef })), settlement: null }, 201);
  }

  /** A settlement in the spirit of Purse's: rank by score (unscored last, ties shared), weights over the pool, floor division, remainder to the best placement. */
  private settle(c: FakeContest): Array<{ userId: string; placement: number; payout: bigint }> {
    const entered = c.participants.filter((p) => p.state === 'entered');
    const scoreOf = (userId: string): number | null => c.scores.find((s) => s.userId === userId && !s.superseded)?.score ?? null;
    const ranked = entered
      .map((p) => ({ userId: p.userId, score: scoreOf(p.userId) }))
      .sort((x, y) => (y.score ?? -Infinity) - (x.score ?? -Infinity) || (x.userId < y.userId ? -1 : 1));
    const placements: Array<{ userId: string; placement: number; score: number | null }> = [];
    ranked.forEach((r, index) => {
      const previous = placements[index - 1];
      placements.push({ ...r, placement: previous?.score === r.score && previous !== undefined ? previous.placement : index + 1 });
    });
    const weights: bigint[] =
      c.prizeStructure.type === 'percentage_split'
        ? c.prizeStructure.percentages.map((p) => BigInt(p))
        : c.prizeStructure.type === 'placement_table'
          ? c.prizeStructure.placements.map((row) => ('amount' in row ? BigInt(row.amount) : BigInt(row.percent)))
          : [1n];
    const scored = placements.filter((p) => p.score !== null);
    const groups = new Map<number, string[]>();
    for (const p of scored) groups.set(p.placement, [...(groups.get(p.placement) ?? []), p.userId]);
    const weightFor = (placement: number, size: number): bigint => {
      let total = 0n;
      for (let i = placement; i < placement + size; i += 1) total += weights[i - 1] ?? 0n;
      return total;
    };
    const totalWeight = [...groups.entries()].reduce((sum, [placement, members]) => sum + weightFor(placement, members.length), 0n);
    const payouts = new Map<string, bigint>(entered.map((p) => [p.userId, 0n]));
    let paid = 0n;
    if (totalWeight > 0n) {
      for (const [placement, members] of groups) {
        const share = (c.escrow * weightFor(placement, members.length)) / totalWeight;
        for (const userId of members) {
          const each = share / BigInt(members.length);
          payouts.set(userId, each);
          paid += each;
        }
      }
    } else if (scored.length === 0 && entered.length > 0) {
      const each = c.escrow / BigInt(entered.length);
      for (const p of entered) {
        payouts.set(p.userId, each);
        paid += each;
      }
    }
    let remainder = c.escrow - paid;
    for (const p of [...placements].sort((x, y) => x.placement - y.placement || (x.userId < y.userId ? -1 : 1))) {
      if (remainder <= 0n) break;
      payouts.set(p.userId, (payouts.get(p.userId) ?? 0n) + 1n);
      remainder -= 1n;
    }
    return placements.map((p) => ({ userId: p.userId, placement: p.placement, payout: payouts.get(p.userId) ?? 0n }));
  }

  private payoutHash(payouts: Array<{ userId: string; placement: number; payout: bigint }>): string {
    const canonical = [...payouts].sort((x, y) => x.placement - y.placement || (x.userId < y.userId ? -1 : 1)).map((p) => [p.placement, p.userId, p.payout.toString()]);
    return createHash('sha256').update(JSON.stringify({ v: 1, payouts: canonical })).digest('hex');
  }

  preview(c: FakeContest) {
    const payouts = c.results === null ? this.settle(c) : c.results.map((r) => ({ userId: r.userId, placement: r.placement, payout: BigInt(r.payoutAmount) }));
    return {
      contestId: c.id,
      state: c.state,
      escrowTotal: c.results === null ? c.escrow.toString() : payouts.reduce((sum, p) => sum + p.payout, 0n).toString(),
      entries: c.participants
        .filter((p) => p.state === 'entered')
        .map((p) => {
          const score = c.scores.find((s) => s.userId === p.userId && !s.superseded);
          return { userId: p.userId, participantId: p.id, participantState: p.state, score: score?.score ?? null, seed: p.seed, attemptFinished: score?.attemptFinished ?? false };
        }),
      payouts: payouts.map((p) => ({ userId: p.userId, placement: p.placement, payout: p.payout.toString() })),
      payoutHash: c.payoutHash ?? this.payoutHash(payouts),
    };
  }

  private close(c: FakeContest, b: Record<string, unknown>): Response {
    if (c.state !== 'awaiting_settlement') return fail(409, { type: 'invalid_state', code: 'invalid_transition', message: `Contest ${c.id} is ${c.state} and cannot settle`, detail: { contestId: c.id, from: c.state } });
    const payouts = this.settle(c);
    const computed = this.payoutHash(payouts);
    if (b['payoutHash'] !== computed) {
      return fail(409, { type: 'conflict', code: 'preview_hash_mismatch', message: 'The payout preview is stale: the contest’s inputs changed since it was computed.', detail: { contestId: c.id, presented: b['payoutHash'], computed } });
    }
    for (const p of payouts) {
      const user = this.users.get(p.userId);
      if (user !== undefined) user.wallet[c.asset] = (user.wallet[c.asset] ?? 0n) + p.payout;
    }
    c.escrow = 0n;
    c.state = 'settled';
    c.settledAt = this.tick();
    c.payoutHash = computed;
    const computedAt = c.settledAt;
    c.results = payouts.map((p) => ({
      id: id('res'),
      contestId: c.id,
      userId: p.userId,
      placement: p.placement,
      score: c.scores.find((s) => s.userId === p.userId && !s.superseded)?.score ?? null,
      payoutAmount: p.payout.toString(),
      payoutJournalEntryId: id('je'),
      computedAt,
    }));
    return this.ok({ contest: this.contestResource(c), results: c.results, payoutHash: computed, journalEntryId: id('je') });
  }

  private voidContest(c: FakeContest): Response {
    if (!['open', 'locked', 'in_progress', 'awaiting_settlement'].includes(c.state)) {
      return fail(409, { type: 'invalid_state', code: 'invalid_transition', message: `Contest ${c.id} is ${c.state} and cannot be voided` });
    }
    const refunds: string[] = [];
    for (const p of c.participants.filter((x) => x.state === 'entered')) {
      const user = this.users.get(p.userId);
      if (user !== undefined) user.wallet[c.asset] = (user.wallet[c.asset] ?? 0n) + c.entryAmount;
      refunds.push(id('je'));
    }
    c.escrow = 0n;
    c.state = 'voided';
    return this.ok({ contest: this.contestResource(c), refundJournalEntryIds: refunds });
  }

  // ---- Helpers for tests ----------------------------------------------------------------------

  contestByExternalId(externalId: string): FakeContest | undefined {
    return [...this.contests.values()].find((c) => c.externalId === externalId);
  }

  userByExternalId(externalId: string): FakeUser | undefined {
    return [...this.users.values()].find((u) => u.externalId === externalId);
  }

  requestsTo(pathPattern: RegExp, method?: string): LoggedRequest[] {
    return this.requests.filter((r) => pathPattern.test(r.path) && (method === undefined || r.method === method));
  }
}
