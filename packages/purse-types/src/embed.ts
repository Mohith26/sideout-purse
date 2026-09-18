import { z } from 'zod';

import type { ApiError } from './errors';
import type { EmbedFlow, RestrictionResource, VerificationResource, WalletBalanceResource } from './resources';

/**
 * What the SDK and the embed app agree on besides the message protocol (`protocol.ts`):
 * the flows a partner may mount, the theme it may pass at init (spec 4.8 rule 8), and the
 * user state `getUserState()` returns. `EMBED_FLOWS` (in `resources.ts`) is the set an
 * embed token opens; `signin` is mounted without one, so it is a mountable flow but never
 * a token's.
 */
export const MOUNTABLE_FLOWS = ['signin', 'identity', 'wallet', 'entry', 'rewards'] as const;
export type MountableFlow = (typeof MOUNTABLE_FLOWS)[number];

export function isTokenFlow(flow: MountableFlow): flow is EmbedFlow {
  return flow !== 'signin';
}

/**
 * The theme a partner passes to `Purse.init` (spec 4.8): one accent, one surface, a corner
 * radius and a UI font family. The embed app applies it as CSS custom properties over the
 * shared design tokens, so a Purse flow looks native inside the partner's page. Every field
 * is optional and each is held to a narrow shape: a colour is six hex digits, a radius is a
 * small integer of pixels, a font family is letters, digits, spaces and a few punctuation
 * marks, so nothing that reaches a stylesheet can carry a declaration of its own.
 */
export const themeSchema = z
  .object({
    accent: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'a six-digit hex colour').optional(),
    surface: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'a six-digit hex colour').optional(),
    radius: z.number().int().min(0).max(24).optional(),
    font: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9 ,'_-]+$/, 'a font family name')
      .optional(),
  })
  .strict();

export type Theme = z.infer<typeof themeSchema>;

/**
 * The user as the embed sees them once a session exists: the id and display name the
 * partner already knows, the verification state, the restrictions in force and the wallet
 * by asset. Nothing here is a document or a phone number. `authenticated: false` is what a
 * headless read answers before the user has signed in on the Purse origin.
 */
export type EmbedUser = {
  id: string;
  externalId: string;
  displayName: string | null;
  verification: VerificationResource;
  restrictions: RestrictionResource[];
  wallet: WalletBalanceResource[];
};

export type EmbedUserState = { authenticated: false; user: null } | { authenticated: true; user: EmbedUser };

/** The per-flow result an embed reports with `flow:complete`. The partner branches on `flow`. */
export type FlowResult =
  | { flow: 'signin'; userId: string }
  | { flow: 'identity'; userId: string; verification: VerificationResource }
  | { flow: 'wallet'; userId: string }
  | { flow: 'entry'; userId: string; contestId: string; participantId: string; journalEntryId: string }
  | { flow: 'rewards'; userId: string };

/**
 * What `on('error')` delivers: the API's sealed error shape (spec 4.7). A `not_eligible`
 * error carries the 4.5 variants in `detail.reasons` and `detail.requiredAction`; the SDK's
 * own refusals (an unreachable frame, a rejected origin) use the same shape under
 * `internal_error` or `invalid_request` with a code of their own, so a partner has one
 * branch to write.
 */
export type EmbedError = ApiError;
