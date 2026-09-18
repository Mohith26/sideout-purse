import { defineConfig } from 'drizzle-kit';

/**
 * Sideout owns its own schema and migration history, applied by `scripts/migrate.ts`
 * through drizzle-orm's migrator. No credentials live here; Purse's database is not even
 * nameable from this app.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  casing: 'snake_case',
  strict: true,
  verbose: true,
});
