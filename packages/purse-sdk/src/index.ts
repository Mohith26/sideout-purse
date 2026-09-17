import type { ApiError } from '@purse/types';

export { SDK_VERSION } from './version';
export { PROTOCOL_VERSION } from '@purse/types';

/** Theme values the embed applies as CSS custom properties so Purse flows look native. */
export type PurseTheme = {
  /** Primary action colour, e.g. `#D7FF3E`. */
  accent?: string;
  /** Raised surface colour, e.g. `#101216`. */
  surface?: string;
  /** Control corner radius in CSS pixels. */
  radius?: number;
  /** UI font family name. */
  font?: string;
};

export type PurseInitOptions = {
  /** Publishable key. Safe for the browser; only ever bootstraps the iframe. */
  publishableKey: `pk_${string}`;
  tenantId: `tnt_${string}`;
  theme?: PurseTheme;
  /** Purse origin to load the embed from. Defaults to the production origin in phase 4. */
  baseUrl?: string;
};

export type PurseFlow = 'sign_in' | 'identity' | 'wallet' | 'entry_confirm' | 'rewards';

export type MountOptions = {
  flow: PurseFlow;
  /** Single-use, 5-minute token minted server-side via `POST /embed/tokens`. */
  embedToken: string;
};

export type PurseEventMap = {
  'flow:complete': { flow: PurseFlow; result: unknown };
  error: ApiError;
};

export type PurseClient = {
  mount(target: string | Element, options: MountOptions): Promise<void>;
  unmount(): void;
  getUserState(): Promise<unknown>;
  on<K extends keyof PurseEventMap>(event: K, handler: (payload: PurseEventMap[K]) => void): () => void;
};

export class NotImplementedError extends Error {
  override readonly name = 'NotImplementedError';
  constructor(what: string) {
    super(`${what} is not implemented yet`);
  }
}

export const Purse = {
  /**
   * Create a client for one tenant. Phase 4 implements the iframe, handshake and message
   * validation; until then the signature is fixed and the call fails loudly.
   */
  init(_options: PurseInitOptions): Promise<PurseClient> {
    throw new NotImplementedError('Purse.init');
  },
};
