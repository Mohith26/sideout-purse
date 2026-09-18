import type { Division, SponsorTier, TournamentFormat } from '../../db/schema';

/** Display names for the event enums; one place so forms, cards and tables agree. */
export const DIVISION_LABEL: Record<Division, string> = {
  open: 'Open',
  womens: "Women's",
  mens: "Men's",
  coed: 'Coed',
  rec: 'Rec',
};

export const FORMAT_LABEL: Record<TournamentFormat, string> = {
  pool_to_bracket: 'Pools to bracket',
  single_elim: 'Single elimination',
  double_elim: 'Double elimination',
  round_robin: 'Round robin',
};

export const SPONSOR_TIER_LABEL: Record<SponsorTier, string> = {
  presenting: 'Presenting',
  court: 'Court',
  prize: 'Prize',
};

export const SPONSOR_TIER_ORDER: readonly SponsorTier[] = ['presenting', 'court', 'prize'];
