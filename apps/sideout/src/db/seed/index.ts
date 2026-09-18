export { buildSeed, SEED_CHARITY_SLUG, SEED_ORGANIZER_PHONE, SEED_PHONE_PREFIX, SEED_RNG_SEED, SEED_SLUGS, type SeedDataset, type SeedOptions } from './build';
export { writeSeed, type SeedSummary } from './write';

/**
 * The default anchor for a seed run: today at 16:00 UTC (a 9am start on the Pacific
 * coast), so the live event is "today", the upcoming one is two weeks out and the settled
 * one is four weeks back. `SEED_ANCHOR` pins it (tests do, so their expectations hold).
 */
export function defaultSeedAnchor(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 16, 0, 0, 0));
}
