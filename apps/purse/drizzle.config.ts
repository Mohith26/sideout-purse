import { defineConfig } from 'drizzle-kit';

/**
 * Purse owns its own schema and migration history. Migrations are applied by
 * `scripts/migrate.ts` through drizzle-orm's migrator (so `/health` and the migrator agree
 * on state), never by drizzle-kit against a live database; that is why no credentials
 * appear here.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  casing: 'snake_case',
  strict: true,
  verbose: true,
});
