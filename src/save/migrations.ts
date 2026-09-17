import { SaveError } from '../utils/errors';
import { createDefaultMapSlice } from '../state/slices/mapSlice';
import { buildCountrySlice } from '../state/slices/countrySlice';
import { buildGovernmentSlice } from '../state/slices/governmentSlice';
import { createCityAreasSlice } from '../state/slices/cityAreasSlice';
import { createMacroEconomy } from '../economy/EconomySimulation';
import { generateStrategicMap } from '../world/map/MapGenerator';
import { DEFAULT_CONFIG } from '../config/configTypes';
import { Random } from '../utils/Random';
import countriesJson from '../data/countries.json';
import partiesJson from '../data/government/parties.json';
import ministriesJson from '../data/government/ministries.json';
import type { CountryProfileJson } from '../data/types';
import type { PartyTemplate, MinistryTemplate } from '../state/slices/governmentSlice';

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
        // Part 3: the regenerated model anchors its population tree on the
        // SAME declared profile populations the slice is built from.
        const declaredPopulations = Object.fromEntries(
          (countriesJson as unknown as readonly CountryProfileJson[]).map((profile) => [
            profile.id,
            profile.population
          ])
        );
        const mapModel = generateStrategicMap(DEFAULT_CONFIG.map, {
          countryPopulations: declaredPopulations
        }).model;
        clone.state.countries = buildCountrySlice(
          countriesJson as unknown as readonly CountryProfileJson[],
          mapModel
        );
      }
      return clone;
    }
  },
  {
    // v3 → v4: the country-selection flow (Part 3) added player.countryConfirmed.
    // Every pre-existing save represents an already-started campaign, so the
    // field is injected as true — the selection screen never blocks old saves.
    // New map layers need NO migration: layer visibility is a record and the
    // session merges registry defaults over whatever the save carries.
    from: 3,
    to: 4,
    migrate: (data) => {
      if (data === null || typeof data !== 'object') {
        throw new SaveError('Migration v3→v4: save payload is not an object');
      }
      const source = data as { state?: Record<string, unknown> };
      if (source.state === undefined || typeof source.state !== 'object') {
        throw new SaveError('Migration v3→v4: save has no state object');
      }
      const clone = JSON.parse(JSON.stringify(data)) as {
        state: { player?: Record<string, unknown> };
      };
      if (clone.state.player === undefined || typeof clone.state.player !== 'object') {
        clone.state.player = {};
      }
      clone.state.player.countryConfirmed = true;
      return clone;
    }
  },
  {
    // v4 → v5: the clock became MINUTE-resolution (time v2). Pre-v5 saves
    // store runtime.tick in 15-minute ticks (hoursPerTick 0.25); v5+ stores
    // 1-minute ticks, so the saved instant must scale by ×15 to preserve the
    // exact campaign moment across the upgrade.
    from: 4,
    to: 5,
    migrate: (data) => {
      if (data === null || typeof data !== 'object') {
        throw new SaveError('Migration v4→v5: save payload is not an object');
      }
      const clone = JSON.parse(JSON.stringify(data)) as {
        runtime?: { tick?: unknown };
      };
      const tick = clone.runtime?.tick;
      if (typeof tick !== 'number' || !Number.isFinite(tick) || tick < 0) {
        throw new SaveError('Migration v4→v5: save has no valid runtime.tick');
      }
      if (clone.runtime === undefined) {
        throw new SaveError('Migration v4→v5: save has no runtime object');
      }
      (clone.runtime as { tick: number }).tick = Math.floor(tick * 15);
      return clone;
    }
  },
  {
    from: 5,
    to: 6,
    migrate: (data) => {
      if (data === null || typeof data !== 'object') {
        throw new SaveError('Migration v5→v6: save payload is not an object');
      }
      // Part 3.5: the shared feature selection (grid cell / river / lake /
      // site / building) added five nullable fields to the map slice. Old
      // saves predate them — inject the documented nulls so schema
      // validation passes; actual selections are session-state only.
      const clone = JSON.parse(JSON.stringify(data)) as {
        state?: Record<string, unknown>;
      };
      const map = clone.state?.map as Record<string, unknown> | undefined;
      if (map !== undefined) {
        for (const key of [
          'selectedGridKey',
          'selectedRiverId',
          'selectedLakeId',
          'selectedSiteId',
          'selectedBuildingId'
        ]) {
          if (typeof map[key] !== 'string') map[key] = null;
        }
      }
      return clone;
    }
  },
  {
    // v6 → v7: Phase 2 added three state areas — (1) `government` slice
    // (presidency/parties/budget/decisions/events) per strategic country,
    // (2) `cityAreas` (urban/transport network generated from the map),
    // (3) `economy.macro` (national accounts) + strategic-country records in
    // `political.countries` + strategic-country treasuries. Everything is
    // rebuilt from the SAME deterministic map generation the campaign used
    // (DEFAULT_CONFIG + declared populations); the session re-syncs city
    // areas against the live model on load (Game.applyLoadedSnapshot).
    from: 6,
    to: 7,
    migrate: (data) => {
      if (data === null || typeof data !== 'object') {
        throw new SaveError('Migration v6→v7: save payload is not an object');
      }
      const source = data as { state?: Record<string, unknown> };
      if (source.state === undefined || typeof source.state !== 'object') {
        throw new SaveError('Migration v6→v7: save has no state object');
      }
      const clone = JSON.parse(JSON.stringify(data)) as {
        state: {
          economy?: Record<string, unknown>;
          political?: { countries?: Record<string, unknown> };
          countries?: { countries?: Record<string, { population?: number; economy?: { treasury?: number } }> };
          government?: unknown;
          cityAreas?: unknown;
        };
      };

      const declaredPopulations = Object.fromEntries(
        (countriesJson as unknown as readonly CountryProfileJson[]).map((profile) => [
          profile.id,
          profile.population
        ])
      );
      const mapGeneration = generateStrategicMap(DEFAULT_CONFIG.map, {
        countryPopulations: declaredPopulations
      });
      const model = mapGeneration.model;

      // (1) government slice
      if (clone.state.government === undefined) {
        const countryNames: Record<string, string> = {};
        for (const countryId of model.countryOrder) {
          countryNames[countryId] = model.countries[countryId].name;
        }
        clone.state.government = buildGovernmentSlice(
          model.countryOrder,
          countryNames,
          Object.values(partiesJson) as unknown as PartyTemplate[],
          Object.values(ministriesJson) as unknown as MinistryTemplate[],
          new Random((DEFAULT_CONFIG.map.seed ^ 0x9e3779b9) >>> 0)
        );
      }

      // (2) city areas
      if (clone.state.cityAreas === undefined) {
        clone.state.cityAreas = createCityAreasSlice(model, DEFAULT_CONFIG.map.columns);
      }

      // (3) macro economy + treasuries + political records. Conservative:
      // only touched when the parent objects already exist (real saves do);
      // the session's load heal fills any remaining gaps per live country.
      if (clone.state.economy !== undefined) {
        const economy = clone.state.economy as { macro?: Record<string, unknown>; treasury?: Record<string, number> };
        if (economy.macro === undefined) economy.macro = {};
        if (economy.treasury === undefined) economy.treasury = {};
        const profiles = countriesJson as unknown as readonly CountryProfileJson[];
        for (const countryId of model.countryOrder) {
          const profile = profiles.find((candidate) => candidate.id === countryId);
          if (economy.macro[countryId] === undefined) {
            economy.macro[countryId] = createMacroEconomy(profile?.population ?? 1_500_000);
          }
          if (economy.treasury[countryId] === undefined) {
            economy.treasury[countryId] = profile?.economy.treasury ?? DEFAULT_CONFIG.economy.startingTreasury;
          }
        }
      }
      if (clone.state.political?.countries !== undefined) {
        const political = clone.state.political as { countries: Record<string, unknown> };
        for (const countryId of model.countryOrder) {
          if (political.countries[countryId] === undefined) {
            political.countries[countryId] = { stability: 0.6, legitimacy: 0.7, warExhaustion: 0 };
          }
        }
      }
      return clone;
    }
  },
  {
    from: 7,
    to: 8,
    migrate: (data) => {
      if (data === null || typeof data !== 'object') {
        throw new SaveError('Migration v7→v8: save payload is not an object');
      }
      // City-network connection selection: one more nullable map-slice field
      // (selections are session-state only — old saves get the null default
      // so schema validation passes; the session heal drops stale ids).
      const clone = JSON.parse(JSON.stringify(data)) as {
        state?: { map?: Record<string, unknown> };
      };
      const map = clone.state?.map;
      if (map !== undefined && typeof map.selectedCityConnectionId !== 'string') {
        map.selectedCityConnectionId = null;
      }
      return clone;
    }
  },
  {
    from: 8,
    to: 9,
    migrate: (data) => {
      if (data === null || typeof data !== 'object') {
        throw new SaveError('Migration v8→v9: save payload is not an object');
      }
      // Region-selection mode (province/country land-click pick) added to
      // the map slice. Old saves predate the toggle — inject the documented
      // default ('country') so schema validation passes unchanged.
      const clone = JSON.parse(JSON.stringify(data)) as {
        state?: { map?: Record<string, unknown> };
      };
      const map = clone.state?.map;
      if (map !== undefined && map.selectionMode !== 'country' && map.selectionMode !== 'province') {
        map.selectionMode = 'country';
      }
      return clone;
    }
  },
  {
    from: 9,
    to: 10,
    migrate: (data) => {
      if (data === null || typeof data !== 'object') {
        throw new SaveError('Migration v9→v10: save payload is not an object');
      }
      // Strategic resource economy (economy.resources) added to the economy
      // slice. Old saves predate it — inject the empty record; the session
      // heal (healPhase2State) recomputes everything from the live map, so
      // the empty record is only a schema-valid placeholder.
      const clone = JSON.parse(JSON.stringify(data)) as {
        state?: { economy?: Record<string, unknown> };
      };
      const economy = clone.state?.economy;
      if (economy !== undefined && economy.resources === undefined) {
        economy.resources = {};
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
