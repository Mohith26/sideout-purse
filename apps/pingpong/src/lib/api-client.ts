/**
 * The browser side of the ladder's API: same-origin JSON with the session cookie, resolved
 * to the `{ data } | { error }` envelope (`server/http/respond.ts`) so a component branches
 * on `ok` and `error.code`, never on a thrown fetch error.
 */
export type ApiError = { type: string; code: string; message: string; detail?: unknown };

export type ApiResult<T> = ({ ok: true; data: T } | { ok: false; error: ApiError }) & { status: number };

const TRANSPORT: ApiError = { type: 'internal_error', code: 'unavailable', message: 'Could not reach the ladder. Check your connection and try again.' };

function isEnvelope(value: unknown): value is { data: unknown } | { error: ApiError } {
  if (typeof value !== 'object' || value === null) return false;
  if ('data' in value) return true;
  if (!('error' in value)) return false;
  const { error } = value;
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string' && typeof (error as { message?: unknown }).message === 'string';
}

export async function api<T>(path: string, options: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown } = {}): Promise<ApiResult<T>> {
  const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { accept: 'application/json', ...(options.body === undefined ? {} : { 'content-type': 'application/json' }) },
      cache: 'no-store',
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch {
    return { ok: false, error: TRANSPORT, status: 0 };
  }
  let parsed: unknown;
  try {
    const text = await response.text();
    parsed = text === '' ? null : JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!isEnvelope(parsed)) {
    return { ok: false, error: { type: 'internal_error', code: response.ok ? 'internal' : 'unavailable', message: response.ok ? 'The server sent an unexpected reply.' : `The server answered ${response.status}.` }, status: response.status };
  }
  if ('data' in parsed) return { ok: true, data: parsed.data as T, status: response.status };
  return { ok: false, error: parsed.error, status: response.status };
}
