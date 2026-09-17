/**
 * Builds the initial GameState from static data + config.
 *
 * Referential integrity of the world JSON is validated here (regions,
 * factories, units, characters, relations must point at existing records).
 */

import type { GameConfig } from '../config/configTypes';
import type { IdGenerator } from '../core/IdGenerator';
import type { DataRegistry } from '../data/DataRegistry';
import { Random } from '../utils/Random';
import { createUnitFromType } from '../military/spawnUnit';
import { buildWorldSlice } from './slices/worldSlice';
import { createDefaultMapSlice } from './slices/mapSlice';
import { buildCountrySlice } from './slices/countrySlice';
import { buildGovernmentSlice } from './slices/governmentSlice';
import { repairBudgetRecord } from './slices/governmentSlice';
import { createCityAreasSlice, syncCityAreas as syncCityAreasSlice } from './slices/cityAreasSlice';
import { createMacroEconomy } from '../economy/EconomySimulation';
import { recomputeResourceEconomies } from '../economy/resources';
import { emptyCountryResourceState } from '../economy/resourceTypes';
import type { MacroEconomyState } from '../economy/macro';
import type { StrategicMapModel } from '../world/map/MapTypes';
import type { GameState } from './GameState';
import type { EconomySlice } from './slices/economySlice';
import { validateGameStateOrThrow } from './validate';

/**
 * Builds the initial GameState from static data + config.
 *
 * Referential integrity of the world JSON is validated here (regions,
 * factories, units, characters, relations must point at existing records).
 *
 * `mapModel` (Part 2): the generated strategic map, used to join each
 * country's capital city and id space into the country data slice. Pass it
 * whenever the strategic map exists (always, in Game.init).
 */
export function createInitialState(
  data: DataRegistry,
  config: GameConfig,
  ids: IdGenerator,
  mapModel?: StrategicMapModel
): GameState {
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
    supply: Object.fromEntries(Object.keys(world.regions).map((regionId) => [regionId, 1])),
    macro: {} as Record<string, MacroEconomyState>,
    resources: {} as EconomySlice['resources']
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
  // Phase 2 unification: the strategic-map countries (country_0…) now ALSO
  // live in the political slice (stability/legitimacy/war exhaustion), while
  // the legacy demo-world ids keep their records for the old simulation.
  const strategicCountryIds = mapModel !== undefined ? [...mapModel.countryOrder] : [];
  const politicalCountryIds = [...countryIds, ...strategicCountryIds];
  const political = {
    countries: Object.fromEntries(
      politicalCountryIds.map((id) => [id, { stability: 0.6, legitimacy: 0.7, warExhaustion: 0 }])
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
      countryConfirmed: false,
      mode: null,
      focusChunkId: null,
      selection: []
    },
    map: createDefaultMapSlice(config.map.columns, config.map.rows, config.map.cellSize),
    countries: buildCountrySlice(data.countryProfileList, mapModel ?? null),
    government: { countries: {} },
    cityAreas: { network: { areas: {}, links: {} } }
  };

  // —— Phase 2: strategic-country economy & government ——
  // The strategic countries share the legacy treasury record (ONE money
  // source) and get full macro + government records built from the map.
  if (mapModel !== undefined) {
    const rng = new Random((config.map.seed ^ 0x9e3779b9) >>> 0);
    const countryNames: Record<string, string> = {};
    for (const countryId of mapModel.countryOrder) {
      countryNames[countryId] = mapModel.countries[countryId].name;
      // Treasury: prefer the declared profile value (data-driven start).
      const profile = state.countries.countries[countryId];
      economy.treasury[countryId] = profile?.economy.treasury ?? config.economy.startingTreasury;
      economy.macro[countryId] = createMacroEconomy(profile?.population ?? 1_500_000);
    }
    state.government = buildGovernmentSlice(
      mapModel.countryOrder,
      countryNames,
      data.partyTemplateList,
      data.ministryTemplateList,
      rng
    );
    state.cityAreas = createCityAreasSlice(mapModel, config.map.columns);
    // Strategic resource economy: computed from the live map + state
    // (deposit attribution, consumption drivers, world market).
    recomputeResourceEconomies(state, mapModel, data.economyData.strategicResources);
  }

  validateGameStateOrThrow(state);
  return state;
}

/**
 * Phase 2 load heal: ensures every strategic-map country has government,
 * macro, treasury and political records, and re-syncs the City Areas
 * network against the LIVE map model (regenerate + overlay saved runtime
 * fields by id). Called after every save load — covers migrated saves built
 * on a different map config and hand-made saves alike.
 */
export function healPhase2State(
  state: GameState,
  mapModel: StrategicMapModel,
  columns: number,
  data: DataRegistry
): void {
  const rng = new Random((mapModel.seed ^ 0x9e3779b9) >>> 0);
  const partyTemplates = data.partyTemplateList;
  const ministryTemplates = data.ministryTemplateList;

  for (const countryId of mapModel.countryOrder) {
    const mapCountry = mapModel.countries[countryId];
    if (state.government.countries[countryId] === undefined) {
      state.government.countries[countryId] = buildGovernmentSlice([countryId], { [countryId]: mapCountry.name }, partyTemplates, ministryTemplates, rng).countries[countryId];
    } else {
      // The 100% budget pool must stay consistent after any load path —
      // repair normalizes the shares, re-derives the money plumbing and
      // coerces an unknown tax level (idempotent for healthy records).
      repairBudgetRecord(state.government.countries[countryId]);
    }
    if (state.economy.macro[countryId] === undefined) {
      state.economy.macro[countryId] = createMacroEconomy(state.countries.countries[countryId]?.population ?? 1_500_000);
    }
    if (state.economy.treasury[countryId] === undefined) {
      state.economy.treasury[countryId] = state.countries.countries[countryId]?.economy.treasury ?? 500;
    }
    if (state.political.countries[countryId] === undefined) {
      state.political.countries[countryId] = { stability: 0.6, legitimacy: 0.7, warExhaustion: 0 };
    }
  }

  // Drop government/macro records for countries the live model no longer has
  // (map config changed across versions) — they would be dead weight.
  const liveIds = new Set<string>(mapModel.countryOrder);
  for (const countryId of Object.keys(state.government.countries)) {
    if (!liveIds.has(countryId)) delete state.government.countries[countryId];
  }
  for (const countryId of Object.keys(state.economy.macro)) {
    if (!liveIds.has(countryId)) delete state.economy.macro[countryId];
  }

  syncCityAreasSlice(state.cityAreas, mapModel, columns);

  // Resource economy: recomputed from the LIVE map + state on every load —
  // old saves (missing or stale records) and changed maps self-heal here.
  if (state.economy.resources === undefined) state.economy.resources = {};
  for (const countryId of mapModel.countryOrder) {
    if (state.economy.resources[countryId] === undefined) {
      state.economy.resources[countryId] = emptyCountryResourceState();
    }
  }
  for (const countryId of Object.keys(state.economy.resources)) {
    if (!liveIds.has(countryId)) delete state.economy.resources[countryId];
  }
  recomputeResourceEconomies(state, mapModel, data.economyData.strategicResources);
}
