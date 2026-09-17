/**
 * Strategic resource economy (HoI4-inspired, deliberately simple).
 *
 * THE causal chain (per directive — never hand-made numbers):
 *
 *   City (deposit attribution, nearest-city per province/country)
 *     ↓
 *   Resource Production   (deposit quantity × productionScale, monthly)
 *     ↓
 *   Country Resource Pool (Σ over the country's cities)
 *     ↓
 *   Resource Consumption  (population × sectors × military — from live state)
 *     ↓
 *   Balance               (production + imports − consumption − exports)
 *     ↓
 *   Shortage / Surplus    (derived status — never stored by hand)
 *     ↓
 *   Import / Export       (player policies, world-market resolution)
 *
 * recomputeResourceEconomies is the ONE mutation path: it recomputes every
 * country's records from the LIVE map model + game state, resolves world
 * trade deterministically and writes state.economy.resources. It runs at
 * state creation, after every load (heal), once per campaign month (inside
 * processMonthEconomy) and after every trade-policy command — so losing a
 * city, growing industry or toggling a policy is reflected immediately.
 *
 * LEAF-friendly: depends only on state/map TYPES + utils. No renderer, no UI.
 */

import type { GameState } from '../state/GameState';
import type { StrategicMapModel, MapResourceDeposit } from '../world/map/MapTypes';
import type { StrategicResourcesConfig } from './types';
import { liveUnits } from '../state/slices/militarySlice';
import { roundTo } from '../utils/math';

/** Clear visual status of ONE resource (derived, never stored by hand). */
export type ResourceStatus = 'surplus' | 'balanced' | 'shortage' | 'imported' | 'exported';

/** Per-country resource economy record — fully JSON-safe (save-friendly). */
export interface CountryResourceState {
  /** Monthly production per resource id (Σ attributed city deposits). */
  production: Record<string, number>;
  /** Monthly consumption per resource id (population/sectors/military). */
  consumption: Record<string, number>;
  /** Active monthly imports per resource id (after world-market capping). */
  imports: Record<string, number>;
  /** Active monthly exports per resource id (surplus × exportShare). */
  exports: Record<string, number>;
  /** Player policies — import/export toggles (mutually exclusive per resource). */
  importPolicy: Record<string, boolean>;
  exportPolicy: Record<string, boolean>;
  /** resourceId → the supplier country the market routes the import through. */
  suppliers: Record<string, string | null>;
  /** Last computed monthly import cost (M$) — enters the ledger as spending. */
  importCost: number;
  /** Last computed monthly export income (M$) — enters the ledger as revenue. */
  exportIncome: number;
}

/** Tolerance for floating-point balance comparisons (units are ~1e-2). */
const EPSILON = 1e-6;

/** Empty record with the given policies preserved (defaults off). */
export function emptyCountryResourceState(
  importPolicy: Record<string, boolean> = {},
  exportPolicy: Record<string, boolean> = {}
): CountryResourceState {
  return {
    production: {},
    consumption: {},
    imports: {},
    exports: {},
    importPolicy: { ...importPolicy },
    exportPolicy: { ...exportPolicy },
    suppliers: {},
    importCost: 0,
    exportIncome: 0
  };
}

/** The ids of the strategic resources in canonical (config) order. */
export function strategicResourceIds(config: StrategicResourcesConfig): string[] {
  return config.resources.map((resource) => resource.id);
}

// ———————————————————————— production: deposits → cities → country ————————————————

/** Deposit attribution result: cityId → resourceId → monthly production. */
export type CityProductionMap = Record<string, Record<string, number>>;

interface DepositAttribution {
  readonly cityId: string;
  readonly deposit: MapResourceDeposit;
}

/**
 * Attributes EVERY deposit to EXACTLY ONE city of the SAME country:
 * nearest city of the host province (deterministic tie → city id); when the
 * province has no cities, the nearest city anywhere in the country. The map
 * model is the single source — cities lost/changed automatically reshuffle
 * the attribution on the next recompute.
 */
export function attributeDeposits(model: StrategicMapModel): DepositAttribution[] {
  const attributions: DepositAttribution[] = [];
  const citiesByProvince = new Map<string, string[]>();
  for (const province of Object.values(model.provinces)) {
    citiesByProvince.set(province.id, [...province.cityIds].sort());
  }

  const nearest = (cityIds: readonly string[], deposit: MapResourceDeposit): string | null => {
    let bestId: string | null = null;
    let bestDistance = Infinity;
    for (const cityId of cityIds) {
      const city = model.cities[cityId];
      if (city === undefined) continue;
      const distance = Math.hypot(
        city.position.x - deposit.position.x,
        city.position.z - deposit.position.z
      );
      if (distance < bestDistance - EPSILON || (Math.abs(distance - bestDistance) <= EPSILON && cityId < (bestId ?? ''))) {
        bestDistance = distance;
        bestId = cityId;
      }
    }
    return bestId;
  };

  const depositsByProvince = new Map<string, MapResourceDeposit[]>();
  for (const deposit of model.features.deposits) {
    const bucket = depositsByProvince.get(deposit.provinceId);
    if (bucket !== undefined) bucket.push(deposit);
    else depositsByProvince.set(deposit.provinceId, [deposit]);
  }

  for (const [provinceId, deposits] of depositsByProvince) {
    const province = model.provinces[provinceId];
    if (province === undefined) continue; // stale geometry — never attribute cross-country
    const provincialCities = citiesByProvince.get(provinceId) ?? [];
    for (const deposit of deposits) {
      let cityId = nearest(provincialCities, deposit);
      if (cityId === null) {
        // Province without cities → nearest city of the SAME country.
        const country = model.countries[deposit.countryId];
        const countryCities = country !== undefined
          ? [...country.cityIds].sort()
          : [];
        cityId = nearest(countryCities, deposit);
      }
      if (cityId !== null) attributions.push({ cityId, deposit });
    }
  }
  return attributions;
}

