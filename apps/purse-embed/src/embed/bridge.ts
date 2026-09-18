import {
  isTokenFlow,
  MOUNTABLE_FLOWS,
  PROTOCOL_VERSION,
  type ApiError,
  type DropCounts,
  type EmbedUserState,
  type FlowContext,
  type FlowResult,
  type HelloMessage,
  type MountableFlow,
  type Theme,
  type ToParentMessage,
} from '@purse/types';

import { EmbedApi, toApiError } from './api';
import { parentOriginOf, Receiver } from './receiver';
import { applyTheme } from './theme';

/**
 * The frame's side of the protocol (spec 4.8), driving the handshake and relaying the
 * flows' outcomes. A `Bridge` is created once per page load from the frame's URL: the
 * flow, the parent origin and the publishable key. It reads the tenant's allowlist with
 * the key, refuses to say anything to a parent that is not on it, and only then posts
 * `ready`, to that exact origin. `hello` brings the nonce, the theme, the token and the
 * context; the token is redeemed on the Purse origin for the session cookie, and the
 * answer is `hello_ack` with the user state, or a fatal `error`. Every later message in
 * either direction carries the nonce; every message out goes through `post`, which never
 * targets `'*'`.
 */
export type BridgeStatus =
  | { phase: 'starting' }
  | { phase: 'refused'; reason: 'bad_url' | 'origin_not_allowed' | 'origins_unavailable'; detail?: string }
  | { phase: 'waiting' }
  | { phase: 'ready'; flow: MountableFlow; state: EmbedUserState; context: FlowContext; theme: Theme | null }
  | { phase: 'failed'; error: ApiError };

export type BridgeDeps = {
  win: Window;
  api?: EmbedApi;
  /** The element whose height is reported; defaults to the document element. */
  measure?: () => number;
};

export class Bridge {
  readonly flow: MountableFlow | undefined;
  readonly parentOrigin: string | undefined;
  readonly publishableKey: string | undefined;
  readonly api: EmbedApi | undefined;
  private readonly win: Window;
  private readonly measure: () => number;
  private receiver: Receiver | undefined;
  private status: BridgeStatus = { phase: 'starting' };
  private readonly listeners = new Set<(status: BridgeStatus) => void>();
  private lastHeight = -1;
  private readonly onMessage = (event: MessageEvent): void => {
    this.receive(event);
  };

  constructor(deps: BridgeDeps) {
    this.win = deps.win;
    this.measure = deps.measure ?? (() => Math.ceil(this.win.document.documentElement.getBoundingClientRect().height));
    const params = new URLSearchParams(this.win.location.search);
    const flow = params.get('flow');
    this.flow = (MOUNTABLE_FLOWS as readonly string[]).includes(flow ?? '') ? (flow as MountableFlow) : undefined;
    this.parentOrigin = parentOriginOf(this.win.location.search);
    const pk = params.get('pk');
    this.publishableKey = pk !== null && /^pk_(sandbox|live)_[A-Za-z0-9]{32}$/.test(pk) ? pk : undefined;
    this.api = deps.api ?? (this.publishableKey === undefined ? undefined : new EmbedApi(this.publishableKey));
  }

  get current(): BridgeStatus {
    return this.status;
  }

  get drops(): DropCounts | undefined {
    return this.receiver?.drops;
  }

