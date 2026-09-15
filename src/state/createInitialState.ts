/**
 * Builds the initial GameState from static data + config.
 *
 * Referential integrity of the world JSON is validated here (regions,
 * factories, units, characters, relations must point at existing records).
 */

import type { GameConfig } from '../config/configTypes';
import type { IdGenerator } from '../core/IdGenerator';
import type { DataRegistry } from '../data/DataRegistry';
import { createUnitFromType } from '../military/spawnUnit';
import { buildWorldSlice } from './slices/worldSlice';
import type { GameState } from './GameState';
import { validateGameStateOrThrow } from './validate';

export function createInitialState(data: DataRegistry, config: GameConfig, ids: IdGenerator): GameState {
  const worldData = data.world(config.world.defaultWorldId);
  const world = buildWorldSlice(worldData);
  const countryIds = worldData.countries.map((country) => country.id);

  // —— economy ——
  const economy = {
    treasury: Object.fromEntries(countryIds.map((id) => [id, config.economy.startingTreasury])),
    stockpiles: Object.fromEntries(
      countryIds.map((id) => [id, { ...worldData.startingStockpiles.resources }])
    ),
    factories: Object.fromEntries(
      worldData.factories.map((factory) => [
        factory.id,
        {
          id: factory.id,
          typeId: factory.typeId,
          regionId: factory.regionId,
          ownerId: world.countryOfRegion[factory.regionId] ?? countryIds[0],
          active: true,
          lastOutputAmount: 0
        }
      ])
    ),
    supply: Object.fromEntries(Object.keys(world.regions).map((regionId) => [regionId, 1]))
  };

  // —— military ——
  const units: Record<string, ReturnType<typeof createUnitFromType>> = {};
  for (const startingUnit of worldData.startingUnits) {
    const unit = createUnitFromType(data, ids, startingUnit.typeId, startingUnit.countryId, startingUnit.regionId);
    units[unit.id] = unit;
  }
  const military = { units, formations: {}, strengthCache: Object.fromEntries(countryIds.map((id) => [id, 0])) };

  // —— equipment ——
  const equipment = {
    stockpiles: Object.fromEntries(countryIds.map((id) => [id, { ...worldData.startingStockpiles.equipment }]))
  };

  // —— characters ——
  const characters = {
    characters: Object.fromEntries(
      worldData.startingCharacters.map((character) => [
        character.id,
        { id: character.id, name: character.name, role: character.role, countryId: character.countryId, traits: [] }
      ])
    )
  };

  // —— population ——
  const population = {
    regions: Object.fromEntries(
      Object.values(world.regions).map((region) => [
        region.id,
        {
          population: region.basePopulation,
          capacity: region.infrastructure * 400_000,
          lastGrowth: 0
        }
      ])
    )
  };

  // —— political ——
  const political = {
    countries: Object.fromEntries(
      countryIds.map((id) => [id, { stability: 0.6, legitimacy: 0.7, warExhaustion: 0 }])
    )
  };

  // —— diplomacy ——
  const relations: Record<string, Record<string, number>> = {};
  for (const countryId of countryIds) relations[countryId] = {};
  const diplomacy = { relations };
  for (const relation of worldData.relations) {
    (diplomacy.relations[relation.a] ??= {})[relation.b] = relation.value;
    (diplomacy.relations[relation.b] ??= {})[relation.a] = relation.value;
  }

  const state: GameState = {
    world,
    economy,
    military,
    equipment,
    characters,
    population,
    political,
    diplomacy,
    war: { wars: {} },
    environment: {
      weather: Object.fromEntries(Object.keys(world.regions).map((regionId) => [regionId, 'clear' as const]))
    },
    player: {
      countryId: countryIds[0],
      mode: null,
      focusChunkId: null,
      selection: []
    }
  };

  validateGameStateOrThrow(state);
  return state;
}
