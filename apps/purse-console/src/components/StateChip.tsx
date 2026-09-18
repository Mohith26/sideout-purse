import { Chip, type ChipTone } from '@sideout/ui';

import { titleCase } from '../lib/format';

/** Colour is never the sole carrier of meaning (spec 6.1): every chip also says its word. */
const TONES: Record<string, ChipTone> = {
  // Contest states (spec 4.3)
  draft: 'muted',
  open: 'surf',
  locked: 'neutral',
  in_progress: 'volt',
  awaiting_settlement: 'ember',
  settling: 'ember',
  settled: 'surf',
  cancelled: 'muted',
  voided: 'fault',
  // Deliveries, endpoints, tenants, flags, keys, verification
  pending: 'neutral',
  delivered: 'surf',
  failed: 'ember',
  dead: 'fault',
  enabled: 'surf',
  disabled: 'muted',
  active: 'surf',
  suspended: 'fault',
  reviewed: 'surf',
  dismissed: 'muted',
  revoked: 'fault',
  verified: 'surf',
  rejected: 'fault',
  unstarted: 'muted',
  ok: 'surf',
  not_applicable: 'muted',
  live: 'ember',
  sandbox: 'neutral',
  admin: 'volt',
  operator: 'neutral',
  entered: 'surf',
  withdrawn: 'muted',
  disqualified: 'fault',
  expired: 'muted',
  lifted: 'muted',
};

export function StateChip({ value }: { value: string }) {
  return <Chip tone={TONES[value] ?? 'neutral'}>{titleCase(value)}</Chip>;
}
