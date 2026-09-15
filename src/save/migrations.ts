import { SaveError } from '../utils/errors';

/**
 * Save migration framework. When SAVE_VERSION bumps, register a migration
 * stepping (from → to). Loading applies the chain in order and fails loudly
 * when a path is missing — old saves never load silently wrong.
 */
export interface SaveMigration {
  readonly from: number;
  readonly to: number;
  readonly migrate: (data: unknown) => unknown;
}

const migrations: SaveMigration[] = [];

export function registerMigration(migration: SaveMigration): void {
  migrations.push(migration);
}

export function clearMigrationsForTests(): void {
  migrations.length = 0;
}

/**
 * Applies migrations from `fromVersion` up to `targetVersion`.
 * Pure function over the provided list — unit-testable without globals.
 */
export function applyMigrations(
  rawData: unknown,
  fromVersion: number,
  targetVersion: number,
  chain: readonly SaveMigration[] = migrations
): { data: unknown; version: number } {
  if (fromVersion > targetVersion) {
    throw new SaveError(
      `Save was created by a newer version (${fromVersion} > ${targetVersion}) and cannot be loaded`
    );
  }
  let version = fromVersion;
  let data = rawData;
  while (version < targetVersion) {
    const step = chain.find((candidate) => candidate.from === version);
    if (step === undefined) {
      throw new SaveError(`No migration path from save version ${version} to ${targetVersion}`);
    }
    data = step.migrate(data);
    version = step.to;
  }
  return { data, version };
}
