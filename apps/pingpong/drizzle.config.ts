import { defineConfig } from 'drizzle-kit';

/**
 * Ping-pong owns its own schema and migration history, applied by `scripts/migrate.ts`
 * through drizzle-orm's migrator (system spec section 2, rule 1: a tenant's database is
 * its own). No credentials live here.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  casing: 'snake_case',
  strict: true,
  verbose: true,
});
