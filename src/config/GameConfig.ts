import { ConfigError } from '../utils/errors';
import { validateOrThrow } from '../utils/validation';
import type { FieldSchema } from '../utils/validation';
import type { GameConfig } from './configTypes';
import { DEFAULT_CONFIG } from './configTypes';

/** Partial override tree matching the shape of GameConfig. */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge<T>(base: T, override: unknown): T {
  if (override === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(override)) return override as T;
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const baseValue = (base as Record<string, unknown>)[key];
    result[key] = isPlainObject(value) && isPlainObject(baseValue) ? deepMerge(baseValue, value) : value;
  }
  return result as T;
}

const CONFIG_SCHEMA: FieldSchema = {
  type: 'object',
  allowUnknown: false,
  fields: {
    debug: {
      type: 'object',
      fields: {
        enabled: { type: 'boolean' },
        logLevel: { type: 'enum', values: ['debug', 'info', 'warn', 'error'] },
        overlayVisibleByDefault: { type: 'boolean' }
      }
    },
    sim: {
      type: 'object',
      fields: {
        tickRateHz: { type: 'number', min: 1, max: 120 },
        maxCatchUpSteps: { type: 'number', min: 1, max: 64, integer: true }
      }
    },
    time: {
      type: 'object',
      fields: {
        hoursPerTick: { type: 'number', min: 0.25, max: 24 },
        startYear: { type: 'number', min: 1900, max: 2200, integer: true },
        startMonth: { type: 'number', min: 1, max: 12, integer: true },
        startDay: { type: 'number', min: 1, max: 31, integer: true }
      }
    },
    world: {
      type: 'object',
      fields: {
        chunkSize: { type: 'number', min: 1 },
        activeRadius: { type: 'number', min: 1, max: 16, integer: true },
        simulatedRadius: { type: 'number', min: 1, max: 64, integer: true },
        maxChunkOpsPerTick: { type: 'number', min: 1, max: 128, integer: true },
        defaultWorldId: { type: 'string', minLength: 1 }
      }
    },
    economy: {
      type: 'object',
      fields: {
        startingTreasury: { type: 'number', min: 0 },
        taxPerThousandCitizensPerDay: { type: 'number', min: 0, max: 1000 },
        unitUpkeepPerDay: { type: 'number', min: 0 },
        lowTreasuryWarnThreshold: { type: 'number', min: 0 }
      }
    },
    ai: {
      type: 'object',
      fields: {
        enabled: { type: 'boolean' },
        decisionIntervalTicks: { type: 'number', min: 1, max: 720, integer: true }
      }
    },
    combat: {
      type: 'object',
      fields: {
        enabled: { type: 'boolean' },
        baseAccuracy: { type: 'number', min: 0, max: 1 },
        maxEngagementRangeChunks: { type: 'number', min: 0, max: 32, integer: true },
        respawnDelayTicks: { type: 'number', min: 0, max: 720, integer: true },
        projectileSpeedChunksPerTick: { type: 'number', min: 0.1, max: 64 }
      }
    },
    performance: {
      type: 'object',
      fields: {
        targetFps: { type: 'number', min: 10, max: 240 },
        autoQuality: { type: 'boolean' },
        fpsSampleWindow: { type: 'number', min: 10, max: 600, integer: true }
      }
    },
    save: {
      type: 'object',
      fields: {
        autoSaveIntervalTicks: { type: 'number', min: 0, max: 8760, integer: true },
        storageKeyPrefix: { type: 'string', minLength: 1 }
      }
    },
    map: {
      type: 'object',
      fields: {
        enabled: { type: 'boolean' },
        seed: { type: 'number', integer: true },
        columns: { type: 'number', min: 8, max: 128, integer: true },
        rows: { type: 'number', min: 8, max: 128, integer: true },
        cellSize: { type: 'number', min: 1, max: 1000 },
        jitterAmplitude: { type: 'number', min: 0, max: 0.49 },
        borderDepth: { type: 'number', min: 0, max: 6, integer: true },
        borderAmplitude: { type: 'number', min: 0, max: 0.4 },
        countryCount: { type: 'number', min: 2, max: 64, integer: true },
        provincesPerCountryMin: { type: 'number', min: 1, max: 24, integer: true },
        provincesPerCountryMax: { type: 'number', min: 1, max: 48, integer: true },
        citiesPerProvinceMax: { type: 'number', min: 1, max: 12, integer: true },
        minCountryCells: { type: 'number', min: 1, max: 4096, integer: true },
        minProvinceCells: { type: 'number', min: 1, max: 1024, integer: true },
        minViewHeight: { type: 'number', min: 1 },
        maxViewHeight: { type: 'number', min: 1 },
        panSpeedFractionPerSecond: { type: 'number', min: 0.05, max: 5 },
        pickRadiusFraction: { type: 'number', min: 0.001, max: 0.2 }
      }
    }
  }
};

/**
 * Merges user overrides over DEFAULT_CONFIG, validates the result and applies
 * cross-field invariants. Throws ConfigError with precise issues on failure.
 */
export function resolveConfig(overrides?: DeepPartial<GameConfig>): GameConfig {
  const merged = deepMerge(DEFAULT_CONFIG, overrides);
  try {
    validateOrThrow(merged, CONFIG_SCHEMA, 'config');
  } catch (error) {
    throw new ConfigError(error instanceof Error ? error.message : String(error));
  }
  const world = merged.world;
  if (world.simulatedRadius < world.activeRadius) {
    throw new ConfigError(
      `config.world.simulatedRadius (${world.simulatedRadius}) must be >= activeRadius (${world.activeRadius})`
    );
  }
  const map = merged.map;
  if (map.provincesPerCountryMax < map.provincesPerCountryMin) {
    throw new ConfigError(
      `config.map.provincesPerCountryMax (${map.provincesPerCountryMax}) must be >= provincesPerCountryMin (${map.provincesPerCountryMin})`
    );
  }
  if (map.maxViewHeight <= map.minViewHeight) {
    throw new ConfigError(
      `config.map.maxViewHeight (${map.maxViewHeight}) must be > minViewHeight (${map.minViewHeight})`
    );
  }
  return merged;
}
