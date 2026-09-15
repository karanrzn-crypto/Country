import type { IdGeneratorState } from '../core/IdGenerator';
import type { GameState } from '../state/GameState';

/** Current save schema version. Bump + add a migration for every break. */
export const SAVE_VERSION = 2;
/** Version that introduced the strategic map slice (Part 1). */
export const SAVE_VERSION_MAP_SLICE = 2;

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
