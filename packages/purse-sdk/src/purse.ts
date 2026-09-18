import {
  emptyDropCounts,
  MOUNTABLE_FLOWS,
  PROTOCOL_VERSION,
  parseTheme,
  parseToParentMessage,
  type ApiError,
  type ApiErrorType,
  type DropCounts,
  type DropReason,
  type EmbedError,
  type EmbedUserState,
  type FlowContext,
  type FlowResult,
  type MountableFlow,
  type Theme,
  type ToEmbedMessage,
  type ToParentMessage,
} from '@purse/types';

import { resolveOrigin } from './keys';

/**
 * The partner-facing client (spec 4.8). `Purse.init` validates the publishable key and
 * resolves the Purse origin; `mount` puts a flow in an iframe served from that origin and
 * runs the handshake; `getUserState` reads through the frame when one is mounted and
 * otherwise headlessly over the publishable-key endpoint (rule 7); `on` delivers
 * `flow:complete`, `error` (the sealed shape from 4.5 and 4.7), `resize` and `state`.
 *
 * Every message the SDK sends goes through `post`, which targets the resolved origin and
 * never `'*'` (rule 2; `test/no-wildcard.test.ts` greps this file for it). Every message
 * it receives is checked for origin, source window, schema and nonce, and one that fails
 * is dropped and counted in `drops` (rules 3 and 4). No framework, no dependency but
 * `@purse/types`.
 */
export type PurseInitOptions = {
  publishableKey: string;
  tenantId: string;
  theme?: Theme;
  /** Overrides the origin the key's environment implies; local development points it at `http://localhost:4000`. */
  purseOrigin?: string;
  /** How long a mount waits for the frame's handshake before it fails. */
  handshakeTimeoutMs?: number;
  /** The window the SDK lives in; defaults to the global one. Tests pass a jsdom window. */
  window?: Window;
  /** The fetch used by the headless read; defaults to the global one. */
  fetch?: typeof fetch;
};

export type MountOptions = {
  flow: MountableFlow;
  /** From `POST /v1/embed/tokens` or `POST /v1/users/:id/verification`; every flow but `signin` needs one. */
  embedToken?: string;
  /** The contest an `entry` flow confirms. */
  contestId?: string;
  /** The frame's height until it reports its own, in pixels. */
  initialHeight?: number;
};

export type Mounted = { flow: MountableFlow; state: EmbedUserState; frame: HTMLIFrameElement };

export type PurseEvents = {
  'flow:complete': FlowResult;
  error: EmbedError;
  resize: { height: number };
  state: EmbedUserState;
};

export type PurseEventName = keyof PurseEvents;
export type Handler<E extends PurseEventName> = (payload: PurseEvents[E]) => void;

export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;
export const DEFAULT_FRAME_HEIGHT = 480;

/** An error the SDK itself raises, in the API's sealed shape so `on('error')` has one branch. */
export class PurseError extends Error {
  override readonly name = 'PurseError';
  readonly detail: Record<string, unknown> | undefined;
  constructor(
    readonly type: ApiErrorType,
    readonly code: string,
    message: string,
    detail?: Record<string, unknown>,
  ) {
    super(message);
    this.detail = detail;
  }
  toJSON(): ApiError {
    return { type: this.type, code: this.code, message: this.message, ...(this.detail === undefined ? {} : { detail: this.detail }) };
  }
}

type Session = {
  frame: HTMLIFrameElement;
  flow: MountableFlow;
  hello: Omit<ToEmbedMessage & { type: 'hello' }, 'nonce'>;
  nonce: string | undefined;
  handshake: { resolve: (mounted: Mounted) => void; reject: (error: PurseError) => void; timer: ReturnType<typeof setTimeout> } | undefined;
  stateReads: Array<{ resolve: (state: EmbedUserState) => void }>;
  state: EmbedUserState | undefined;
};

