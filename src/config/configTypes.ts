/**
 * Central game configuration contract.
 *
 * Rule: no gameplay system hard-codes tuning values. Everything configurable
 * lives here (or in data-driven JSON under src/data) and is validated at boot.
 */
export type QualityTier = 'low' | 'medium' | 'high';
export type ConfigLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface DebugConfig {
  readonly enabled: boolean;
  readonly logLevel: ConfigLogLevel;
  readonly overlayVisibleByDefault: boolean;
}

export interface SimConfig {
  /** Fixed simulation steps per real second at speed 1. */
  readonly tickRateHz: number;
  /** Clamp for spiral-of-death protection (max sim ticks per rendered frame). */
  readonly maxCatchUpSteps: number;
}

export interface TimeConfig {
  /**
   * Game-MINUTES of simulated time per fixed simulation tick (1 = the clock
   * advances minute by minute; larger values fast-forward the whole clock).
   * The clock always rolls over exactly: minute → hour → day → month → year.
   */
  readonly minutesPerTick: number;
  readonly startYear: number;
  readonly startMonth: number;
  readonly startDay: number;
  /** Speed multipliers (data-driven; UI + input are generated from this). */
  readonly speedSteps?: readonly number[];
}

export interface WorldConfig {
  /** World units per chunk edge (renderer-only concern, but shared). */
  readonly chunkSize: number;
  /** Chunks around the focus that are fully simulated AND rendered (3D). */
  readonly activeRadius: number;
  /** Chunks around the focus that simulate but are not rendered. */
  readonly simulatedRadius: number;
  /** Streaming budget: max activate+deactivate operations per tick. */
  readonly maxChunkOpsPerTick: number;
  readonly defaultWorldId: string;
}

export interface EconomyConfig {
  readonly startingTreasury: number;
  readonly taxPerThousandCitizensPerDay: number;
  readonly unitUpkeepPerDay: number;
  readonly lowTreasuryWarnThreshold: number;
}

export interface AIConfig {
  readonly enabled: boolean;
  readonly decisionIntervalTicks: number;
}

export interface CombatConfig {
  readonly enabled: boolean;
  readonly baseAccuracy: number;
  /** Engagement range in chunk units (0 = same region only). */
  readonly maxEngagementRangeChunks: number;
  readonly respawnDelayTicks: number;
  readonly projectileSpeedChunksPerTick: number;
}

export interface PerformanceConfig {
  readonly targetFps: number;
  readonly autoQuality: boolean;
  readonly fpsSampleWindow: number;
}

export interface SaveConfig {
  /** Auto-save every N ticks; 0 disables. */
  readonly autoSaveIntervalTicks: number;
  readonly storageKeyPrefix: string;
}

/** Strategic political map (Part 1) — generation + camera tuning. */
export interface MapConfig {
  /** When true the browser view renders the strategic map instead of chunk planes. */
  readonly enabled: boolean;
  /** Independent generation seed (deterministic; sim RNG stays untouched). */
  readonly seed: number;
  readonly columns: number;
  readonly rows: number;
  readonly cellSize: number;
  /** Lattice jitter as a fraction of cellSize (< 0.5 keeps every quad simple). */
  readonly jitterAmplitude: number;
  /** Fractal subdivision depth per border edge (2^depth segments). */
  readonly borderDepth: number;
  /** Max perpendicular offset per subdivision step, as a fraction of edge length. */
  readonly borderAmplitude: number;
  readonly countryCount: number;
  readonly provincesPerCountryMin: number;
  readonly provincesPerCountryMax: number;
  readonly citiesPerProvinceMax: number;
  /** Province cell count per extra city — scales city density with area. */
  readonly cellsPerCity: number;
  /** Minimum city-to-city distance as a fraction of cellSize. */
  readonly citySeparationFraction: number;
  readonly minCountryCells: number;
  readonly minProvinceCells: number;
  /** Camera zoom bounds: visible world height (smaller = closer). */
  readonly minViewHeight: number;
  readonly maxViewHeight: number;
  /** Keyboard pan speed as a fraction of the viewport width per second. */
  readonly panSpeedFractionPerSecond: number;
  /** Click pick radius as a fraction of the visible height. */
  readonly pickRadiusFraction: number;
}

export interface GameConfig {
  readonly debug: DebugConfig;
  readonly sim: SimConfig;
  readonly time: TimeConfig;
  readonly world: WorldConfig;
  readonly economy: EconomyConfig;
  readonly ai: AIConfig;
  readonly combat: CombatConfig;
  readonly performance: PerformanceConfig;
  readonly save: SaveConfig;
  readonly map: MapConfig;
}

export const DEFAULT_CONFIG: GameConfig = {
  debug: { enabled: true, logLevel: 'info', overlayVisibleByDefault: false },
  sim: { tickRateHz: 30, maxCatchUpSteps: 8 },
  time: { minutesPerTick: 1, startYear: 2030, startMonth: 1, startDay: 1 },
  world: {
    chunkSize: 10,
    activeRadius: 2,
    simulatedRadius: 4,
    maxChunkOpsPerTick: 4,
    defaultWorldId: 'demo-country'
  },
  economy: {
    startingTreasury: 10_000,
    taxPerThousandCitizensPerDay: 5,
    unitUpkeepPerDay: 1,
    lowTreasuryWarnThreshold: 500
  },
  ai: { enabled: true, decisionIntervalTicks: 30 },
  combat: {
    enabled: true,
    baseAccuracy: 0.75,
    maxEngagementRangeChunks: 0,
    respawnDelayTicks: 24,
    projectileSpeedChunksPerTick: 2
  },
  performance: { targetFps: 60, autoQuality: true, fpsSampleWindow: 120 },
  save: { autoSaveIntervalTicks: 0, storageKeyPrefix: 'country' },
  map: {
    enabled: true,
    seed: 20260916,
    columns: 30,
    rows: 20,
    cellSize: 10,
    jitterAmplitude: 0.3,
    borderDepth: 3,
    borderAmplitude: 0.12,
    countryCount: 10,
    provincesPerCountryMin: 3,
    provincesPerCountryMax: 5,
    citiesPerProvinceMax: 3,
    cellsPerCity: 6,
    citySeparationFraction: 0.8,
    minCountryCells: 10,
    minProvinceCells: 2,
    minViewHeight: 26,
    maxViewHeight: 260,
    panSpeedFractionPerSecond: 0.85,
    pickRadiusFraction: 0.03
  }
};