/** Monthly production of ONE city from its attributed deposits. */
export function cityResourceProduction(
  model: StrategicMapModel,
  cityId: string,
  config: StrategicResourcesConfig,
  attributions?: DepositAttribution[]
): Record<string, number> {
  const production: Record<string, number> = {};
  for (const { cityId: owner, deposit } of attributions ?? attributeDeposits(model)) {
    if (owner !== cityId) continue;
    const scale = config.productionScale;
    production[deposit.resourceId] = roundTo((production[deposit.resourceId] ?? 0) + deposit.quantity * scale, 2);
  }
  return production;
}

/** Monthly production of ONE country (Σ over its cities' attributed deposits). */
export function countryResourceProduction(
  model: StrategicMapModel,
  countryId: string,
  config: StrategicResourcesConfig,
  cache?: Map<string, Record<string, number>>
): Record<string, number> {
  const cached = cache?.get(countryId);
  if (cached !== undefined) return cached;
  const production: Record<string, number> = {};
  for (const { cityId, deposit } of attributeDeposits(model)) {
    const city = model.cities[cityId];
    if (city === undefined || city.countryId !== countryId) continue;
    production[deposit.resourceId] = roundTo(
      (production[deposit.resourceId] ?? 0) + deposit.quantity * config.productionScale,
      2
    );
  }
  cache?.set(countryId, production);
  return production;
}

// ———————————————————————— consumption: population × sectors × military ————————————————

/**
 * Monthly consumption of ONE country, derived from LIVE state:
 * population (food/wood), sector outputs (industry/energy/…), operational
 * military units (oil/iron). No hard-coded country numbers.
 */
export function countryResourceConsumption(
  state: GameState,
  countryId: string,
  config: StrategicResourcesConfig
): Record<string, number> {
  const consumption: Record<string, number> = {};
  const population = state.countries.countries[countryId]?.population ?? 0;
  const macro = state.economy.macro[countryId];
  const units = liveUnits(state.military).filter((unit) => unit.countryId === countryId).length;

  for (const resource of config.resources) {
    const def = config.consumption[resource.id];
    if (def === undefined) continue;
    let amount = 0;
    if (def.perMillionPopulation !== undefined) {
      amount += (population / 1_000_000) * def.perMillionPopulation;
    }
    if (def.perBillionOutput !== undefined && macro !== undefined) {
      const sectors = macro.sectors as Record<string, { output: number } | undefined>;
      for (const [sectorId, rate] of Object.entries(def.perBillionOutput)) {
        const output = sectors[sectorId]?.output ?? 0; // annual M$
        amount += (output / 1000) * rate; // per 1B$ annual output, monthly units
      }
    }
    if (def.perMilitaryUnit !== undefined) {
      amount += units * def.perMilitaryUnit;
    }
    if (amount > 0) consumption[resource.id] = roundTo(amount, 2);
  }
  return consumption;
}

// ———————————————————————— world market: import/export resolution ————————————————

/**
 * Derives the clear status of ONE resource from the computed record.
 * shortage → (fully covered by imports) imported; surplus sold → exported.
 */
export function resourceStatusOf(record: CountryResourceState, resourceId: string): ResourceStatus {
  const production = record.production[resourceId] ?? 0;
  const consumption = record.consumption[resourceId] ?? 0;
  const imports = record.imports[resourceId] ?? 0;
  const exports = record.exports[resourceId] ?? 0;
  if (consumption > production + EPSILON) {
    const deficit = consumption - production;
    return imports >= deficit - 1e-4 ? 'imported' : 'shortage';
  }
  if (production > consumption + EPSILON) {
    return exports > EPSILON ? 'exported' : 'surplus';
  }
  return 'balanced';
}

/** Net monthly balance of ONE resource (production + imports − consumption − exports). */
export function resourceBalanceOf(record: CountryResourceState, resourceId: string): number {
  return roundTo(
    (record.production[resourceId] ?? 0) +
      (record.imports[resourceId] ?? 0) -
      (record.consumption[resourceId] ?? 0) -
      (record.exports[resourceId] ?? 0),
    2
  );
}

/**
 * THE single recompute path for the whole strategic resource economy.
 * Recomputes production/consumption for every strategic country from the
 * live map + state, resolves the world market deterministically (importers
 * in canonical country order, largest exporter surplus first, tie → order)
 * and writes state.economy.resources. Policies are PRESERVED across passes;
 * trade amounts auto-cap as surpluses shrink or vanish.
 */
