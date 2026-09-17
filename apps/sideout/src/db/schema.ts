/**
 * Sideout schema, system spec section 5.1: only what Purse does not own. Phase 0 ships
 * local accounts and charities; tournaments, teams, pools, matches, score consensus,
 * donations and the `purse_calls` audit arrive in phases 6 and 7.
 *
 * Conventions (shared with Purse through `@repo/db`):
 * - Ids are typed-prefix UUID v7 strings checked at the database (`sou_` users,
 *   `chr_` charities, `ext_` for the opaque id handed to Purse).
 * - Timestamps are `timestamptz`.
 * - Money that ever appears here (donations, phase 7) is real dollars via Stripe, stored
 *   as `bigint` cents with an explicit `currency`, and never crosses into Purse
 *   (spec 4.2.6). Contest value never appears in this database at all; Sideout refers to
 *   Purse objects by opaque id only.
 * - Purse objects are referenced by opaque id columns (`purse_*`), never by foreign key.
 */
import { pgEnum, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { idCheck, timestamps } from '@repo/db';

// ---- Accounts ------------------------------------------------------------------------

/**
 * A local Sideout account (decision D8: Sideout owns the app session). `purseExternalId`
 * is the opaque value Sideout sends Purse as `external_id`; it is minted here, is never
 * Sideout's own row id, and is the only link between the two identities.
 */
export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    purseExternalId: text('purse_external_id').notNull(),
    displayName: text('display_name').notNull(),
    avatarUrl: text('avatar_url'),
    ...timestamps,
  },
  (table) => [
    idCheck('users_id_prefix', table.id, 'sou'),
    idCheck('users_purse_external_id_prefix', table.purseExternalId, 'ext'),
    uniqueIndex('users_purse_external_id_key').on(table.purseExternalId),
  ],
);

// ---- Charities -----------------------------------------------------------------------

export const charityStatus = pgEnum('charity_status', ['active', 'inactive']);

/** A beneficiary a tournament can raise for. Donations (phase 7) reference these rows. */
export const charities = pgTable(
  'charities',
  {
    id: text('id').primaryKey(),
    /** URL handle, e.g. `surfrider`. Lowercase letters, digits and hyphens. */
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    websiteUrl: text('website_url'),
    logoUrl: text('logo_url'),
    status: charityStatus('status').notNull().default('active'),
    ...timestamps,
  },
  (table) => [idCheck('charities_id_prefix', table.id, 'chr'), uniqueIndex('charities_slug_key').on(table.slug)],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Charity = typeof charities.$inferSelect;
export type NewCharity = typeof charities.$inferInsert;
