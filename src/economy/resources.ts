/**
 * The SIMPLE resource economy — production, consumption, statuses (spec §1-§5).
 *
 * THE causal chain (spec §10's cycle — implemented in economyCycle.ts):
 *
 *   Deposits (geography) + Domestic baseline + Buildings  ← PRODUCTION
 *     ↓
 *   Consumption  (population food · military wear)
 *     ↓
 *   STOCK STEP  (stock += production − consumption, floored at 0)
 *     ↓
 *   World Trade (shortage buys from surplus at the BASE price — §6/§7)
 *     ↓
 *   Shortage → the player buys explicitly (command) → trade keeps flowing
 *
 * This module holds the PURE helpers: production/consumption math, the
 * safety reserve, the honest shortage and display status, plus the SEED
 * pass used at state creation and after every load. The monthly cycle
 * itself lives in economyCycle.ts — the ONE writer of the live records.
 *
 * Anti-famine guarantees (spec §5/§9): deposits are permanent capacity
 * (never depleted), buildings raise production, the safety reserve keeps
 * exports from stripping domestic stocks, and consumption is smooth —
 * shortages can happen, automatic famine cannot.
 *
 * LEAF-friendly: depends only on state/map TYPES + utils. No renderer, no UI.
 */

import type { GameState } from '../state/GameState';
import type { StrategicMapModel, MapResourceDeposit } from '../world/map/MapTypes';
import type { StrategicResourcesConfig } from './types';
import { liveUnits } from '../state/slices/militarySlice';
import { type CountryResourceState, type ResourceDisplayStatus, type ResourceStatus } from './resourceTypes';
import { countryBaselineProduction } from './domesticBaseline';

export { emptyCountryResourceState } from './resourceTypes';
export type { CountryResourceState, ResourceDisplayStatus, ResourceStatus } from './resourceTypes';

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

/**
 * Monthly production of ONE deposit: quantity × productionScale (spec §4 —
 * the land's honest output; no levels, no research). Whole units.
 */
export function depositMonthlyProduction(
  deposit: MapResourceDeposit,
  config: StrategicResourcesConfig
): number {
  return Math.round(deposit.quantity * config.productionScale);
}

/** Adds `amount` units of ONE resource into a production-style record. */
function addToRecord(record: Record<string, number>, resourceId: string, amount: number): void {
  record[resourceId] = (record[resourceId] ?? 0) + amount;
}

/** Monthly production of ONE city from its attributed deposits (whole units). */
export function cityResourceProduction(
  model: StrategicMapModel,
  cityId: string,
  config: StrategicResourcesConfig,
  attributions?: DepositAttribution[]
): Record<string, number> {
  const production: Record<string, number> = {};
  for (const { cityId: owner, deposit } of attributions ?? attributeDeposits(model)) {
    if (owner !== cityId) continue;
    addToRecord(production, deposit.resourceId, depositMonthlyProduction(deposit, config));
  }
  return production;
}

/** Monthly PRODUCTION of ONE province (spec §4: استان → تولید منابع). */
export function provinceResourceProduction(
  model: StrategicMapModel,
  provinceId: string,
  config: StrategicResourcesConfig
): Record<string, number> {
  const province = model.provinces[provinceId];
  const production: Record<string, number> = {};
  if (province === undefined) return production;
  for (const deposit of model.features.deposits) {
    if (deposit.provinceId !== provinceId) continue;
    addToRecord(production, deposit.resourceId, depositMonthlyProduction(deposit, config));
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
    addToRecord(production, deposit.resourceId, depositMonthlyProduction(deposit, config));
  }
  cache?.set(countryId, production);
  return production;
}

// ————————————————————————————— buildings (spec §8) ————————————————————————————

/** Monthly PRODUCTION added by the country's completed buildings. */
export function buildingProductionOf(
  state: GameState,
  countryId: string,
  config: StrategicResourcesConfig
): Record<string, number> {
  const output: Record<string, number> = {};
  const buildings = state.economy.buildings[countryId];
  if (buildings === undefined) return output;
  for (const building of Object.values(buildings)) {
    const def = config.buildings.find((candidate) => candidate.id === building.typeId);
    if (def === undefined || def.effect !== 'production' || def.resource === undefined) continue;
    addToRecord(output, def.resource, def.output ?? 0);
  }
  return output;
}

/** Monthly INCOME added by the country's completed buildings (spec §8). */
export function buildingIncomeOf(
  state: GameState,
  countryId: string,
  config: StrategicResourcesConfig
): number {
  let income = 0;
  const buildings = state.economy.buildings[countryId];
  if (buildings === undefined) return 0;
  for (const building of Object.values(buildings)) {
    const def = config.buildings.find((candidate) => candidate.id === building.typeId);
    if (def !== undefined && def.effect === 'income') income += def.income ?? 0;
  }
  return income;
}

// ———————————————————————— consumption: population × military ————————————————

/**
 * Monthly consumption of ONE country, derived from LIVE state (spec §5 —
 * every unit has a clear reason):
 *  - population eats food (perMillionPopulation, config — §5's formula);
 *  - military units burn oil and wear iron (perMilitaryUnit).
 */
