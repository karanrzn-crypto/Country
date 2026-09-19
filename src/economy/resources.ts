/**
 * The SIMPLE resource economy — production, consumption, statuses (spec §1-§8).
 *
 * THE causal chain (spec §9's cycle — implemented in economyCycle.ts):
 *
 *   Deposits (geography) + Specialized baseline + Buildings (× economy
 *   level)                                                   ← PRODUCTION
 *     ↓
 *   Consumption  (population per good · military wear)
 *     ↓
 *   STOCK STEP  (stock += production − consumption, floored at 0)
 *     ↓
 *   World Trade (shortage buys from surplus at the BASE price — one seller
 *   serves MANY buyers)
 *     ↓
 *   Coverage = (production + imports + stock) / consumption → shortage
 *     ↓
 *   Graded satisfaction penalty (§7) → opinion + stability
 *
 * This module holds the PURE helpers: production/consumption math, the
 * country SPECIALIZATION ranking (§4), the economy-level building modifier
 * (§3), the safety reserve, the honest shortage, the graded satisfaction
 * penalty (§7) and the SEED pass. The monthly cycle itself lives in
 * economyCycle.ts — the ONE writer of the live records.
 *
 * LEAF-friendly: depends only on state/map TYPES + utils. No renderer, no UI.
 */

import type { GameState } from '../state/GameState';
import type { StrategicMapModel, MapResourceDeposit } from '../world/map/MapTypes';
import type { StrategicResourcesConfig, SatisfactionConfig } from './types';
import { liveUnits } from '../state/slices/militarySlice';
import { type CountryResourceState, type ResourceDisplayStatus, type ResourceStatus } from './resourceTypes';
import { countryBaselineProduction } from './domesticBaseline';
import { findGridCell } from '../world/map/MapGeography';
import {
  cellQualityOf,
  countryPotentialFactor,
  diminishingFactorOf,
  qualityLabelOf,
  reserveCapacityOf,
  specializationRankingOf,
  estimatedBuildingOutputOf
} from './quality';
import { roundTo } from '../utils/math';

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

// ———————————————————————— buildings (spec §1/§3) ————————————————————————

/**
 * The ECONOMY LEVEL of ONE country (spec §3): a 0..100 scale for the overall
 * state of the economy. Reads the live state; countries without a record
 * (fresh/hand-made saves before the heal) sit at the neutral config start.
 */
export function economyLevelOf(
  state: GameState,
  countryId: string,
  config: StrategicResourcesConfig
): number {
  const level = state.economy.economyLevel[countryId];
  return typeof level === 'number' && Number.isFinite(level)
    ? Math.min(100, Math.max(0, level))
    : config.economyLevel.start;
}

/**
 * The BUILDING production modifier of ONE country (spec §3): the economy
 * level scales building output LINEARLY around the neutral 50 —
 * (level − 50) × buildingBonusPerPoint. Level 70 → +12%, level 35 → −9%.
 * Deliberately gradual: a few points of level never multiply the output.
 */
export function economyLevelBuildingFactor(
  state: GameState,
  countryId: string,
  config: StrategicResourcesConfig
): number {
  const delta = economyLevelOf(state, countryId, config) - 50;
  return 1 + delta * config.economyLevel.buildingBonusPerPoint;
}

/**
 * THE ECONOMIC-BUDGET PRODUCTION MODIFIER of ONE country (the budget
 * directive §2) — the ONE shared production factor every path reads:
 *
 *     factor = 1 + (budgetPct − 50) × economicBudget.productionPerPoint
 *
 * The economic budget (the 0..100 percentage of the 100% pool, stored as
 * the 0..1 `shares.economic` in TEN-point steps) is NEUTRAL at exactly 50:
 * above 50 the factor lifts ALL domestic production, below 50 it cuts it
 * (60 → ×1.06, 40 → ×0.94, 100 → ×1.30, 0 → ×0.70 with 0.006/point).
 * Deliberately moderate: a one-step change (10 points = ±6%) is felt over
 * the following months without exploding the economy. A country with no
 * government record (fresh/hand-made saves before the heal) reads the
 * neutral 50.
 */
export function economicBudgetProductionFactor(
  state: GameState,
  countryId: string,
  config: StrategicResourcesConfig
): number {
  const share = state.government.countries[countryId]?.budget.shares.economic;
  const budgetPct =
    typeof share === 'number' && Number.isFinite(share)
      ? Math.min(100, Math.max(0, share * 100))
      : 50;
  const perPoint = config.economicBudget?.productionPerPoint ?? 0;
  return roundTo(1 + (budgetPct - 50) * perPoint, 6);
}

