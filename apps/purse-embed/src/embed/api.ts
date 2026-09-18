import type { ApiError, ContestResource, EmbedFlow, EmbedUserState, EntryResource, VerificationResource } from '@purse/types';

/**
 * The frame's client for `/v1/embed/*`, same-origin (the API serves this app under
 * `/embed`; in development the Next dev server proxies `/v1`). Every call carries the
 * publishable key and the browser's Purse session cookie; every mutation carries a fresh
 * `Idempotency-Key`. A non-2xx answer is thrown as the API's sealed error, which the
 * flows relay to the parent unchanged.
 */
export class EmbedApiError extends Error {
  override readonly name = 'EmbedApiError';
  constructor(
    readonly error: ApiError,
    readonly status: number,
  ) {
    super(error.message);
  }
}

export type RewardRow = {
  contestId: string;
  externalId: string;
  title: string;
  asset: string;
  placement: number;
  score: string | null;
  payoutAmount: string;
  computedAt: string;
};

export type SigninStarted = { sent: true; expiresAt: string; devCode: string | null };

export class EmbedApi {
  constructor(
    readonly publishableKey: string,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.publishableKey}`, Accept: 'application/json' };
    if (method === 'POST') {
      headers['Content-Type'] = 'application/json';
      headers['Idempotency-Key'] = globalThis.crypto.randomUUID();
    }
    const response = await this.fetchImpl(`/v1/embed${path}`, { method, headers, credentials: 'include', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const envelope = (await response.json().catch(() => ({}))) as { data?: T; error?: ApiError };
    if (!response.ok || envelope.data === undefined) {
      throw new EmbedApiError(envelope.error ?? { type: 'internal_error', code: 'unexpected_response', message: `Purse answered ${response.status}` }, response.status);
    }
    return envelope.data;
  }

  origins(): Promise<{ origins: string[] }> {
    return this.call('GET', '/origins');
  }

  state(): Promise<EmbedUserState> {
    return this.call('GET', '/state');
  }

  openSession(input: { embedToken: string; flow: EmbedFlow; parentOrigin: string }): Promise<EmbedUserState> {
    return this.call('POST', '/session', input);
  }

  startSignin(phoneE164: string): Promise<SigninStarted> {
    return this.call('POST', '/signin/start', { phoneE164 });
  }

  verifySignin(phoneE164: string, code: string): Promise<EmbedUserState> {
    return this.call('POST', '/signin/verify', { phoneE164, code });
  }

  signout(): Promise<EmbedUserState> {
    return this.call('POST', '/signout', {});
  }

  startIdentity(): Promise<{ verification: VerificationResource; state: EmbedUserState }> {
    return this.call('POST', '/identity/start', {});
  }

  contest(contestId: string): Promise<ContestResource> {
    return this.call('GET', `/contests/${encodeURIComponent(contestId)}`);
  }

  enter(contestId: string): Promise<EntryResource> {
    return this.call('POST', `/contests/${encodeURIComponent(contestId)}/entries`, {});
  }

  rewards(): Promise<{ results: RewardRow[] }> {
    return this.call('GET', '/rewards');
  }
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof EmbedApiError) return error.error;
  return { type: 'internal_error', code: 'unexpected', message: error instanceof Error ? error.message : 'Something went wrong' };
}
