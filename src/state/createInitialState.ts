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
import { seedResourceEconomies } from '../economy/resources';
import { cellQualityOf, reserveCapacityOf } from '../economy/quality';
import type { StrategicResourcesConfig } from '../economy/types';
import { emptyCountryResourceState, emptyCountryFinanceState, emptyCountryConstructionState } from '../economy/resourceTypes';
import type { StrategicMapModel } from '../world/map/MapTypes';
import { findGridCell } from '../world/map/MapGeography';
import { DEFAULT_CONFIG } from '../config/configTypes';
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
    resources: {} as EconomySlice['resources'],
    finance: {} as EconomySlice['finance'],
    construction: {} as EconomySlice['construction'],
    buildings: {} as EconomySlice['buildings'],
    economyLevel: {} as Record<string, number>,
    contracts: [] as EconomySlice['contracts']
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
      // Treasury: ONE data-driven starting value (spec §1 — the simple
      // economy's money scale; the profile seeds are legacy-only now).
      economy.treasury[countryId] = config.economy.startingTreasury;
      economy.finance[countryId] = emptyCountryFinanceState();
      economy.construction[countryId] = emptyCountryConstructionState();
      economy.buildings[countryId] = {};
      // The 0-100 economy level starts NEUTRAL (spec §3 — the drift begins
      // from the middle of the scale, never from a pre-charged state).
      economy.economyLevel[countryId] = data.economyData.strategicResources.economyLevel.start;
    }
    // The world starts with NO trade contracts — every agreement is SIGNED
    // during the campaign (spec §6 — by presidents, never pre-seeded).
    if (economy.contracts === undefined) economy.contracts = [];
    state.government = buildGovernmentSlice(
      mapModel.countryOrder,
      countryNames,
      data.partyTemplateList,
      data.ministryTemplateList,
      rng
    );
    state.cityAreas = createCityAreasSlice(mapModel, config.map.columns);
    // The simple resource economy: SEEDS every country's records from the
    // live map + state (production/consumption + the starting stockpile —
    // no month is spent here; the cycle owns the monthly step).
    seedResourceEconomies(state, mapModel, data.economyData.strategicResources);
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
    if (state.economy.finance[countryId] === undefined) {
      state.economy.finance[countryId] = emptyCountryFinanceState();
    }
    if (state.economy.construction[countryId] === undefined) {
      state.economy.construction[countryId] = emptyCountryConstructionState();
    }
    if (state.economy.buildings[countryId] === undefined) {
      state.economy.buildings[countryId] = {};
    }
    if (state.economy.treasury[countryId] === undefined) {
      state.economy.treasury[countryId] = DEFAULT_CONFIG.economy.startingTreasury;
    }
    if (state.economy.economyLevel === undefined) state.economy.economyLevel = {};
    if (state.economy.economyLevel[countryId] === undefined) {
      state.economy.economyLevel[countryId] = data.economyData.strategicResources.economyLevel.start;
    }
    // Trade contracts (spec §6): saves predating v19 carry none — the heal
    // injects the empty list (the migration does the same for the payload).
    if (state.economy.contracts === undefined) state.economy.contracts = [];
    if (state.political.countries[countryId] === undefined) {
      state.political.countries[countryId] = { stability: 0.6, legitimacy: 0.7, warExhaustion: 0 };
    }
    // Legacy building/project records (pre-v17 saves) anchor to a CITY —
    // convert to the canonical GRID CELL the city occupies (spec §1) and
    // drop the stale field. A record whose city no longer exists in the
    // live model is dead weight and is dismantled.
    healBuildingAnchors(state, mapModel, countryId);
  }

  // Drop government/finance records for countries the live model no longer
  // has (map config changed across versions) — they would be dead weight.
  const liveIds = new Set<string>(mapModel.countryOrder);
  for (const countryId of Object.keys(state.government.countries)) {
    if (!liveIds.has(countryId)) delete state.government.countries[countryId];
  }
  for (const countryId of Object.keys(state.economy.finance)) {
    if (!liveIds.has(countryId)) delete state.economy.finance[countryId];
  }
  for (const countryId of Object.keys(state.economy.construction)) {
    if (!liveIds.has(countryId)) delete state.economy.construction[countryId];
  }
  for (const countryId of Object.keys(state.economy.buildings)) {
    if (!liveIds.has(countryId)) delete state.economy.buildings[countryId];
  }
  if (state.economy.economyLevel !== undefined) {
    for (const countryId of Object.keys(state.economy.economyLevel)) {
      if (!liveIds.has(countryId)) delete state.economy.economyLevel[countryId];
    }
  }

  syncCityAreasSlice(state.cityAreas, mapModel, columns);

  // Resource economy: reseeded from the LIVE map + state on every load —
  // old saves (missing or stale records) and changed maps self-heal here.
  if (state.economy.resources === undefined) state.economy.resources = {};
  for (const countryId of mapModel.countryOrder) {
    if (state.economy.resources[countryId] === undefined) {
      state.economy.resources[countryId] = emptyCountryResourceState();
    }
    // Shortage-duration tracking (spec §13) — records predating v18 gain
    // the empty map (no history is KNOWN, none is invented).
    const record = state.economy.resources[countryId];
    if (record.shortageMonths === undefined) record.shortageMonths = {};
  }
  for (const countryId of Object.keys(state.economy.resources)) {
    if (!liveIds.has(countryId)) delete state.economy.resources[countryId];
  }
  // Extractive buildings (spec §8) predating v18 have no reserve fields —
  // size them from the LIVE cell quality (the same rule completion uses).
  healBuildingReserves(state, mapModel, data.economyData.strategicResources);
  seedResourceEconomies(state, mapModel, data.economyData.strategicResources);
}