/**
 * The BUILDING production breakdown of ONE country (spec §1/§3/§7/§8/§15):
 * every completed building's output scales by its CELL QUALITY, the
 * country's resource POTENTIAL, the economy level (deliberately weak, §14)
 * and the country's DIMINISHING RETURNS per type — and an extractive
 * building (oil, iron) can never produce more than the reserve it still
 * holds.
 *
 * PURE: the reserve is READ here, never spent — the monthly cycle owns the
 * depletion (`extraction` tells it exactly how many units each extractive
 * building pulled out this month).
 */
export interface BuildingOutputBreakdown {
  /** Resource totals (the record.production merge). */
  readonly totals: Record<string, number>;
  /** buildingId → units ACTUALLY extracted this month (oil/iron only). */
  readonly extraction: Record<string, number>;
}

export function buildingProductionOf(
  state: GameState,
  model: StrategicMapModel,
  countryId: string,
  config: StrategicResourcesConfig
): BuildingOutputBreakdown {
  const totals: Record<string, number> = {};
  const extraction: Record<string, number> = {};
  const buildings = state.economy.buildings[countryId];
  if (buildings === undefined) return { totals, extraction };
  // Diminishing ranks buildings of ONE type by id (deterministic across
  // save/load — JSON object order is preserved, but sorting is safer).
  const idsByType = new Map<string, string[]>();
  for (const buildingId of Object.keys(buildings).sort()) {
    const typeId = buildings[buildingId].typeId;
    const list = idsByType.get(typeId);
    if (list !== undefined) list.push(buildingId);
    else idsByType.set(typeId, [buildingId]);
  }
  for (const [typeId, buildingIds] of idsByType) {
    void typeId;
    buildingIds.forEach((buildingId, index) => {
      const one = singleBuildingOutput(state, model, countryId, config, buildings[buildingId], index);
      if (one.amount > 0) addToRecord(totals, one.resource, one.amount);
      if (one.extraction > 0) extraction[buildingId] = one.extraction;
    });
  }
  return { totals, extraction };
}

/** The monthly output of ONE building — its cell's quality × the country's
 *  potential × the economy level × THE ECONOMIC BUDGET × diminishing
 *  returns, capped by the remaining extraction reserve (the budget
 *  directive §2 + spec §3/§7/§8/§15). */
export interface SingleBuildingOutput {
  readonly resource: string;
  readonly amount: number;
  /** The units this building ACTUALLY pulled from its reserve (0 for
   *  inexhaustible types — the caller spends the reserve from this). */
  readonly extraction: number;
}

/** The 0-based DIMINISHING index of ONE building inside its type stack. */
export function buildingIndexOfType(
  state: GameState,
  countryId: string,
  buildingId: string
): number {
  const buildings = state.economy.buildings[countryId];
  if (buildings === undefined) return 0;
  const typeId = buildings[buildingId]?.typeId;
  if (typeId === undefined) return 0;
  const ids = Object.keys(buildings).filter((id) => buildings[id].typeId === typeId).sort();
  return Math.max(0, ids.indexOf(buildingId));
}

/** The monthly output of ONE building record (see SingleBuildingOutput). */
export function singleBuildingOutput(
  state: GameState,
  model: StrategicMapModel,
  countryId: string,
  config: StrategicResourcesConfig,
  building: { readonly typeId: string; readonly cellKey: string; readonly reserveRemaining?: number },
  index: number
): SingleBuildingOutput {
  const def = config.buildings.find((candidate) => candidate.id === building.typeId);
  if (def === undefined) return { resource: 'food', amount: 0, extraction: 0 };
  const cellIndex = findGridCell(model, building.cellKey);
  const quality = cellQualityOf(model, cellIndex, def.resource, config);
  const potential = countryPotentialFactor(model, countryId, def.resource, config);
  const levelFactor = economyLevelBuildingFactor(state, countryId, config);
  // THE ECONOMIC BUDGET (the budget directive §2): the ONE shared factor
  // applies to buildings exactly as it applies to deposits and the
  // baseline — before the reserve cap, so the extraction (the units the
  // reserve really loses) matches the budget-scaled output.
  const budgetFactor = economicBudgetProductionFactor(state, countryId, config);
  const diminish = diminishingFactorOf(index, config);
  let amount = Math.max(
    0,
    Math.round(def.output * quality * potential * levelFactor * budgetFactor * diminish)
  );
  let extraction = 0;
  // Finite reserve (spec §8): extraction is capped by what is LEFT.
  if (def.reserveUnits > 0) {
    const remaining = building.reserveRemaining ?? def.reserveUnits;
    amount = Math.min(amount, Math.max(0, Math.floor(remaining)));
    extraction = Math.max(0, amount);
  }
  return { resource: def.resource, amount, extraction };
}

