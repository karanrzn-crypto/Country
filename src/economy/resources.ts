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
 *   Balance               (production − consumption; trade never distorts it)
 *     ↓
 *   Shortage / Surplus    (derived status — never stored by hand)
 *     ↓
 *   Global Trade Network  (any surplus country ↔ any shortage country)
 *
 * recomputeResourceEconomies is the ONE mutation path of the GLOBAL trade
 * network: it recomputes every country's production/consumption from the
 * LIVE map model + game state, resolves the world market for ALL countries
 * at once (any surplus country can serve any shortage country — the player
 * is not the hub) and writes state.economy.resources. It runs at state
 * creation, after every load (heal) and ONCE per campaign month (from the
 * GovernmentSystem, before the country ledgers) — so losing a city or
 * growing industry is reflected at the next month boundary.
 *
 * LEAF-friendly: depends only on state/map TYPES + utils. No renderer, no UI.
 */

import type { GameState } from '../state/GameState';
import type { StrategicMapModel, MapResourceDeposit } from '../world/map/MapTypes';
import type { StrategicResourcesConfig } from './types';
import { liveUnits } from '../state/slices/militarySlice';
import { roundTo } from '../utils/math';
import {
  type CountryResourceState,
  type ResourceStatus
} from './resourceTypes';
import { countryBaselineProduction } from './domesticBaseline';
import { resolveWorldTradeForResource } from './tradeNetwork';

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
 * THE single recompute path of the GLOBAL TRADE NETWORK.
 *
 * Pipeline (spec §11 — world level, NOT player-centric):
 *   production (deposits + geography baseline) for EVERY country
 *     → consumption (population/sectors/military) for EVERY country
 *     → surplus/shortage per country and resource
 *     → the world matcher connects exporters with importers (ANY two
 *       countries with a real surplus and a real shortage — no policies,
 *       no seller picking; a country never sells what it needs itself)
 *     → trade transactions (imports = actually bought, exports = actually
 *       sold — an unmatched surplus stays export POTENTIAL, never fake
 *       income)
 *     → unfilled shortage survives only when GLOBAL supply < GLOBAL demand.
 *
 * Deterministic: largest surplus serves first, most urgent shortage buys
 * first, ties → country id. Billing uses the GLOBAL market price tier
 * (spec §10: abundant → cheap, scarce → expensive).
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

  // —— pass 2: the GLOBAL trade market, resource by resource ——
  // Production/consumption of ALL countries are already computed (pass 1);
  // the matcher builds the global supply/demand and connects ANY surplus
  // country with ANY shortage country (A→B, C→B, … — player or not).
  const productionByCountry: Record<string, Record<string, number>> = {};
  const consumptionByCountry: Record<string, Record<string, number>> = {};
  for (const countryId of order) {
    const record = computed.get(countryId)!;
    productionByCountry[countryId] = record.production;
    consumptionByCountry[countryId] = record.consumption;
  }

  const priceOf = new Map<string, number>(config.resources.map((resource) => [resource.id, resource.price]));
  // Per-resource resolution results (flows + market tier) for the billing.
  const resolved = new Map<string, ReturnType<typeof resolveWorldTradeForResource>>();
  for (const resourceId of strategicResourceIds(config)) {
    resolved.set(
      resourceId,
      resolveWorldTradeForResource(order, productionByCountry, consumptionByCountry, resourceId)
    );
  }

  // —— pass 3: write records — imports/exports are the ACTUAL trade flows ——
  // Billing: buyers pay the market tier's supply factor over the base price
  // (+ transport markup), sellers receive the tier's demand factor —
  // internal money only, never shown as $ in the UI (spec §10).
  for (const countryId of order) {
    const { production, consumption } = computed.get(countryId)!;
    const imports: Record<string, number> = {};
    const exports: Record<string, number> = {};
    const suppliers: Record<string, Record<string, number>> = {};
    const unfilledShortage: Record<string, number> = {};
    let importCost = 0;
    let exportIncome = 0;
    for (const resourceId of strategicResourceIds(config)) {
      const result = resolved.get(resourceId)!;
      const price = priceOf.get(resourceId) ?? 0;
      const tier = result.marketTier;
      const bought = result.importsByBuyer[countryId] ?? 0;
      const sold = result.exportsBySeller[countryId] ?? 0;
      if (bought > 0) {
        imports[resourceId] = bought;
        importCost += bought * price * config.importMarkup * config.priceTiers.supply[tier];
      }
      if (sold > 0) {
        exports[resourceId] = sold;
        exportIncome += sold * price * config.priceTiers.demand[tier];
      }
      const partnerFlows = result.flows.filter(
        (flow) => flow.buyerId === countryId && flow.amount > 0
      );
      if (partnerFlows.length > 0) {
        const bySeller: Record<string, number> = {};
        for (const flow of partnerFlows) bySeller[flow.sellerId] = flow.amount;
        suppliers[resourceId] = bySeller;
      }
      const unfilled = result.unfilledByBuyer[countryId] ?? 0;
      if (unfilled > 0) unfilledShortage[resourceId] = unfilled;
    }
    state.economy.resources[countryId] = {
      production,
      consumption,
      imports,
      exports,
      suppliers,
      unfilledShortage,
      importCost: roundTo(importCost, 2),
      exportIncome: roundTo(exportIncome, 2)
    };
  }
}