export function countryResourceConsumption(
  state: GameState,
  countryId: string,
  config: StrategicResourcesConfig
): Record<string, number> {
  const consumption: Record<string, number> = {};
  const population = state.countries.countries[countryId]?.population ?? 0;
  const units = liveUnits(state.military).filter((unit) => unit.countryId === countryId).length;

  for (const resource of config.resources) {
    const def = config.consumption[resource.id];
    if (def === undefined) continue;
    let amount = 0;
    if (def.perMillionPopulation !== undefined) {
      amount += (population / 1_000_000) * def.perMillionPopulation;
    }
    if (def.perMilitaryUnit !== undefined) {
      amount += units * def.perMilitaryUnit;
    }
    if (amount > 0) consumption[resource.id] = Math.round(amount);
  }
  return consumption;
}

// ———————————————————————— reserve · shortage · status ————————————————

/**
 * The SAFETY RESERVE of ONE resource for ONE country (spec §5): months of
 * consumption the country keeps out of exports — food its own (larger)
 * buffer, every other resource `reserveMonths`. THE shared definition used
 * by the world trade offers AND the manual seller list.
 */
export function safetyReserveUnits(
  consumption: Readonly<Record<string, number>>,
  resourceId: string,
  config: StrategicResourcesConfig
): number {
  const monthly = consumption[resourceId] ?? 0;
  const months = resourceId === 'food'
    ? config.safetyBuffer.foodMonths
    : config.safetyBuffer.reserveMonths;
  return Math.ceil(months * monthly);
}

/**
 * TRUE shortage of ONE resource (spec §5): the monthly deficit that
 * production cannot cover MINUS what the stockpile absorbed. Zero while the
 * warehouse covers the gap (a draw-down, not an emergency) — positive when
 * the country actually runs dry (population growth slows, stability drops).
 */
export function shortageOf(
  stockBefore: number,
  production: number,
  consumption: number
): number {
  const gap = consumption - production;
  if (gap <= 0) return 0;
  return Math.max(0, Math.round(gap - Math.max(0, stockBefore)));
}

/** Defaults of the display-status thresholds (mirrors economy.json). */
const DEFAULT_DISPLAY_STATUS = { surplusBufferMonths: 2, minSurplusShare: 0.1 } as const;

/**
 * Derives the clear display status of ONE resource from the REAL numbers —
 * never hand-set, recomputed with every cycle pass:
 *
 *  - SHORTAGE — the stockpile ran dry this month (shortage > 0);
 *  - SURPLUS — production really exceeds consumption by a MEANINGFUL flow
 *    (≥ max(1, minSurplusShare × consumption): a +1/month is NOT a surplus)
 *    AND the country holds enough stock (≥ surplusBufferMonths ×
 *    consumption) — only then is it a real exporter;
 *  - BALANCED — everything else (needs covered, or a trivial net flow).
 */
export function resourceDisplayStatusOf(
  record: CountryResourceState,
  resourceId: string,
  thresholds: { surplusBufferMonths: number; minSurplusShare: number } = DEFAULT_DISPLAY_STATUS
): ResourceDisplayStatus {
  const production = record.production[resourceId] ?? 0;
  const consumption = record.consumption[resourceId] ?? 0;
  const stock = record.stock[resourceId] ?? 0;
  if ((record.shortage[resourceId] ?? 0) > 0) return 'shortage';
  const net = production - consumption;
  const minFlow = Math.max(1, Math.ceil(thresholds.minSurplusShare * consumption));
  const bufferUnits = thresholds.surplusBufferMonths * consumption;
  if (net >= minFlow && stock >= bufferUnits) return 'surplus';
  return 'balanced';
}

/**
 * Legacy status alias (status panel / alerts read this) — the same three
 * honest statuses derived from the same numbers.
 */
export function resourceStatusOf(record: CountryResourceState, resourceId: string): ResourceStatus {
  return resourceDisplayStatusOf(record, resourceId);
}

// ———————————————————————————————— seed pass ————————————————————————————————

/**
 * Seeds the resource records at state creation / after every load: computes
 * production + consumption from the LIVE map and state and fills empty
 * stockpiles from the configured starting buffer. NO stock step, NO trade,
 NO money — the monthly cycle owns all of that (a heal must never
 * double-apply a month).
 */
export function seedResourceEconomies(
  state: GameState,
  mapModel: StrategicMapModel,
  config: StrategicResourcesConfig
): void {
  const countryIds = Object.keys(state.economy.finance);
  const productionCache = new Map<string, Record<string, number>>();
  for (const countryId of countryIds) {
    const deposits = countryResourceProduction(mapModel, countryId, config, productionCache);
    const baseline = countryBaselineProduction(mapModel, countryId, config.domesticBaseline);
    const buildings = buildingProductionOf(state, countryId, config);
    const production: Record<string, number> = { ...deposits };
    for (const source of [baseline, buildings]) {
      for (const [resourceId, amount] of Object.entries(source)) {
        production[resourceId] = Math.round((production[resourceId] ?? 0) + amount);
      }
    }
    const consumption = countryResourceConsumption(state, countryId, config);
    const previous = state.economy.resources[countryId];
    const stock: Record<string, number> = { ...(previous?.stock ?? {}) };
    for (const resourceId of strategicResourceIds(config)) {
      if (stock[resourceId] === undefined) {
        stock[resourceId] = Math.round(config.startingStock[resourceId] ?? 0);
      }
    }
    state.economy.resources[countryId] = {
      stock,
      production,
      consumption,
      imports: {},
      exports: {},
      shortage: {},
      tradeIncome: 0,
      tradeExpense: 0
    };
  }
}