function randomNonce(): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export class Purse {
  readonly origin: string;
  readonly tenantId: string;
  readonly publishableKey: string;
  readonly theme: Theme | null;
  private readonly win: Window;
  private readonly fetchImpl: typeof fetch;
  private readonly handshakeTimeoutMs: number;
  private readonly handlers = new Map<PurseEventName, Set<Handler<PurseEventName>>>();
  private readonly counts: DropCounts = emptyDropCounts();
  private session: Session | undefined;
  private readonly listener = (event: MessageEvent): void => {
    this.receive(event);
  };

  private constructor(options: PurseInitOptions) {
    this.publishableKey = options.publishableKey;
    this.tenantId = options.tenantId;
    this.origin = resolveOrigin(options.publishableKey, options.purseOrigin);
    this.theme = options.theme === undefined ? null : Purse.validTheme(options.theme);
    this.win = options.window ?? globalThis.window;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  }

  /** Validate the options and resolve the origin. Async for the spec's `await Purse.init(...)` shape; it does no network. */
  static init(options: PurseInitOptions): Promise<Purse> {
    if (typeof options.tenantId !== 'string' || !/^tnt_[0-9a-f-]{36}$/.test(options.tenantId)) {
      return Promise.reject(new PurseError('invalid_request', 'invalid_tenant_id', 'tenantId must be a Purse tenant id (tnt_...)'));
    }
    try {
      return Promise.resolve(new Purse(options));
    } catch (error) {
      return Promise.reject(new PurseError('invalid_request', 'invalid_init_options', error instanceof Error ? error.message : String(error)));
    }
  }

  private static validTheme(theme: Theme): Theme {
    const parsed = parseTheme(theme);
    if (!parsed.ok) throw new RangeError(`theme: ${parsed.issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`);
    return parsed.theme;
  }

  /** Drops by reason since init (spec 4.8 rule 3). A copy: the counter itself is private. */
  get drops(): DropCounts {
    return { ...this.counts };
  }

  get mounted(): boolean {
    return this.session !== undefined;
  }

  on<E extends PurseEventName>(event: E, handler: Handler<E>): () => void {
    let set = this.handlers.get(event);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as Handler<PurseEventName>);
    return () => this.off(event, handler);
  }

  off<E extends PurseEventName>(event: E, handler: Handler<E>): void {
    this.handlers.get(event)?.delete(handler as Handler<PurseEventName>);
  }

  private emit<E extends PurseEventName>(event: E, payload: PurseEvents[E]): void {
    for (const handler of this.handlers.get(event) ?? []) (handler as Handler<E>)(payload);
  }

  /**
   * Put a flow in the slot. Resolves once the frame has redeemed the token and answered
   * the handshake; rejects, and emits `error`, when the token is refused, the frame reports
   * a fatal error, or nothing answers within the handshake timeout. One flow at a time: a
   * second mount replaces the first.
   */
  mount(slot: string | Element, options: MountOptions): Promise<Mounted> {
    const target = typeof slot === 'string' ? this.win.document.querySelector(slot) : slot;
    if (target === null || target === undefined) {
      return Promise.reject(new PurseError('invalid_request', 'slot_not_found', `No element matches ${typeof slot === 'string' ? slot : 'the given element'}`));
    }
    if (!(MOUNTABLE_FLOWS as readonly string[]).includes(options.flow)) {
      return Promise.reject(new PurseError('invalid_request', 'unknown_flow', `Unknown flow ${String(options.flow)}`, { flows: [...MOUNTABLE_FLOWS] }));
    }
    if (options.flow !== 'signin' && options.embedToken === undefined) {
      return Promise.reject(new PurseError('invalid_request', 'embed_token_required', `The ${options.flow} flow needs an embed token`));
    }
    if (options.flow === 'entry' && options.contestId === undefined) {
      return Promise.reject(new PurseError('invalid_request', 'contest_id_required', 'The entry flow needs the contest to confirm'));
    }
    this.unmount();

    const doc = this.win.document;
    const frame = doc.createElement('iframe');
    // The frame learns three things from its URL: the flow, the parent origin it may
    // answer (checked against the tenant's allowlist before it says a word), and the
    // publishable key (public by design) it reads that allowlist with. The embed token
    // never travels in a URL: it goes in `hello`, after the frame has checked the parent.
    const url = new URL('/embed/', this.origin);
    url.searchParams.set('flow', options.flow);
    url.searchParams.set('parent', this.win.location.origin);
    url.searchParams.set('pk', this.publishableKey);
    url.searchParams.set('v', String(PROTOCOL_VERSION));
    frame.src = url.toString();
    frame.title = `Purse ${options.flow}`;
    frame.setAttribute('scrolling', 'no');
    frame.style.width = '100%';
    frame.style.border = '0';
    frame.style.display = 'block';
    frame.style.overflow = 'hidden';
    frame.style.height = `${options.initialHeight ?? DEFAULT_FRAME_HEIGHT}px`;

    const context: FlowContext = options.contestId === undefined ? {} : { contestId: options.contestId };
    const session: Session = {
      frame,
      flow: options.flow,
      hello: { v: PROTOCOL_VERSION, type: 'hello', flow: options.flow, publishableKey: this.publishableKey, embedToken: options.embedToken ?? null, theme: this.theme, context },
      nonce: undefined,
      handshake: undefined,
      stateReads: [],
      state: undefined,
    };
    this.session = session;
    this.win.addEventListener('message', this.listener);

    return new Promise<Mounted>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new PurseError('internal_error', 'embed_timeout', `The Purse frame did not complete the handshake within ${this.handshakeTimeoutMs} ms`);
        this.failHandshake(session, error);
      }, this.handshakeTimeoutMs);
      session.handshake = { resolve, reject, timer };
      target.replaceChildren(frame);
    });
  }

  /** Remove the frame and the listener; a pending mount rejects. */
  unmount(): void {
    const session = this.session;
    if (session === undefined) return;
    this.session = undefined;
    this.win.removeEventListener('message', this.listener);
    if (session.handshake !== undefined) {
      clearTimeout(session.handshake.timer);
      session.handshake.reject(new PurseError('internal_error', 'unmounted', 'The flow was unmounted before the handshake completed'));
      session.handshake = undefined;
    }
    for (const read of session.stateReads) read.resolve({ authenticated: false, user: null });
    session.stateReads = [];
    session.frame.remove();
  }

  /** Ask the frame to report its content height again (rule 6), for instance after the slot's width changed. */
  requestResize(): void {
    const session = this.session;
    if (session?.nonce === undefined) return;
    this.post(session, { v: PROTOCOL_VERSION, type: 'resize:request', nonce: session.nonce });
  }

  /**
   * The user's state. Through the frame once the handshake is done, otherwise the headless
   * read: `GET /v1/embed/state` on the Purse origin with the publishable key and the
   * browser's Purse session cookie (rule 7). A visitor with no Purse session is
   * `{ authenticated: false }`, not an error.
   */
  async getUserState(): Promise<EmbedUserState> {
    const session = this.session;
    if (session?.nonce !== undefined) {
      const nonce = session.nonce;
      return new Promise<EmbedUserState>((resolve) => {
        session.stateReads.push({ resolve });
        this.post(session, { v: PROTOCOL_VERSION, type: 'state:request', nonce });
      });
    }
    const response = await this.fetchImpl(`${this.origin}/v1/embed/state`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.publishableKey}`, Accept: 'application/json' },
      credentials: 'include',
      mode: 'cors',
    });
    const body = (await response.json().catch(() => ({}))) as { data?: EmbedUserState; error?: ApiError };
    if (!response.ok || body.data === undefined) {
      const error = body.error ?? { type: 'internal_error', code: 'unexpected_response', message: `Purse answered ${response.status}` };
      this.emit('error', error);
      throw new PurseError(error.type, error.code, error.message, error.detail);
    }
    return body.data;
  }

  /** The one place a message leaves the SDK: always to the resolved origin, never `'*'`. */
  private post(session: Session, message: ToEmbedMessage): void {
    session.frame.contentWindow?.postMessage(message, this.origin);
  }

  private drop(reason: DropReason): void {
    this.counts[reason] += 1;
  }

  private failHandshake(session: Session, error: PurseError): void {
    const handshake = session.handshake;
    if (handshake === undefined) return;
    clearTimeout(handshake.timer);
    session.handshake = undefined;
    this.emit('error', error.toJSON());
    handshake.reject(error);
  }

  private receive(event: MessageEvent): void {
    const session = this.session;
    if (session === undefined) return;
    // Rule 3: the origin first, then the source window (another frame on the Purse
    // origin is still not our frame), then the schema; rule 4: the nonce.
    if (event.origin !== this.origin || event.source !== session.frame.contentWindow) return this.drop('origin');
    const parsed = parseToParentMessage(event.data);
    if (!parsed.ok) return this.drop(parsed.reason);
    const message = parsed.message;
    if (message.type === 'ready') return this.onReady(session);
    if (session.nonce === undefined || message.nonce !== session.nonce) return this.drop('nonce');
    this.dispatch(session, message);
  }

  private onReady(session: Session): void {
    // A second `ready` (the frame reloaded) after the handshake would carry no nonce; the
    // frame is told hello again only while the handshake is still open.
    if (session.handshake === undefined) return this.drop('unexpected');
    session.nonce ??= randomNonce();
    this.post(session, { ...session.hello, nonce: session.nonce });
  }

  private dispatch(session: Session, message: Exclude<ToParentMessage, { type: 'ready' }>): void {
    switch (message.type) {
      case 'hello_ack': {
        const handshake = session.handshake;
        if (handshake === undefined || message.flow !== session.flow) return this.drop('unexpected');
        clearTimeout(handshake.timer);
        session.handshake = undefined;
        session.state = message.state;
        handshake.resolve({ flow: session.flow, state: message.state, frame: session.frame });
        return;
      }
      case 'resize':
        session.frame.style.height = `${message.height}px`;
        this.emit('resize', { height: message.height });
        return;
      case 'flow:complete':
        if (message.result.flow !== session.flow) return this.drop('unexpected');
        this.emit('flow:complete', message.result);
        return;
      case 'error':
        if (session.handshake !== undefined && message.fatal) {
          this.failHandshake(session, new PurseError(message.error.type, message.error.code, message.error.message, message.error.detail));
          return;
        }
        this.emit('error', message.error);
        return;
      case 'state': {
        session.state = message.state;
        const reads = session.stateReads;
        session.stateReads = [];
        for (const read of reads) read.resolve(message.state);
        this.emit('state', message.state);
        return;
      }
    }
  }
}