/**
 * Spends the reserve of ONE country's extractive buildings (spec §8) —
 * called by the monthly cycle AFTER the production landed on the stock.
 * A building whose reserve reached zero simply produces nothing next month
 * (the region is exhausted; the building stands but is silent).
 */
export function spendBuildingReserves(
  state: GameState,
  countryId: string,
  extraction: Readonly<Record<string, number>>
): void {
  const buildings = state.economy.buildings[countryId];
  if (buildings === undefined) return;
  for (const [buildingId, amount] of Object.entries(extraction)) {
    const building = buildings[buildingId];
    if (building === undefined || building.reserveRemaining === undefined) continue;
    building.reserveRemaining = Math.max(0, Math.round(building.reserveRemaining - amount));
  }
}

/** The build PREVIEW of ONE cell (spec §3/§21) — what the UI shows BEFORE
 *  the player confirms a construction: land quality, base vs estimated
 *  output, and the extractive reserve the region would start with. */
export interface BuildPreviewInfo {
  readonly cellKey: string;
  readonly gridId: string;
  readonly quality: number;
  readonly qualityLabel: string;
  /** The building's config output (قبل از کیفیت/پتانسیل). */
  readonly baseOutput: number;
  /** The estimated REAL monthly output on this cell. */
  readonly estimatedOutput: number;
  /** The extraction reserve this cell would hold (0 = inexhaustible). */
  readonly reserveUnits: number;
}

/**
 * Computes the preview of building `typeId` on `cellKey` (pure — reads the
 * live state only for the economy level and the diminishing index). Null
 * for an unknown type or a cell that is not real land.
 */
export function buildPreviewInfoOf(
  state: GameState,
  model: StrategicMapModel,
  countryId: string,
  config: StrategicResourcesConfig,
  typeId: string,
  cellKey: string
): BuildPreviewInfo | null {
  const def = config.buildings.find((candidate) => candidate.id === typeId);
  if (def === undefined) return null;
  const cellIndex = findGridCell(model, cellKey);
  if (cellIndex < 0) return null;
  const gridId = model.features.gridIds[cellIndex] ?? '';
  const quality = cellQualityOf(model, cellIndex, def.resource, config);
  const potential = countryPotentialFactor(model, countryId, def.resource, config);
  // The preview shows the REAL monthly output under the CURRENT budget
  // (the budget directive §2) — the same combined factor the cycle's
  // buildings use (level × budget), so what the player sees is what the
  // completed building will actually produce.
  const combinedFactor =
    economyLevelBuildingFactor(state, countryId, config) *
    economicBudgetProductionFactor(state, countryId, config);
  const existing = Object.values(state.economy.buildings[countryId] ?? {}).filter(
    (building) => building.typeId === typeId
  ).length;
  const estimatedOutput = estimatedBuildingOutputOf(
    def,
    quality,
    potential,
    combinedFactor,
    existing,
    config
  );
  const reserveUnits =
    def.reserveUnits > 0 ? reserveCapacityOf(def, quality, config) : 0;
  return {
    cellKey,
    gridId,
    quality,
    qualityLabel: qualityLabelOf(quality, config),
    baseOutput: def.output,
    estimatedOutput,
    reserveUnits
  };
}

/**
 * The economic building standing on ONE grid cell (spec §1/§2 — one per
 * region): reads the LIVE state (the single source); the UI renders this
 * verbatim. Covers every country so foreign cells report their owner's
 * building too.
 */
export function economicBuildingAtCell(
  state: GameState,
  cellKey: string
): { countryId: string; buildingId: string; typeId: string } | null {
  for (const [countryId, buildings] of Object.entries(state.economy.buildings)) {
    for (const [buildingId, building] of Object.entries(buildings)) {
      if (building.cellKey === cellKey) {
        return { countryId, buildingId, typeId: building.typeId };
      }
    }
  }
  return null;
}

/** TRUE when a construction project already occupies the cell. */
export function cellIsUnderConstruction(state: GameState, cellKey: string): boolean {
  return cellUnderConstruction(state, cellKey) !== null;
}

/**
 * The construction project standing on ONE grid cell (spec §1/§2 — one per
 * region): reads the LIVE state (the single source); the grid panel renders
 * «در حال ساخت · باقی‌مانده: X ماه» from it. Covers every country so foreign
 * cells report their owner's project too.
 */