export function recomputeResourceEconomies(
  state: GameState,
  mapModel: StrategicMapModel,
  config: StrategicResourcesConfig
): void {
  const countryIds = Object.keys(state.government.countries).filter(
    (countryId) => state.economy.macro[countryId] !== undefined
  );
  const canonicalOrder = mapModel.countryOrder.filter((countryId) => countryIds.includes(countryId));
  // Countries present in state but unknown to the map (stale records) keep a
  // zeroed record — they produce and consume nothing.
  const extraIds = countryIds.filter((countryId) => !canonicalOrder.includes(countryId));
  const order = [...canonicalOrder, ...extraIds].sort((a, b) => {
    const indexA = canonicalOrder.indexOf(a);
    const indexB = canonicalOrder.indexOf(b);
    return (indexA === -1 ? canonicalOrder.length : indexA) - (indexB === -1 ? canonicalOrder.length : indexB);
  });

  // —— pass 1: production + consumption from live data ——
  const productionCache = new Map<string, Record<string, number>>();
  const computed = new Map<string, { production: Record<string, number>; consumption: Record<string, number> }>();
  for (const countryId of order) {
    computed.set(countryId, {
      production: countryResourceProduction(mapModel, countryId, config, productionCache),
      consumption: countryResourceConsumption(state, countryId, config)
    });
  }

  // —— pass 2: world market per resource (deterministic) ——
  const priceOf = new Map<string, number>(config.resources.map((resource) => [resource.id, resource.price]));
  const importsOf = new Map<string, Record<string, number>>();
  const exportsOf = new Map<string, Record<string, number>>();
  const suppliersOf = new Map<string, Record<string, string | null>>();
  for (const resourceId of strategicResourceIds(config)) {
    // Exports first: policy ON → offer the configured share of the surplus.
    const exports: Record<string, number> = {};
    const netSurplus: Record<string, number> = {};
    for (const countryId of order) {
      const { production, consumption } = computed.get(countryId)!;
      const surplus = Math.max(0, (production[resourceId] ?? 0) - (consumption[resourceId] ?? 0));
      const policy = state.economy.resources[countryId]?.exportPolicy[resourceId] === true;
      const offered = policy ? surplus * config.exportShare : 0;
      exports[countryId] = roundTo(offered, 2);
      netSurplus[countryId] = roundTo(surplus - offered, 2); // offered units leave the market pool
    }
    // Imports: requested deficit, capped by what the world can spare.
    const suppliers: Record<string, string | null> = {};
    for (const countryId of order) {
      const { production, consumption } = computed.get(countryId)!;
      const deficit = Math.max(0, (consumption[resourceId] ?? 0) - (production[resourceId] ?? 0));
      const policy = state.economy.resources[countryId]?.importPolicy[resourceId] === true;
      if (!policy || deficit <= EPSILON) {
        suppliers[countryId] = null;
        continue;
      }
      // Supplier = other country with the largest remaining spare surplus.
      let bestId: string | null = null;
      let bestSpare = 0;
      for (const otherId of order) {
        if (otherId === countryId) continue;
        const spare = netSurplus[otherId] ?? 0;
        if (spare > bestSpare + EPSILON || (Math.abs(spare - bestSpare) <= EPSILON && spare > EPSILON && (bestId === null || otherId < bestId))) {
          bestSpare = spare;
          bestId = otherId;
        }
      }
      const bought = Math.min(deficit, Math.max(0, bestSpare));
      importsOf.set(countryId, { ...(importsOf.get(countryId) ?? {}), [resourceId]: roundTo(bought, 2) });
      suppliers[countryId] = bought > EPSILON ? bestId : null;
    }
    for (const countryId of order) {
      exportsOf.set(countryId, { ...(exportsOf.get(countryId) ?? {}), [resourceId]: exports[countryId] });
      suppliersOf.set(countryId, { ...(suppliersOf.get(countryId) ?? {}), [resourceId]: suppliers[countryId] });
    }
  }

  // —— pass 3: write records (policies preserved) ——
  for (const countryId of order) {
    const previous = state.economy.resources[countryId] ?? emptyCountryResourceState();
    const { production, consumption } = computed.get(countryId)!;
    let importCost = 0;
    let exportIncome = 0;
    for (const resourceId of strategicResourceIds(config)) {
      const price = priceOf.get(resourceId) ?? 0;
      importCost += (importsOf.get(countryId)?.[resourceId] ?? 0) * price * config.importMarkup;
      exportIncome += (exportsOf.get(countryId)?.[resourceId] ?? 0) * price;
    }
    state.economy.resources[countryId] = {
      production,
      consumption,
      imports: importsOf.get(countryId) ?? {},
      exports: exportsOf.get(countryId) ?? {},
      importPolicy: { ...previous.importPolicy },
      exportPolicy: { ...previous.exportPolicy },
      suppliers: suppliersOf.get(countryId) ?? {},
      importCost: roundTo(importCost, 2),
      exportIncome: roundTo(exportIncome, 2)
    };
  }
}
