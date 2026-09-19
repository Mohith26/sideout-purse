import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { IDEMPOTENCY_KEY_HEADER, type ApiErrorType } from '@purse/types';

import type { ApiResponse, Client, RequestOptions } from '../http/client';

/**
 * Contract fixtures (spec section 8, "Contract"): one recorded request and response per
 * endpoint and per error type, normalised so ids, instants, hashes and secrets do not churn
 * the file, and compared against `src/docs/contract-fixtures.json`.
 * `UPDATE_CONTRACT_FIXTURES=1 pnpm --filter @purse/api test test/contract` rewrites it
 * after a deliberate change to the contract.
 *
 * The file lives under `src/` because the public `/docs` page renders it
 * (`src/routes/docs.ts`) and therefore ships: shipped source never imports from `test/`,
 * which `.dockerignore` drops from every image's build context (docs/decisions.md). It is
 * still written only from here, so the fixtures stay a single source of truth.
 */
export type Fixture = {
  name: string;
  request: { method: string; path: string; headers: Record<string, string>; body: unknown };
  response: { status: number; body: unknown };
};

export const FIXTURES_FILE = path.resolve(import.meta.dirname, '../../src/docs/contract-fixtures.json');

export function normalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalise);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) out[key] = normaliseField(key, normalise(inner));
    return out;
  }
  if (typeof value === 'string') return normaliseString(value);
  return value;
}

const ID = /^([a-z]{2,4})_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const HEX64 = /^[0-9a-f]{64}$/;
const EMBED = /^embt_[A-Za-z0-9_-]{43}$/;
const API_KEY = /^(sk|pk)_(sandbox|live)_[A-Za-z0-9]{32}$/;
const WEBHOOK_SECRET = /^whsec_[A-Za-z0-9_-]{43}$/;
const SIGNIN_CODE = /^\d{6}$/;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** An ES256 signature is randomised per signing, so an attestation's signature never pins. */
const ES256_SIGNATURE = /^[A-Za-z0-9_-]{86}$/;

function normaliseString(value: string): string {
  const id = ID.exec(value);
  if (id !== null) return `${id[1]}_<id>`;
  if (INSTANT.test(value)) return '<instant>';
  if (HEX64.test(value)) return '<sha256>';
  if (EMBED.test(value)) return '<embed-token>';
  if (API_KEY.test(value)) return '<api-key>';
  if (WEBHOOK_SECRET.test(value)) return '<webhook-secret>';
  if (REQUEST_ID.test(value)) return '<request-id>';
  return value
    .replace(/\b[a-z]+-\d+-[a-z0-9]+-\d+\b/g, '<idempotency-key>')
    .replace(/(sk|pk)_(sandbox|live)_[A-Za-z0-9]{8,32}/g, '<api-key>')
    .replace(/[a-z]{2,4}_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g, (match) => `${match.split('_')[0] ?? ''}_<id>`)
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z/g, '<instant>')
    .replace(/[0-9a-f]{64}/g, '<sha256>');
}

function normaliseField(key: string, value: unknown): unknown {
  if (key === 'idempotencyKey' && typeof value === 'string') return '<idempotency-key>';
  if (key === 'durationMs' && typeof value === 'number') return '<ms>';
  if ((key === 'devCode' || key === 'code') && typeof value === 'string' && SIGNIN_CODE.test(value)) return '<code>';
  if (key === 'signature' && typeof value === 'string' && ES256_SIGNATURE.test(value)) return '<signature>';
  return value;
}

export class Recorder {
  readonly fixtures: Fixture[] = [];

  constructor(readonly client: Client) {}

  async record<T = unknown>(name: string, method: string, requestPath: string, body?: unknown, options: RequestOptions = {}): Promise<ApiResponse<T>> {
    const response = await this.client.send<T>(method, requestPath, body, options);
    const headers: Record<string, string> = {};
    if (this.client.authorization !== undefined) headers['Authorization'] = this.client.authorization;
    for (const [name, value] of Object.entries(options.headers ?? {})) headers[name] = name.toLowerCase() === 'cookie' ? 'purse_session=<session-cookie>' : normaliseString(value);
    if (method !== 'GET' && options.idempotencyKey !== null) headers[IDEMPOTENCY_KEY_HEADER] = '<idempotency-key>';
    this.fixtures.push({
      name,
      request: { method, path: normaliseString(requestPath), headers, body: normalise(body ?? null) },
      response: { status: response.status, body: normalise(response.raw) },
    });
    return response;
  }

  /** The error types the recorded fixtures reach, with the codes seen under each. */
  errorTypes(): Map<ApiErrorType, Set<string>> {
    const seen = new Map<ApiErrorType, Set<string>>();
    for (const fixture of this.fixtures) {
      const body = fixture.response.body as { error?: { type: ApiErrorType; code: string } } | null;
      const error = body?.error;
      if (error === undefined) continue;
      const codes = seen.get(error.type) ?? new Set<string>();
      codes.add(error.code);
      seen.set(error.type, codes);
    }
    return seen;
  }

}

/** Compare every recorded fixture with the committed file, or rewrite it when asked to. Returns the names that differ. */
export function verifyFixtures(fixtures: readonly Fixture[]): string[] {
  const names = fixtures.map((fixture) => fixture.name);
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate !== undefined) throw new Error(`fixture ${duplicate} was recorded twice`);
  if (process.env['UPDATE_CONTRACT_FIXTURES'] === '1') {
    writeFileSync(FIXTURES_FILE, `${JSON.stringify(fixtures, null, 2)}\n`);
    return [];
  }
  const committed = JSON.parse(readFileSync(FIXTURES_FILE, 'utf8')) as Fixture[];
  const byName = new Map(committed.map((fixture) => [fixture.name, fixture]));
  const differing: string[] = [];
  for (const fixture of fixtures) {
    const expected = byName.get(fixture.name);
    if (expected === undefined || JSON.stringify(expected) !== JSON.stringify(fixture)) differing.push(fixture.name);
  }
  for (const fixture of committed) if (!fixtures.some((each) => each.name === fixture.name)) differing.push(`${fixture.name} (no longer recorded)`);
  return differing;
}
