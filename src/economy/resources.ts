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
import {
  emptyCountryResourceState,
  type CountryResourceState,
  type ResourceStatus
} from './resourceTypes';
import { countryBaselineProduction } from './domesticBaseline';
import {
  demandFactorFromNeeds,
  tiersFromSpares,
  type TradeTier
} from './market';

// Record shapes live in the LEAF types module (state imports them without
// reaching this logic — keeps GameState → economySlice → resourceTypes
// acyclic). Public surface is unchanged: they are re-exported here.
export { emptyCountryResourceState } from './resourceTypes';
export type { CountryResourceState, ResourceStatus } from './resourceTypes';

/** Tolerance for floating-point balance comparisons (units are ~1e-2). */
const EPSILON = 1e-6;

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

/** Monthly production of ONE city from its attributed deposits.
 *  Quantities are WHOLE units (spec §3's simple math: what the UI shows is
 *  exactly what the simulation stores — no fraction puzzles). */
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
    production[deposit.resourceId] = Math.round((production[deposit.resourceId] ?? 0) + deposit.quantity * scale);
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
    production[deposit.resourceId] = Math.round(
      (production[deposit.resourceId] ?? 0) + deposit.quantity * config.productionScale
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
    if (amount > 0) consumption[resource.id] = Math.round(amount);
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
 * RAW monthly balance of ONE resource — the number the Economy page shows:
 *
 *   Balance = Production − Consumption
 *
 * Trade NEVER distorts it (production 14, consumption 29 → −15 even while
 * 15/month are imported — 14 + 15 − 29 = 0 is the POST-trade state, which
 * is expressed by the STATUS, not by this number).
 */
export function resourceRawBalanceOf(record: CountryResourceState, resourceId: string): number {
  return roundTo(
    (record.production[resourceId] ?? 0) - (record.consumption[resourceId] ?? 0),
    2
  );
}

/** The THREE user-facing statuses (spec: Surplus / Balanced / Shortage). */
export type ResourceDisplayStatus = 'surplus' | 'balanced' | 'shortage';

/**
 * Derives the clear display status of ONE resource from the REAL numbers —
 * never hand-set, recomputed with every recompute pass:
 * - production > consumption                          → surplus (exportable);
 * - covered (exact, or shortage fully imported away)  → balanced;
 * - still uncovered deficit                           → shortage.
 * Example: 14 produced, 29 consumed, 15 imported → 14 + 15 − 29 = 0 →
 * the FINAL status reads balanced (while the raw balance stays −15).
 */
export function resourceDisplayStatusOf(
  record: CountryResourceState,
  resourceId: string
): ResourceDisplayStatus {
  const production = record.production[resourceId] ?? 0;
  const consumption = record.consumption[resourceId] ?? 0;
  const imports = record.imports[resourceId] ?? 0;
  if (production > consumption + EPSILON) return 'surplus';
  if (production + imports >= consumption - 1e-4) return 'balanced';
  return 'shortage';
}

/**
 * THE single recompute path for the whole strategic resource economy.
 * Recomputes production/consumption for every strategic country from the
 * live map + state (production = attributed city deposits + the GEOGRAPHY
 * baseline — spec §3) and resolves the world market deterministically:
 *
 *  - the PLAYER-pinned supplier is bought from FIRST (while it has spare);
 *  - the remaining deficit is filled from the other sellers, LARGEST spare
 *    first (tie → country id) — as many as needed;
 *  - a seller's pool DECREMENTS as the market buys, so supply is never
 *    sold twice;
 *  - if any seller exists, the FULL normal deficit is bought (spec §3:
 *    production 10 + import 20 − consumption 30 = 0). A shortage survives
 *    only when the whole market is exhausted.
 *
 * Policies and the preferred suppliers are PRESERVED across passes; import
 * cost bills each seller at ITS OWN price tier (cheap sellers hold more
 * surplus — spec §4/§7); export income uses the market's average DEMAND
 * tier (eager buyers pay more — spec §6/§7).
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
  // Production = city deposits + the geography-driven domestic baseline
  // (spec §3: no country sits irrationally at zero for nearly everything).
  const productionCache = new Map<string, Record<string, number>>();
  const computed = new Map<string, { production: Record<string, number>; consumption: Record<string, number> }>();
  for (const countryId of order) {
    const deposits = countryResourceProduction(mapModel, countryId, config, productionCache);
    const baseline = countryBaselineProduction(mapModel, countryId, config.domesticBaseline);
    const production: Record<string, number> = { ...deposits };
    for (const [resourceId, amount] of Object.entries(baseline)) {
      production[resourceId] = Math.round((production[resourceId] ?? 0) + amount);
    }
    computed.set(countryId, {
      production,
      consumption: countryResourceConsumption(state, countryId, config)
    });
  }

  // —— pass 2: world market per resource (deterministic) ——
  const priceOf = new Map<string, number>(config.resources.map((resource) => [resource.id, resource.price]));
  const importsOf = new Map<string, Record<string, number>>();
  const exportsOf = new Map<string, Record<string, number>>();
  const suppliersOf = new Map<string, Record<string, string[]>>();
  // Per-resource seller price tiers (from the CURRENT pass's spares) and the
  // market's average willingness to pay — the ledger's tier pricing inputs.
  const sellerTiersOf = new Map<string, Record<string, TradeTier>>();
  const demandFactorOf = new Map<string, number>();
  // buyerId → resourceId → per-seller purchased amounts (the tiered import
  // billing source: each seller charges at its OWN supply tier).
  const purchaseFlows = new Map<string, Record<string, { sellerId: string; amount: number }[]>>();
  for (const resourceId of strategicResourceIds(config)) {
    // Exports first: policy ON → offer the configured share of the surplus.
    const exports: Record<string, number> = {};
    const netSurplus: Record<string, number> = {};
    const needs: Record<string, number> = {};
    for (const countryId of order) {
      const { production, consumption } = computed.get(countryId)!;
      const surplus = Math.max(0, (production[resourceId] ?? 0) - (consumption[resourceId] ?? 0));
      const policy = state.economy.resources[countryId]?.exportPolicy[resourceId] === true;
      const offered = policy ? surplus * config.exportShare : 0;
      exports[countryId] = Math.round(offered);
      netSurplus[countryId] = Math.round(surplus - exports[countryId]); // offered units leave the market pool
      const need = (consumption[resourceId] ?? 0) - (production[resourceId] ?? 0);
      if (need > EPSILON) needs[countryId] = need;
    }
    // Tiers BEFORE any import buys: the surplus field the sellers really
    // offer from (net of their own export commitments — spec §4's basis).
    sellerTiersOf.set(resourceId, tiersFromSpares(netSurplus));
    demandFactorOf.set(resourceId, demandFactorFromNeeds(needs, config.priceTiers.demand));
    // Imports: the FULL deficit is bought whenever the market can cover it
    // (spec §3). The seller pool DECREMENTS with every purchase (supply is
    // never sold twice). Fill order: the PLAYER-pinned supplier first
    // (preferredSuppliers), then the largest remaining spare (tie → id) —
    // deterministic regardless of iteration order.
    const available: Record<string, number> = { ...netSurplus };
    const suppliers: Record<string, string[]> = {};
    for (const countryId of order) {
      const { production, consumption } = computed.get(countryId)!;
      const deficit = Math.max(0, (consumption[resourceId] ?? 0) - (production[resourceId] ?? 0));
      const policy = state.economy.resources[countryId]?.importPolicy[resourceId] === true;
      suppliers[countryId] = [];
      if (!policy || deficit <= EPSILON) continue;
      const preferred = state.economy.resources[countryId]?.preferredSuppliers?.[resourceId] ?? null;
      const candidates = order
        .filter((otherId) => otherId !== countryId && (available[otherId] ?? 0) > EPSILON)
        .sort((a, b) => {
          const pinA = a === preferred ? 0 : 1;
          const pinB = b === preferred ? 0 : 1;
          if (pinA !== pinB) return pinA - pinB;
          const spareA = available[a] ?? 0;
          const spareB = available[b] ?? 0;
          if (Math.abs(spareA - spareB) > EPSILON) return spareB - spareA;
          return a < b ? -1 : 1;
        });
      let remaining = deficit;
      const flows: { sellerId: string; amount: number }[] = [];
      for (const sellerId of candidates) {
        if (remaining <= EPSILON) break;
        const spare = available[sellerId] ?? 0;
        if (spare <= EPSILON) continue;
        const bought = Math.min(spare, remaining);
        available[sellerId] = Math.round(spare - bought);
        remaining = Math.round(remaining - bought);
        flows.push({ sellerId, amount: Math.round(bought) });
      }
      const boughtTotal = flows.reduce((sum, flow) => sum + flow.amount, 0);
      importsOf.set(countryId, { ...(importsOf.get(countryId) ?? {}), [resourceId]: boughtTotal });
      suppliers[countryId] = flows.map((flow) => flow.sellerId);
      if (flows.length > 0) {
        purchaseFlows.set(countryId, { ...(purchaseFlows.get(countryId) ?? {}), [resourceId]: flows });
      }
    }
    for (const countryId of order) {
      exportsOf.set(countryId, { ...(exportsOf.get(countryId) ?? {}), [resourceId]: exports[countryId] });
      suppliersOf.set(countryId, { ...(suppliersOf.get(countryId) ?? {}), [resourceId]: suppliers[countryId] });
    }
  }

  // —— pass 3: write records (policies + preferred suppliers preserved) ——
  // Import cost bills EACH SELLER at its own price tier (cheap sellers
  // charge less — spec §7); export income uses the market's average DEMAND
  // tier (eager buyers pay more) — internal money only, never shown as $.
  const records = new Map<string, CountryResourceState>();
  for (const countryId of order) {
    const previous = state.economy.resources[countryId] ?? emptyCountryResourceState();
    records.set(countryId, previous);
  }
  for (const countryId of order) {
    const previous = records.get(countryId)!;
    const { production, consumption } = computed.get(countryId)!;
    let importCost = 0;
    let exportIncome = 0;
    for (const resourceId of strategicResourceIds(config)) {
      const price = priceOf.get(resourceId) ?? 0;
      for (const flow of purchaseFlows.get(countryId)?.[resourceId] ?? []) {
        const tier = sellerTiersOf.get(resourceId)?.[flow.sellerId] ?? 'medium';
        importCost += flow.amount * price * config.importMarkup * config.priceTiers.supply[tier];
      }
      const exports = exportsOf.get(countryId)?.[resourceId] ?? 0;
      if (exports > 0) {
        exportIncome += exports * price * (demandFactorOf.get(resourceId) ?? 1);
      }
    }
    state.economy.resources[countryId] = {
      production,
      consumption,
      imports: importsOf.get(countryId) ?? {},
      exports: exportsOf.get(countryId) ?? {},
      importPolicy: { ...previous.importPolicy },
      exportPolicy: { ...previous.exportPolicy },
      suppliers: suppliersOf.get(countryId) ?? {},
      preferredSuppliers: { ...(previous.preferredSuppliers ?? {}) },
      importCost: roundTo(importCost, 2),
      exportIncome: roundTo(exportIncome, 2)
    };
  }
}
