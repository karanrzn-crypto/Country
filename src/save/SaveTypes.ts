import type { IdGeneratorState } from '../core/IdGenerator';
import type { GameState } from '../state/GameState';

/** Current save schema version. Bump + add a migration for every break. */
export const SAVE_VERSION = 12;
/** Version that introduced the strategic map slice (Part 1). */
export const SAVE_VERSION_MAP_SLICE = 2;
/** Version that introduced the country data slice (Part 2). */
export const SAVE_VERSION_COUNTRY_SLICE = 3;
/** Version that introduced the country-selection flow + new map layers (Part 3). */
export const SAVE_VERSION_COUNTRY_SELECTION = 4;
/** Version that switched runtime.tick to 1-game-minute ticks (time v2). */
export const SAVE_VERSION_MINUTE_TICKS = 5;
/** Version that introduced the shared feature selection (Part 3.5). */
export const SAVE_VERSION_FEATURE_SELECTION = 6;
/** Version that introduced government + city areas + macro economy (Phase 2). */
export const SAVE_VERSION_PHASE2_GOVERNMENT = 7;
/** Version that introduced the city-network connection selection (City Areas view). */
export const SAVE_VERSION_CITY_CONNECTION = 8;
/** Version that introduced the region-selection mode (province/country pick). */
export const SAVE_VERSION_SELECTION_MODE = 9;
/** Version that introduced the strategic resource economy (economy.resources). */
export const SAVE_VERSION_RESOURCE_ECONOMY = 10;
/** Version that merged Urban Areas + Roads into one toggle and made
 *  resource `suppliers` a per-resource list (multi-seller market). */
export const SAVE_VERSION_URBAN_ROADS_MERGE = 11;

export interface SaveMeta {
  readonly version: number;
  readonly label: string;
  readonly savedTick: number;
  /** FNV-1a of the stable-stringified data payload — corruption guard. */
  readonly checksum: number;
}

export interface SaveRuntimeSnapshot {
  readonly tick: number;
  /** Sim-step counter — interval cadences continue identically after load. */
  readonly stepCounter?: number;
  readonly rngState: number;
  readonly ids: IdGeneratorState;
  /** Time mode at save time (optional — older saves predate it). */
  readonly timeMode?: 'hour' | 'day' | 'month' | 'year';
  /** Speed step index at save time (optional — older saves predate it). */
  readonly speedStepIndex?: number;
}

export interface SaveData {
  readonly state: GameState;
  readonly runtime: SaveRuntimeSnapshot;
}

export interface SaveFile {
  readonly meta: SaveMeta;
  readonly data: SaveData;
}
