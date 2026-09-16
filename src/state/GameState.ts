/**
 * GameState — THE source of truth of the whole game (Architecture Rule 1).
 *
 * The renderer only reads from here; systems mutate slices directly; saves
 * serialize these slices as plain JSON. No Maps, no class instances, no
 * functions — everything in state must be JSON-safe.
 */

import type { WorldSlice } from './slices/worldSlice';
import type { EconomySlice } from './slices/economySlice';
import type { MilitarySlice } from './slices/militarySlice';
import type { EquipmentSlice } from './slices/equipmentSlice';
import type { CharacterSlice } from './slices/characterSlice';
import type { PopulationSlice } from './slices/populationSlice';
import type { PoliticalSlice } from './slices/politicalSlice';
import type { DiplomacySlice } from './slices/diplomacySlice';
import type { WarSlice } from './slices/warSlice';
import type { EnvironmentSlice } from './slices/environmentSlice';
import type { PlayerSlice } from './slices/playerSlice';
import type { MapSlice } from './slices/mapSlice';
import type { CountrySlice } from './slices/countrySlice';
import type { GovernmentSlice } from '../government/types';
import type { CityAreasSlice } from './slices/cityAreasSlice';

export interface GameState {
  world: WorldSlice;
  economy: EconomySlice;
  military: MilitarySlice;
  equipment: EquipmentSlice;
  characters: CharacterSlice;
  population: PopulationSlice;
  political: PoliticalSlice;
  diplomacy: DiplomacySlice;
  war: WarSlice;
  environment: EnvironmentSlice;
  player: PlayerSlice;
  map: MapSlice;
  /** Part 2 — strategic-map country data foundation (profiles + map join). */
  countries: CountrySlice;
  /** Phase 2 — presidency, politics, budget, decisions, events, opinion. */
  government: GovernmentSlice;
  /** Phase 2 — the urban/transport network of the continent (City Areas). */
  cityAreas: CityAreasSlice;
}

/** Slice keys in canonical order (save serialization + state hashing). */
export const STATE_SLICE_KEYS: readonly (keyof GameState)[] = [
  'world',
  'economy',
  'military',
  'equipment',
  'characters',
  'population',
  'political',
  'diplomacy',
  'war',
  'environment',
  'player',
  'map',
  'countries',
  'government',
  'cityAreas'
] as const;
