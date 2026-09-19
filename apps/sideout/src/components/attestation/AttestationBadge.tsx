import { Icons, StatusPill, type PillSpec } from '@sideout/ui';

import { cx } from '../../lib/cx';

/**
 * Whether a scoreline was signed by a phone its team checked in (spec section 12,
 * item 1). Two states, each with its own word and icon so colour never carries the meaning
 * alone: `signed` (the server verified the phone's signature against the registered key
 * before the consensus saw the submission) and `unsigned` (the scoreline was accepted the
 * ordinary way, on both teams' agreement; nothing more is known about the phone). The
 * badge is shown wherever a submission is, including the organizer's dispute queue, so
 * an unsigned reading is visible during arbitration.
 */
export const ATTESTATION_PILL: Record<'signed' | 'unsigned', PillSpec> = {
  signed: { label: 'Signed', tone: 'success', icon: 'signature' },
  unsigned: { label: 'Unsigned', tone: 'muted', icon: 'shieldOff' },
};

export function attestationSentence(attested: boolean, who: string | null): string {
  if (attested) return `${who ?? 'The submitter'} signed this scoreline on a phone checked in for the team; the signature was verified before it counted.`;
  return `${who ?? 'The submitter'} sent this scoreline from a phone that is not checked in. It counts on both teams' agreement, as every scoreline does.`;
}

export function AttestationBadge({ attested, who = null, size = 'sm', sentence = false, className }: { attested: boolean; who?: string | null; size?: 'sm' | 'md'; sentence?: boolean; className?: string }) {
  const spec = ATTESTATION_PILL[attested ? 'signed' : 'unsigned'];
  return (
    <span className={cx('inline-flex flex-wrap items-center gap-x-2 gap-y-1', className)} data-testid="attestation-badge" data-attested={attested ? 'true' : 'false'}>
      <StatusPill spec={spec} size={size} title={sentence ? undefined : attestationSentence(attested, who)} />
      {sentence ? <span className="text-text-secondary">{attestationSentence(attested, who)}</span> : null}
    </span>
  );
}

/** A quiet inline mark for a list row: the icon and word, no pill chrome. */
export function AttestationMark({ attested }: { attested: boolean }) {
  const Icon = attested ? Icons.signature : Icons.shieldOff;
  return (
    <span className={cx('inline-flex items-center gap-1 type-label', attested ? 'text-surf' : 'text-text-tertiary')} data-testid="attestation-mark" data-attested={attested ? 'true' : 'false'}>
      <Icon size={12} />
      {attested ? 'Signed' : 'Unsigned'}
    </span>
  );
}
