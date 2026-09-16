import type { IdGeneratorState } from '../core/IdGenerator';
import type { GameState } from '../state/GameState';

/** Current save schema version. Bump + add a migration for every break. */
export const SAVE_VERSION = 5;
/** Version that introduced the strategic map slice (Part 1). */
export const SAVE_VERSION_MAP_SLICE = 2;
/** Version that introduced the country data slice (Part 2). */
export const SAVE_VERSION_COUNTRY_SLICE = 3;
/** Version that introduced the country-selection flow + new map layers (Part 3). */
export const SAVE_VERSION_COUNTRY_SELECTION = 4;
/** Version that switched runtime.tick to 1-game-minute ticks (time v2). */
export const SAVE_VERSION_MINUTE_TICKS = 5;

export interface SaveMeta {
  readonly version: number;
  readonly label: string;
  readonly savedTick: number;
  /** FNV-1a of the stable-stringified data payload — corruption guard. */
  readonly checksum: number;
}

export interface SaveRuntimeSnapshot {
  readonly tick: number;
  readonly rngState: number;
  readonly ids: IdGeneratorState;
}

export interface SaveData {
  readonly state: GameState;
  readonly runtime: SaveRuntimeSnapshot;
}

export interface SaveFile {
  readonly meta: SaveMeta;
  readonly data: SaveData;
}