export function cellUnderConstruction(
  state: GameState,
  cellKey: string
): { countryId: string; typeId: string; progress: number } | null {
  for (const [countryId, construction] of Object.entries(state.economy.construction)) {
    for (const project of construction.projects) {
      if (project.cellKey === cellKey) {
        return { countryId, typeId: project.typeId, progress: project.progress };
      }
    }
  }
  return null;
}

/**
 * The ECONOMY-MAP tint resolution of ONE cell (spec §3): WHAT the economy
 * layer paints there — the building type + whether it is still under
 * construction (the renderer derives the color/pale variant from it). ONE
 * definition shared by the fill layer AND the legend, so map and legend can
 * never disagree. Null = no economic building (the cell keeps its land look).
 */
export function cellEconomyTintOf(
  state: GameState,
  cellKey: string
): { typeId: string; underConstruction: boolean } | null {
  const active = economicBuildingAtCell(state, cellKey);
  if (active !== null) return { typeId: active.typeId, underConstruction: false };
  const building = cellUnderConstruction(state, cellKey);
  if (building !== null) return { typeId: building.typeId, underConstruction: true };
  return null;
}

// ———————————————————————— consumption: population × military ————————————————

/**
 * Monthly consumption of ONE country, derived from LIVE state (spec §6 —
 * every unit has a clear reason and NO country with population consumes
 * zero):
 *  - EVERY good carries a population base (perMillionPopulation) — food,
 *    iron, oil and industrial goods all scale with the people, so a
 *    populated country never records a bogus zero consumption;
 *  - military units add fuel and equipment wear (perMilitaryUnit).
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

// ————————————————————— specialization (spec §4) ——————————————————————

/**
 * The SPECIALIZED domestic baseline of ONE country (spec §4): the raw
 * geography baseline, re-ranked against the country's OWN production
 * vector — its strongest good is amplified, the second strengthened, the
 * weakest reduced. Every country keeps a positive output of every good
 * (specialization ≠ inability); the differences between countries drive
 * REAL world trade. Deterministic: ties resolve by config resource order.
 */
export function specializedBaselineProduction(
  model: StrategicMapModel,
  countryId: string,
  config: StrategicResourcesConfig
): Record<string, number> {
  const raw = countryBaselineProduction(model, countryId, config.domesticBaseline);
  const ranked = config.resources
    .map((resource, index) => ({ id: resource.id, index, amount: raw[resource.id] ?? 0 }))
    .sort((a, b) => b.amount - a.amount || a.index - b.index);
  const result: Record<string, number> = {};
  for (let rank = 0; rank < ranked.length; rank += 1) {
    const entry = ranked[rank];
    let multiplier = 1;
    if (entry.amount > 0) {
      if (rank === 0) multiplier = 1 + config.specialization.boostBest;
      else if (rank === 1) multiplier = 1 + config.specialization.boostSecond;
      else if (rank === ranked.length - 1) multiplier = 1 - config.specialization.reduceWeakest;
    }
    const amount = roundTo(entry.amount * multiplier, 2);
    if (amount > 0) result[entry.id] = amount;
  }
  return result;
}

// ——————————————— coverage · satisfaction (spec §7/§8) ———————————————

/**
 * The supply COVERAGE of ONE resource (spec §8): (تولید داخلی + واردات +
 * انبار) against مصرف — what the people actually GOT divided by what they
 * needed. The record's `shortage` holds the POST-TRADE uncovered deficit
 * (imports already subtracted by the cycle's trade step), so coverage reads
 * one honest number: 1 = fully supplied, 0.7 = 30% of the need unmet.
 * Zero consumption (a good the country genuinely does not use) is covered
 * by definition.
 */
export function coverageOf(record: CountryResourceState, resourceId: string): number {
  const consumption = record.consumption[resourceId] ?? 0;
  if (consumption <= 0) return 1;
  const uncovered = Math.max(0, record.shortage[resourceId] ?? 0);
  return Math.min(1, Math.max(0, 1 - uncovered / consumption));
}

/**
 * The graded SATISFACTION penalty of ONE coverage ratio (spec §7's exact
 * scale): piecewise-linear between the config breakpoints —
 *   100% → none · 90% → very small · 70% → moderate · 40% → severe,
 * clamped at maxPenalty below the last breakpoint. A small shortage never
 * collapses satisfaction (spec §7 — متعادل).
 */
