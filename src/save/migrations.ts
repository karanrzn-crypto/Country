import { SaveError } from '../utils/errors';
import { createDefaultMapSlice } from '../state/slices/mapSlice';
import { buildCountrySlice } from '../state/slices/countrySlice';
import { generateStrategicMap } from '../world/map/MapGenerator';
import { DEFAULT_CONFIG } from '../config/configTypes';
import countriesJson from '../data/countries.json';
import type { CountryProfileJson } from '../data/types';

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

/**
 * Built-in migration chain (registered once at module load).
 *
 * v1 → v2: the strategic map slice (Part 1) was added to GameState.
 * Old saves carry no `state.map`; inject the documented default so the
 * schema validation and slice restore keep working unchanged.
 *
 * v2 → v3: the country data slice (Part 2) was added to GameState. The slice
 * is rebuilt from the static profiles + the default-config map (deterministic);
 * the session then re-syncs capital joins against its live map model on load
 * (Game.applyLoadedSnapshot), so this remains correct for any map config.
 */
const BUILT_IN_MIGRATIONS: readonly SaveMigration[] = [
  {
    from: 1,
    to: 2,
    migrate: (data) => {
      if (data === null || typeof data !== 'object') {
        throw new SaveError('Migration v1→v2: save payload is not an object');
      }
      const source = data as { state?: Record<string, unknown> };
      if (source.state === undefined || typeof source.state !== 'object') {
        throw new SaveError('Migration v1→v2: save has no state object');
      }
      const clone = JSON.parse(JSON.stringify(data)) as { state: Record<string, unknown> };
      clone.state.map = createDefaultMapSlice();
      return clone;
    }
  },
  {
    from: 2,
    to: 3,
    migrate: (data) => {
      if (data === null || typeof data !== 'object') {
        throw new SaveError('Migration v2→v3: save payload is not an object');
      }
      const source = data as { state?: Record<string, unknown> };
      if (source.state === undefined || typeof source.state !== 'object') {
        throw new SaveError('Migration v2→v3: save has no state object');
      }
      const clone = JSON.parse(JSON.stringify(data)) as { state: Record<string, unknown> };
      if (clone.state.countries === undefined) {
        const mapModel = generateStrategicMap(DEFAULT_CONFIG.map).model;
        clone.state.countries = buildCountrySlice(
          countriesJson as unknown as readonly CountryProfileJson[],
          mapModel
        );
      }
      return clone;
    }
  }
];

const migrations: SaveMigration[] = [...BUILT_IN_MIGRATIONS];

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
