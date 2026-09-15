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
  readonly hoursPerTick: number;
  readonly startYear: number;
  readonly startMonth: number;
  readonly startDay: number;
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
}

export const DEFAULT_CONFIG: GameConfig = {
  debug: { enabled: true, logLevel: 'info', overlayVisibleByDefault: false },
  sim: { tickRateHz: 5, maxCatchUpSteps: 8 },
  time: { hoursPerTick: 1, startYear: 2030, startMonth: 1, startDay: 1 },
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
  ai: { enabled: true, decisionIntervalTicks: 6 },
  combat: {
    enabled: true,
    baseAccuracy: 0.75,
    maxEngagementRangeChunks: 0,
    respawnDelayTicks: 24,
    projectileSpeedChunksPerTick: 2
  },
  performance: { targetFps: 60, autoQuality: true, fpsSampleWindow: 120 },
  save: { autoSaveIntervalTicks: 0, storageKeyPrefix: 'country' }
};