/**
 * Sizes the FINITE extraction reserves (spec §8) of completed oil/iron
 * buildings that lack them (saves predating v18): the SAME rule completion
 * uses — reserveUnits × (0.5 + 0.5 × cell quality). Idempotent: records
 * already carrying a reserve are untouched.
 */
function healBuildingReserves(
  state: GameState,
  mapModel: StrategicMapModel,
  config: StrategicResourcesConfig
): void {
  for (const [countryId, buildings] of Object.entries(state.economy.buildings)) {
    for (const building of Object.values(buildings)) {
      if (building.reserveRemaining !== undefined && building.reserveCapacity !== undefined) continue;
      const def = config.buildings.find((candidate) => candidate.id === building.typeId);
      if (def === undefined || def.reserveUnits <= 0) continue;
      const cellIndex = findGridCell(mapModel, building.cellKey);
      const quality = cellQualityOf(mapModel, cellIndex, def.resource, config);
      const capacity = reserveCapacityOf(def, quality, config);
      building.reserveRemaining = capacity;
      building.reserveCapacity = capacity;
      void countryId;
    }
  }
}

/**
 * Converts legacy city-anchored buildings/projects to grid-cell anchors
 * (spec §1). Uses ONLY the live map model (the single geographic truth):
 * the host cell is the one the city occupies. Unresolvable records are
 * removed — a building that lost its place has no effect.
 */
function healBuildingAnchors(state: GameState, mapModel: StrategicMapModel, countryId: string): void {
  const resolve = (cityId: unknown): string | null => {
    if (typeof cityId !== 'string' || cityId === '') return null;
    const city = mapModel.cities[cityId];
    if (city === undefined || city.countryId !== countryId || city.gridId === '') return null;
    return `${countryId}#${city.gridId}`;
  };
  const buildings = state.economy.buildings[countryId];
  if (buildings !== undefined) {
    for (const [buildingId, building] of Object.entries(buildings)) {
      const record = building as unknown as Record<string, unknown>;
      if (typeof record['cellKey'] === 'string' && record['cellKey'] !== '') {
        delete record['cityId'];
        continue;
      }
      const cellKey = resolve(record['cityId']);
      if (cellKey === null) {
        delete buildings[buildingId];
        continue;
      }
      buildings[buildingId] = { id: buildingId, typeId: String(record['typeId'] ?? ''), cellKey };
    }
  }
  const construction = state.economy.construction[countryId];
  if (construction !== undefined) {
    for (const project of construction.projects) {
      const record = project as unknown as Record<string, unknown>;
      if (typeof record['cellKey'] === 'string' && record['cellKey'] !== '') {
        delete record['cityId'];
        continue;
      }
      const cellKey = resolve(record['cityId']);
      if (cellKey === null) continue; // keep building; it finishes harmlessly
      (project as unknown as { cellKey: string }).cellKey = cellKey;
      delete record['cityId'];
    }
    construction.projects = construction.projects.filter(
      (project) => typeof (project as unknown as Record<string, unknown>)['cellKey'] === 'string' &&
        (project as unknown as Record<string, unknown>)['cellKey'] !== ''
    );
  }
}