  subscribe(listener: (status: BridgeStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  private set(status: BridgeStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }

  /** Check the parent against the allowlist, then announce `ready`. Resolves once the frame is listening. */
  async start(): Promise<void> {
    if (this.flow === undefined || this.parentOrigin === undefined || this.publishableKey === undefined || this.api === undefined) {
      this.set({ phase: 'refused', reason: 'bad_url' });
      return;
    }
    let origins: string[];
    try {
      origins = (await this.api.origins()).origins;
    } catch (error) {
      this.set({ phase: 'refused', reason: 'origins_unavailable', detail: toApiError(error).code });
      return;
    }
    if (!origins.includes(this.parentOrigin)) {
      // Rule 3: a parent that is not on the tenant's allowlist is never spoken to.
      this.set({ phase: 'refused', reason: 'origin_not_allowed', detail: this.parentOrigin });
      return;
    }
    const parent = this.parentOrigin;
    this.receiver = new Receiver(parent, () => this.win.parent);
    this.win.addEventListener('message', this.onMessage);
    this.set({ phase: 'waiting' });
    this.post({ v: PROTOCOL_VERSION, type: 'ready' });
  }

  stop(): void {
    this.win.removeEventListener('message', this.onMessage);
  }

  /** The one place a message leaves the frame: always to the parent origin from the URL, never `'*'`. */
  private post(message: ToParentMessage): void {
    if (this.parentOrigin === undefined) return;
    this.win.parent.postMessage(message, this.parentOrigin);
  }

  private receive(event: MessageEvent): void {
    const receiver = this.receiver;
    if (receiver === undefined) return;
    const verdict = receiver.validate(event);
    if (!verdict.ok) return;
    const message = verdict.message;
    switch (message.type) {
      case 'hello':
        void this.onHello(message);
        return;
      case 'resize:request':
        this.reportHeight(true);
        return;
      case 'state:request':
        void this.onStateRequest(message.nonce);
        return;
    }
  }

  private async onHello(hello: HelloMessage): Promise<void> {
    const api = this.api;
    const flow = this.flow;
    const parent = this.parentOrigin;
    if (api === undefined || flow === undefined || parent === undefined) return;
    if (hello.publishableKey !== this.publishableKey || hello.flow !== flow) {
      this.fail(hello.nonce, { type: 'invalid_request', code: 'hello_mismatch', message: 'The hello names another key or flow than the frame was opened for' }, true);
      return;
    }
    applyTheme(this.win.document.documentElement, hello.theme);
    try {
      let state: EmbedUserState;
      if (isTokenFlow(flow)) {
        if (hello.embedToken === null) {
          this.fail(hello.nonce, { type: 'invalid_request', code: 'embed_token_required', message: `The ${flow} flow needs an embed token` }, true);
          return;
        }
        state = await api.openSession({ embedToken: hello.embedToken, flow, parentOrigin: parent });
      } else {
        state = await api.state();
      }
      this.set({ phase: 'ready', flow, state, context: hello.context, theme: hello.theme });
      this.post({ v: PROTOCOL_VERSION, type: 'hello_ack', nonce: hello.nonce, flow, state });
      this.reportHeight(true);
    } catch (error) {
      this.fail(hello.nonce, toApiError(error), true);
    }
  }

  private async onStateRequest(nonce: string): Promise<void> {
    const api = this.api;
    if (api === undefined) return;
    try {
      const state = await api.state();
      if (this.status.phase === 'ready') this.set({ ...this.status, state });
      this.post({ v: PROTOCOL_VERSION, type: 'state', nonce, state });
    } catch (error) {
      this.report(toApiError(error));
    }
  }

  private fail(nonce: string, error: ApiError, fatal: boolean): void {
    if (fatal) this.set({ phase: 'failed', error });
    this.post({ v: PROTOCOL_VERSION, type: 'error', nonce, error, fatal });
  }

  /** A flow reports a non-fatal error (a refused entry with its sealed reasons, a wrong code). */
  report(error: ApiError): void {
    const nonce = this.receiver?.currentNonce;
    if (nonce === undefined) return;
    this.post({ v: PROTOCOL_VERSION, type: 'error', nonce, error, fatal: false });
  }

  /** A flow finished. */
  complete(result: FlowResult): void {
    const nonce = this.receiver?.currentNonce;
    if (nonce === undefined) return;
    this.post({ v: PROTOCOL_VERSION, type: 'flow:complete', nonce, result });
  }

  /** A flow's state changed (a sign-in, a verification): tell the parent without being asked. */
  updateState(state: EmbedUserState): void {
    if (this.status.phase === 'ready') this.set({ ...this.status, state });
    const nonce = this.receiver?.currentNonce;
    if (nonce === undefined) return;
    this.post({ v: PROTOCOL_VERSION, type: 'state', nonce, state });
  }

  /** Rule 6: report the content height; on request always, otherwise only when it changed. */
  reportHeight(force = false): void {
    const nonce = this.receiver?.currentNonce;
    if (nonce === undefined) return;
    const height = Math.max(0, Math.min(20_000, this.measure()));
    if (!force && height === this.lastHeight) return;
    this.lastHeight = height;
    this.post({ v: PROTOCOL_VERSION, type: 'resize', nonce, height });
  }
}
