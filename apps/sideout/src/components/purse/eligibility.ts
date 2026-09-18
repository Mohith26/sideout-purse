import { API_ERROR_TYPES, isEligibilityReason, isRequiredAction, type ApiErrorType, type EligibilityReason, type MountableFlow, type RequiredAction, type VerificationResource } from '@purse/types';

/**
 * The sealed eligibility variants (spec 4.5) as UI states (spec 5.3, "Profile"): a
 * terminal refusal is a plain explanation with a support path and no retry; a refusal
 * with a required action names the one Purse flow that resolves it; anything else is
 * something to try again. Pure: `PurseGate` applies it, tests table it. Copy is Sideout's:
 * nothing Purse said verbatim is shown, because the variant is the contract and the
 * message is presentation.
 */
export type PurseUiState =
  | { kind: 'terminal'; title: string; body: string; reasons: EligibilityReason[] }
  | { kind: 'action'; title: string; body: string; reasons: EligibilityReason[]; flow: MountableFlow; label: string }
  | { kind: 'retry'; title: string; body: string; reasons: EligibilityReason[] }
  | { kind: 'unavailable'; title: string; body: string };

/** Reasons no action of the player's can change; the profile shows them as a terminal row. */
export const TERMINAL_REASONS: ReadonlySet<EligibilityReason> = new Set<EligibilityReason>(['identity_rejected', 'platform_blocked', 'under_minimum_age', 'region_not_permitted']);

const REASON_COPY: Record<EligibilityReason, { title: string; body: string }> = {
  under_minimum_age: { title: 'Purse cannot offer play to this account', body: 'The platform requires a minimum age that this account does not meet. There is nothing to retry; your donations and your team are unaffected.' },
  region_not_permitted: { title: 'Purse cannot offer play where you are', body: 'Contests are not available in your region under the platform’s rules. There is nothing to retry; your donations and your team are unaffected.' },
  identity_unverified: { title: 'Verify your identity first', body: 'Purse confirms who you are before you can enter a contest. Sideout never sees the details, only the outcome.' },
  identity_rejected: { title: 'Purse could not verify this account', body: 'The verification decision is final for this account. Purse support can explain it; your donations and your team are unaffected, and there is nothing to retry here.' },
  self_excluded: { title: 'You have excluded yourself from play', body: 'Your self-exclusion is in force. It lifts on the date you chose, or contact Purse support.' },
  cooling_off: { title: 'A cooling-off period is in force', body: 'You asked for a break from play. Entry opens again when it ends.' },
  platform_blocked: { title: 'Purse has restricted this account', body: 'Purse has restricted this account under its own rules, which Sideout cannot see or change. Purse support can explain and help; there is nothing to retry here.' },
  insufficient_balance: { title: 'Your Purse balance does not cover the entry', body: 'Entry costs 100 POINTS. Open your Purse wallet to see your balance.' },
  stake_limit_exceeded: { title: 'This entry is over your stake limit', body: 'Purse limits how much you can put at stake. Adjust the limit in your Purse wallet, or wait for it to reset.' },
  velocity_limit_exceeded: { title: 'Too many entries in a short time', body: 'Purse limits how fast entries can be made. Try again in a while.' },
  region_unknown: { title: 'Purse could not confirm your location', body: 'Check that location services are on for this browser and that no VPN is moving you elsewhere, then try again.' },
  contest_not_open: { title: 'The contest is not open', body: 'Entries are taken while the event is open for registration. Ask the organizer if you think this is wrong.' },
  contest_full: { title: 'The contest is full', body: 'Every place is taken. Ask the organizer if a place opens up.' },
};

const ACTION_FLOW: Record<RequiredAction, { flow: MountableFlow; label: string } | null> = {
  complete_identity: { flow: 'identity', label: 'Verify with Purse' },
  provide_demographics: { flow: 'identity', label: 'Complete verification' },
  add_funds: { flow: 'wallet', label: 'Open your Purse wallet' },
  confirm_location: null,
};

/** A sealed error as it arrives from the SDK or, wrapped, from Sideout's own routes; `type` is checked against the sealed list. */
export type PurseErrorLike = { type: string; code: string; message: string; detail?: unknown };

