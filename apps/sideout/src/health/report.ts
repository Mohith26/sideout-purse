import { SDK_VERSION } from '@purse/sdk';
import { migrationState, type MigrationState, type Sql } from '@repo/db';

/**
 * `GET /health` payload, mirroring Purse's envelope: commit sha, migration state, and the
 * Purse SDK version this build was compiled against.
 */
export type HealthReport = {
  sha: string;
  migrations: MigrationState;
  purseSdkVersion: string;
};

export async function healthReport(sql: Sql, migrationsFolder: string, sha: string): Promise<HealthReport> {
  return {
    sha,
    migrations: await migrationState(sql, migrationsFolder),
    purseSdkVersion: SDK_VERSION,
  };
}
