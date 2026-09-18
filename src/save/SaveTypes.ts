import type { IdGeneratorState } from '../core/IdGenerator';
import type { GameState } from '../state/GameState';

/** Version of the WIDER simple economy (spec §1-§9): FOUR goods (industrial
 *  goods added), buildings anchored to geographic GRID CELLS (one per
 *  region), the 0-100 economy level scaling building production, country
 *  specialization over the baseline, population-based consumption for every
 *  good (zero-consumption bug fixed), graded shortage → satisfaction. */
export const SAVE_VERSION_ECONOMY_LEVEL = 17;
/** Version of the HARD economy (spec §1-§24): per-region land quality,
 *  country potentials, finite extraction reserves, money + materials +
 *  workforce construction, limited population-scaled starting stockpiles,
 *  diminishing returns and shortage-duration satisfaction. Adds
 *  `shortageMonths` to every resource record and `buildPreview` to the map
 *  slice (the heal fills missing building reserve fields). */
export const SAVE_VERSION_ECONOMY_HARD_MODE = 18;
/** Current save schema version. Bump + add a migration for every break. */
export const SAVE_VERSION = SAVE_VERSION_ECONOMY_HARD_MODE;
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
/** Version that replaced the GDP/debt macro engine with the light resource
 *  economy: stockpiles, mines, research, construction, finance. */
export const SAVE_VERSION_RESOURCE_REDESIGN = 14;
/** Version that made construction costs ONE-TIME with RESERVED (secured)
 *  resources and the waiting/building states (superseded by v16). */
export const SAVE_VERSION_CONSTRUCTION_ESCROW = 15;
/** Version that introduced the SIMPLE economy (spec §1-§14): three
 *  resources, the transparent cycle, base prices, money-paid construction,
 *  the 3-level tax; mines/research/escrow removed. */
export const SAVE_VERSION_SIMPLE_ECONOMY = 16;

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
