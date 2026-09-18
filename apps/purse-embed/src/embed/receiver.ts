import { emptyDropCounts, parseToEmbedMessage, type DropCounts, type DropReason, type ToEmbedMessage } from '@purse/types';

/**
 * The frame's side of spec 4.8 rules 3 and 4. A `Receiver` is told the one origin it may
 * talk to (the `parent` the frame was opened with, once the tenant's allowlist confirmed
 * it) and the window that origin lives in; every message is checked for origin, source,
 * schema and, after the handshake, nonce, and anything that fails is dropped and counted.
 * Pure: it neither posts nor renders, so it is tested against synthetic events.
 */
export type Verdict = { ok: true; message: ToEmbedMessage } | { ok: false; reason: DropReason };

export class Receiver {
  private readonly counts: DropCounts = emptyDropCounts();
  private nonce: string | undefined;

  constructor(
    readonly parentOrigin: string,
    private readonly parentWindow: () => Window | null,
  ) {}

  get drops(): DropCounts {
    return { ...this.counts };
  }

  get established(): boolean {
    return this.nonce !== undefined;
  }

  /** The nonce the parent minted in `hello`, once accepted; every later message must carry it. */
  get currentNonce(): string | undefined {
    return this.nonce;
  }

  private drop(reason: DropReason): Verdict {
    this.counts[reason] += 1;
    return { ok: false, reason };
  }

  /** Judge one `message` event. A `hello` before the handshake establishes the nonce; a second `hello` is unexpected. */
  validate(event: Pick<MessageEvent, 'origin' | 'source' | 'data'>): Verdict {
    if (event.origin !== this.parentOrigin || event.source !== this.parentWindow()) return this.drop('origin');
    const parsed = parseToEmbedMessage(event.data);
    if (!parsed.ok) return this.drop(parsed.reason);
    const message = parsed.message;
    if (message.type === 'hello') {
      if (this.nonce !== undefined) return this.drop('unexpected');
      this.nonce = message.nonce;
      return { ok: true, message };
    }
    if (this.nonce === undefined || message.nonce !== this.nonce) return this.drop('nonce');
    return { ok: true, message };
  }
}

/** The parent origin from the frame's URL, if it is an origin; the allowlist decides whether it may be used. */
export function parentOriginOf(search: string): string | undefined {
  const value = new URLSearchParams(search).get('parent');
  if (value === null) return undefined;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.origin !== value) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}