function detailOf(error: PurseErrorLike): Record<string, unknown> {
  const detail = error.detail;
  if (typeof detail !== 'object' || detail === null) return {};
  // Sideout's routes wrap a Purse refusal as `detail.purse` (`purseFailureToApi`); the SDK hands the error itself.
  const inner = (detail as { purse?: unknown }).purse;
  if (typeof inner === 'object' && inner !== null && 'detail' in inner) return detailOf(inner as PurseErrorLike);
  return detail as Record<string, unknown>;
}

/** The sealed type: Purse's own when a Sideout route wrapped its refusal, else the error's. */
function sealedType(error: PurseErrorLike): ApiErrorType {
  const detail = error.detail;
  const inner = typeof detail === 'object' && detail !== null ? (detail as { purse?: { type?: unknown } }).purse : undefined;
  if (typeof inner?.type === 'string' && (API_ERROR_TYPES as readonly string[]).includes(inner.type)) return inner.type as ApiErrorType;
  if ((API_ERROR_TYPES as readonly string[]).includes(error.type)) return error.type as ApiErrorType;
  return 'internal_error';
}

function reasonsOf(error: PurseErrorLike): EligibilityReason[] {
  const raw = detailOf(error)['reasons'];
  return Array.isArray(raw) ? raw.filter(isEligibilityReason) : [];
}

/** Map a sealed error (spec 4.7) to what the person sees and can do. */
export function mapPurseError(error: PurseErrorLike): PurseUiState {
  const type = sealedType(error);
  if (type === 'not_eligible') {
    const reasons = reasonsOf(error);
    const terminal = reasons.find((r) => TERMINAL_REASONS.has(r));
    if (terminal !== undefined) return { kind: 'terminal', reasons, ...REASON_COPY[terminal] };
    const requiredAction = detailOf(error)['requiredAction'];
    const action = isRequiredAction(requiredAction) ? ACTION_FLOW[requiredAction] : null;
    const lead = reasons[0];
    const copy = lead === undefined ? { title: 'Purse declined the entry', body: 'The platform’s eligibility rules refused this entry.' } : REASON_COPY[lead];
    if (action !== null) return { kind: 'action', reasons, ...copy, ...action };
    if (lead === 'identity_unverified') return { kind: 'action', reasons, ...copy, flow: 'identity', label: 'Verify with Purse' };
    if (lead === 'insufficient_balance' || lead === 'stake_limit_exceeded') return { kind: 'action', reasons, ...copy, flow: 'wallet', label: 'Open your Purse wallet' };
    return { kind: 'retry', reasons, ...copy };
  }
  if (type === 'insufficient_funds') {
    return { kind: 'action', reasons: ['insufficient_balance'], ...REASON_COPY.insufficient_balance, flow: 'wallet', label: 'Open your Purse wallet' };
  }
  if (type === 'authentication_error' || type === 'permission_error') {
    return { kind: 'retry', reasons: [], title: 'Purse needs you to sign in again', body: 'The Purse session has expired. Try again to open a fresh one.' };
  }
  if (type === 'rate_limited') {
    return { kind: 'retry', reasons: [], title: 'Purse is busy', body: 'Too many requests in a short time. Wait a moment and try again.' };
  }
  if (type === 'invalid_state' || type === 'conflict') {
    return { kind: 'retry', reasons: [], title: 'Purse could not take that right now', body: 'The contest changed underneath the request. Reload and try again.' };
  }
  return { kind: 'unavailable', title: 'Purse did not answer', body: 'The request did not complete. Check your connection and try again; if it keeps happening, Purse may be having trouble.' };
}

/** What the verification row shows, from the live verification state (spec 5.3: `rejected` is terminal). */
export type VerificationRowState = 'not_linked' | 'unstarted' | 'pending' | 'verified' | 'rejected' | 'restricted';

export function verificationRowState(linked: boolean, verification: VerificationResource | null, restrictions: ReadonlyArray<{ kind: string }>): VerificationRowState {
  if (!linked || verification === null) return 'not_linked';
  if (restrictions.some((r) => r.kind === 'platform_block')) return 'restricted';
  return verification.state;
}