export function satisfactionPenaltyOf(coverage: number, config: SatisfactionConfig): number {
  const points = [...config.breakpoints].sort((a, b) => b.coverage - a.coverage);
  if (points.length === 0) return 0;
  if (coverage >= points[0].coverage) return points[0].penalty;
  for (let i = 0; i < points.length - 1; i += 1) {
    const high = points[i];
    const low = points[i + 1];
    if (coverage >= low.coverage) {
      const span = high.coverage - low.coverage;
      const t = span > 0 ? (coverage - low.coverage) / span : 1;
      return roundTo(low.penalty + (high.penalty - low.penalty) * t, 4);
    }
  }
  // Below the last breakpoint: extrapolate with the same slope, then clamp.
  const last = points[points.length - 1];
  const previous = points[points.length - 2] ?? { coverage: 1, penalty: 0 };
  const slope =
    previous.coverage !== last.coverage
      ? (previous.penalty - last.penalty) / (previous.coverage - last.coverage)
      : 0;
  return Math.min(config.maxPenalty, roundTo(last.penalty + (coverage - last.coverage) * slope, 4));
}

/**
 * The TOTAL satisfaction penalty of ONE country this month (spec §7/§13):
 * the sum of the graded penalties over ALL goods, each ESCALATED by how
 * many consecutive months that shortage has lasted (a long shortage bites
 * harder; one bad month never collapses satisfaction). The ONE number the
 * opinion economy topic, the stability drop and the UI read. Zero when
 * fully supplied.
 */
export function satisfactionPenaltyTotalOf(
  state: GameState,
  countryId: string,
  config: StrategicResourcesConfig
): number {
  const record = state.economy.resources[countryId];
  if (record === undefined) return 0;
  const { perMonth, maxMultiplier } = config.satisfaction.durationEscalation;
  let total = 0;
  for (const resource of config.resources) {
    const months = Math.max(0, Math.round(record.shortageMonths[resource.id] ?? 0));
    const factor = Math.min(maxMultiplier, 1 + perMonth * Math.max(0, months - 1));
    total += satisfactionPenaltyOf(coverageOf(record, resource.id), config.satisfaction) * factor;
  }
  return roundTo(total, 4);
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
 * stockpiles with the country's LIMITED starting buffer (spec §1/§10 —
 * a few MONTHS of its own consumption per good, flavored by its economic
 * profile: a food-rich country holds relatively more food). NO stock step,
 * NO trade, NO money — the monthly cycle owns all of that (a heal must
 * never double-apply a month).
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
    const baseline = specializedBaselineProduction(mapModel, countryId, config);
    const buildings = buildingProductionOf(state, mapModel, countryId, config);
    // The seed reads the SAME economic-budget factor the monthly cycle
    // applies (the budget directive §2) — the records are consistent from
    // the first day (the government slice already exists at seed time).
    const budgetFactor = economicBudgetProductionFactor(state, countryId, config);
    const production: Record<string, number> = {};
    for (const [resourceId, amount] of Object.entries(deposits)) {
      production[resourceId] = Math.round(amount * budgetFactor);
    }
    for (const source of [baseline, buildings.totals]) {
      for (const [resourceId, amount] of Object.entries(source)) {
        production[resourceId] = Math.round((production[resourceId] ?? 0) + amount * budgetFactor);
      }
    }
    const consumption = countryResourceConsumption(state, countryId, config);
    const previous = state.economy.resources[countryId];
    const stock: Record<string, number> = { ...(previous?.stock ?? {}) };
    // LIMITED starting buffer (spec §1/§10): months of the country's OWN
    // consumption × its economic profile flavor, floored for tiny countries.
    const ranks = specializationRankingOf(mapModel, countryId, config);
    const flavorTable = config.startingStock.flavorByRank;
    for (const resourceId of strategicResourceIds(config)) {
      if (stock[resourceId] !== undefined) continue;
      const months = config.startingStock.months[resourceId] ?? 2;
      const floor = config.startingStock.floor[resourceId] ?? 0;
      const rank = ranks[resourceId] ?? config.resources.length - 1;
      const flavor = flavorTable[Math.min(rank, flavorTable.length - 1)] ?? 1;
      const buffer = months * (consumption[resourceId] ?? 0) * flavor;
      stock[resourceId] = Math.round(Math.max(floor, buffer));
    }
    state.economy.resources[countryId] = {
      stock,
      production,
      consumption,
      imports: {},
      exports: {},
      shortage: {},
      shortageMonths: { ...(previous?.shortageMonths ?? {}) },
      tradeIncome: 0,
      tradeExpense: 0
    };
  }
}
