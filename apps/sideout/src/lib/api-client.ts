/**
 * The browser side of Sideout's API: same-origin JSON with the session cookie, resolved
 * to the `{ data } | { error }` envelope (`server/http/respond.ts`) so a component
 * branches on `ok` and `error.code`, never on a thrown fetch error. A transport failure or
 * a body that is not an envelope becomes `unavailable` with `status` 0 (or the HTTP status),
 * which is what the offline outbox reads to decide whether to try again later.
 */
export type ApiError = { type: string; code: string; message: string; detail?: unknown };

export type ApiResult<T> = ({ ok: true; data: T } | { ok: false; error: ApiError }) & { status: number; retryAfterMs: number | null };

export type ApiRequestOptions = { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown };

const TRANSPORT: ApiError = { type: 'internal_error', code: 'unavailable', message: 'Could not reach Sideout. Check your connection and try again.' };

function isEnvelope(value: unknown): value is { data: unknown } | { error: ApiError } {
  if (typeof value !== 'object' || value === null) return false;
  if ('data' in value) return true;
  if (!('error' in value)) return false;
  const { error } = value;
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string' && typeof (error as { message?: unknown }).message === 'string';
}

export async function api<T>(path: string, options: ApiRequestOptions = {}): Promise<ApiResult<T>> {
  const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
  const init: RequestInit = {
    method,
    credentials: 'same-origin',
    headers: { accept: 'application/json', ...(options.body === undefined ? {} : { 'content-type': 'application/json' }) },
    cache: 'no-store',
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  };
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    return { ok: false, error: TRANSPORT, status: 0, retryAfterMs: null };
  }
  const retryAfter = response.headers.get('retry-after');
  const retryAfterMs = retryAfter !== null && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : null;
  let parsed: unknown;
  try {
    const text = await response.text();
    parsed = text === '' ? null : JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!isEnvelope(parsed)) {
    return {
      ok: false,
      error: { type: 'internal_error', code: response.ok ? 'internal' : 'unavailable', message: response.ok ? 'The server sent an unexpected reply.' : `The server answered ${response.status}.` },
      status: response.status,
      retryAfterMs,
    };
  }
  if ('data' in parsed) return { ok: true, data: parsed.data as T, status: response.status, retryAfterMs };
  return { ok: false, error: parsed.error, status: response.status, retryAfterMs };
}

/** Field messages from a `validation_failed` envelope (`z.treeifyError`), keyed by the field's path. */
export function fieldIssues(error: ApiError): Record<string, string> {
  const detail = error.detail;
  if (typeof detail !== 'object' || detail === null) return {};
  const out: Record<string, string> = {};
  const walk = (node: unknown, path: string) => {
    if (typeof node !== 'object' || node === null) return;
    const errors = (node as { errors?: unknown }).errors;
    if (Array.isArray(errors) && errors.length > 0 && path !== '' && !(path in out)) out[path] = String(errors[0]);
    const properties = (node as { properties?: unknown }).properties;
    if (typeof properties === 'object' && properties !== null) {
      for (const [key, child] of Object.entries(properties as Record<string, unknown>)) walk(child, path === '' ? key : `${path}.${key}`);
    }
  };
  walk(detail, '');
  return out;
}
