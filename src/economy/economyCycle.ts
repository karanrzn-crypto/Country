/**
 * THE ECONOMIC CYCLE (spec §12) — one transparent, deterministic pass that
 * advances the WHOLE simple economy by ONE campaign month:
 *
 *   شروع ماه
 *     ↓
 *   ۱. محاسبه جمعیت        — growth slows when the food stockpile ran dry (§5)
 *     ↓
 *   ۲. محاسبه درآمد مالیاتی — جمعیت × نرخ (سطح مالیات) — recorded, not applied
 *     ↓
 *   ۳. تولید منابع          — deposits + specialized baseline + buildings
 *                             (× economy level) → stock += P
 *     ↓
 *   ۴. اجرای قراردادهای تجاری — every ACTIVE trade contract (§6/§24)
 *                             delivers REAL units from the seller's stock
 *                             to the buyer's stock (§9 — honest partial
 *                             deliveries, never faked) + ledger money;
 *                             the records' trade lines restart here (§11 —
 *                             no stale accumulations)
 *     ↓
 *   ۵. مصرف کالاها          — population base for EVERY good (§6) + military
 *                             wear → stock −= C, the ONE honest shortage
 *                             computation of the month:
 *
 *                             shortage = C − P − month-start stock − deliveries
 *
 *                             (§11's formula — domestic production + actual
 *                             imports + existing stock against consumption;
 *                             NOTHING overwrites it afterwards — §19)
 *     ↓
 *   ۶. هزینه ارتش/دولت/زیرساخت — recorded, not applied; the ledger's trade
 *                             line reads THIS month's contract money
 *     ↓
 *   ۷. محاسبه پول نهایی     — treasury += tax + trade − expenses
 *                             (ONE treasury write per country, floored at 0)
 *     ↓
 *   ۸. ثبات و سطح اقتصاد    — graded shortage → satisfaction penalty (§7)
 *                             drops stability; the 0-100 economy level drifts
 *                             toward its target (balance ↑, shortages ↓) —
 *                             next month's building production follows (§3)
 *     ↓
 *   پایان ماه
 *
 * Invariants (spec §13/§14):
 *  - ONE writer: this pass is the only thing that mutates resource records
 *    monthly, the ledger, and (with the construction/military systems) the
 *    stockpile — no parallel systems, no double application;
 *  - the shortage is computed EXACTLY ONCE per month, from THIS month's
 *    real numbers, and is never reset or overwritten afterwards (§11/§19 —
 *    a shortage only ends when the real supply really covers the need);
 *  - trade never touches the treasury directly: contract money lands in
 *    step ۷ through the ledger (one honest تغییر خزانه per month);
 *  - every amount is floored at zero — stock, treasury, shortage;
 *  - `applyStep: false` turns the pass into a pure SEED (state creation and
 *    load heal) that computes production/consumption and fills starting
 *    stockpiles without spending a month.
 *
 * Pure function over GameState — unit-testable without any system harness.
 */

import type { GameState } from '../state/GameState';
import type { StrategicMapModel } from '../world/map/MapTypes';
import type { StrategicResourcesConfig } from './types';
import type { TaxLevel } from '../government/types';
import { TAX_LEVEL_SPECS } from '../government/types';
import {
  strategicResourceIds,
  countryResourceProduction,
  countryResourceConsumption,
  buildingProductionOf,
  spendBuildingReserves,
  specializedBaselineProduction,
  economicBudgetProductionFactor,
  satisfactionPenaltyTotalOf
} from './resources';
import { executeMonthlyContracts } from './contracts';
import { emptyCountryResourceState, emptyCountryFinanceState } from './resourceTypes';
import { roundTo } from '../utils/math';

export interface EconomyCycleOptions {
  /**
   * TRUE on the monthly pass: applies the full cycle (population growth,
   * stock step, trade, treasury). FALSE at state creation / load heal —
   * those only seed the records (a heal must not spend a month).
   */
  readonly applyStep?: boolean;
  /** The absolute campaign month (contract bookkeeping timestamps). */
  readonly month?: number;
}

/** The base tax RATE of each tax level (spec §9 — کم/متوسط/زیاد). */
export function taxRateOf(level: TaxLevel): number {
  return TAX_LEVEL_SPECS[level].rate;
}

/** درآمد مالیاتی یک ماه (spec §2): جمعیت(میلیون) × نرخ × ضریب. */
export function taxIncomeOf(
  population: number,
  level: TaxLevel,
  config: StrategicResourcesConfig
): number {
  const millions = population / 1_000_000;
  return roundTo(millions * taxRateOf(level) * config.finance.taxIncomePerMillionPerRate, 2);
}

/** هزینه ارتش یک ماه (spec §3): سرباز(هزار نفر) × ضریب. */
export function armyExpenseOf(soldiers: number, config: StrategicResourcesConfig): number {
  return roundTo((soldiers / 1_000) * config.finance.armyCostPerThousandSoldiers, 2);
}

/** هزینه دولت یک ماه (spec §3): جمعیت(میلیون) × ضریب. */
export function governmentExpenseOf(population: number, config: StrategicResourcesConfig): number {
  return roundTo((population / 1_000_000) * config.finance.governmentCostPerMillion, 2);
}

/** هزینه زیرساخت یک ماه (spec §3): تعداد نواحی شهری × ضریب. */
export function infrastructureExpenseOf(areaCount: number, config: StrategicResourcesConfig): number {
  return roundTo(areaCount * config.finance.infrastructureCostPerArea, 2);
}

/**
 * Runs ONE campaign month of the economy for EVERY strategic country.
 * Deterministic: iteration follows the map's canonical country order, all
 * tie-breaks fall back to country id. See the module header for the exact
 * step order (spec §10).
 */
export function runEconomyCycle(
  state: GameState,
  mapModel: StrategicMapModel,
  config: StrategicResourcesConfig,
  options: EconomyCycleOptions = {}
): void {
  const applyStep = options.applyStep === true;
  const order = mapModel.countryOrder.filter(
    (countryId) => state.economy.finance[countryId] !== undefined
  );
  const resourceIds = strategicResourceIds(config);

  for (const countryId of order) {
    if (state.economy.resources[countryId] === undefined) {
      state.economy.resources[countryId] = emptyCountryResourceState();
    }
    if (state.economy.finance[countryId] === undefined) {
      state.economy.finance[countryId] = emptyCountryFinanceState();
    }
  }

  // —— ۱. جمعیت (spec §5: کمبود غذا → رشد کمتر) ——
  if (applyStep) {
    for (const countryId of order) {
      const country = state.countries.countries[countryId];
      if (country === undefined) continue;
      const record = state.economy.resources[countryId]!;
      const foodGap = (record.consumption.food ?? 0) - (record.production.food ?? 0);
      const dryFood = foodGap > 0 && (record.stock.food ?? 0) <= 0;
      const factor = dryFood ? 0.25 : 1;
      const growth = country.population * config.finance.populationGrowthPerMonth * factor;
      country.population = Math.max(0, Math.round(country.population + growth));
    }
  }

  // —— ۲. مالیات (spec §2) ——
  for (const countryId of order) {
    const government = state.government.countries[countryId];
    const country = state.countries.countries[countryId];
    if (government === undefined || country === undefined) continue;
    const finance = state.economy.finance[countryId]!;
    finance.lastTaxIncome = applyStep
      ? taxIncomeOf(country.population, government.budget.tax, config)
      : 0;
  }

  // —— ۳. تولید منابع (spec §4) → stock += production ——
  // The MONTH-START stock is captured before the production lands — the
  // shortage check (step ۴) measures the deficit against what the country
  // actually HAD when the month began, never double-counting this month's
  // production. Buildings now produce through QUALITY × POTENTIAL ×
  // DIMINISHING × level × BUDGET (spec §3/§7/§15 + the budget directive
  // §2); extractive buildings pull from their FINITE reserve, which this
  // pass spends (spec §8).
  //
  // THE ECONOMIC BUDGET (the budget directive §2): the ONE shared factor
  // (economicBudgetProductionFactor — 50 neutral, +1 point above 50 lifts,
  // below 50 cuts) scales EVERY production path: the buildings carry it
  // already (singleBuildingOutput), the deposits and the specialized
  // baseline take it here. There is no production route that skips it.
  const productionCache = new Map<string, Record<string, number>>();
  const stockAtMonthStart = new Map<string, Record<string, number>>();
  const extractions = new Map<string, Record<string, number>>();
  for (const countryId of order) {
    const deposits = countryResourceProduction(mapModel, countryId, config, productionCache);
    const record = state.economy.resources[countryId]!;
    const startStock: Record<string, number> = {};
    for (const resourceId of resourceIds) {
      startStock[resourceId] = Math.max(0, Math.round(record.stock[resourceId] ?? 0));
    }
    stockAtMonthStart.set(countryId, startStock);
    const budgetFactor = economicBudgetProductionFactor(state, countryId, config);
    const buildings = buildingProductionOf(state, mapModel, countryId, config);
    record.production = {};
    for (const [resourceId, amount] of Object.entries(deposits)) {
      record.production[resourceId] = Math.round(amount * budgetFactor);
    }
    for (const [resourceId, amount] of Object.entries(buildings.totals)) {
      record.production[resourceId] = Math.round((record.production[resourceId] ?? 0) + amount);
    }
    const baseline = specializedBaselineProduction(mapModel, countryId, config);
    for (const [resourceId, amount] of Object.entries(baseline)) {
      record.production[resourceId] = Math.round((record.production[resourceId] ?? 0) + amount * budgetFactor);
    }
    extractions.set(countryId, buildings.extraction);
    if (applyStep) {
      for (const resourceId of resourceIds) {
        const produced = record.production[resourceId] ?? 0;
        if (produced > 0 || (record.stock[resourceId] ?? 0) > 0) {
          record.stock[resourceId] = Math.max(0, Math.round((record.stock[resourceId] ?? 0) + produced));
        }
      }
    }
  }

  // —— ۴. اجرای قراردادهای تجاری (spec §9/§12) → REAL deliveries ——
  // Contracts signed by presidents (player or AI) deliver REAL units from
  // the seller's stock to the buyer's stock — BEFORE consumption, so the
  // month's imports are part of THIS month's real supply (§15). The
  // execution also restarts the records' trade lines (imports/exports/
  // tradeIncome/tradeExpense): from here they hold EXACTLY this month's
  // contract flows (§11 — no stale accumulations, no hidden imports).
  if (applyStep) {
    executeMonthlyContracts(state, order, config, options.month ?? 0);
  }

  // —— ۵. مصرف کالاها (spec §5/§11/§13/§14) → stock −= consumption + THE shortage ——
  for (const countryId of order) {
    const record = state.economy.resources[countryId]!;
    record.consumption = countryResourceConsumption(state, countryId, config);
    if (applyStep) {
      // The extraction reserves (spec §8) are spent ONCE the production
      // landed — the reserve caps what the building actually pulled out.
      const extraction = extractions.get(countryId);
      if (extraction !== undefined) spendBuildingReserves(state, countryId, extraction);
    }
    if (!applyStep) continue;
    const startStock = stockAtMonthStart.get(countryId)!;
    for (const resourceId of resourceIds) {
      const consumed = record.consumption[resourceId] ?? 0;
      const before = record.stock[resourceId] ?? 0;
      record.stock[resourceId] = Math.max(0, Math.round(before - consumed));
      // THE honest shortage (spec §11's formula, computed EXACTLY ONCE —
      // §19: nothing overwrites it afterwards):
      //
      //   available supply = production + contract deliveries + the
      //                      month-start warehouse buffer
      //   shortage         = consumption − available supply
      //
      // Zero stock NEVER means zero shortage (§13/§14) — a dry warehouse
      // with a hungry population is exactly when the shortage is real.
      const deliveries = record.imports[resourceId] ?? 0;
      const gap =
        consumed -
        (record.production[resourceId] ?? 0) -
        Math.max(0, startStock[resourceId] ?? 0) -
        deliveries;
      const short = Math.max(0, Math.round(gap));
      if (short > 0) {
        record.shortage[resourceId] = short;
        // Duration tracking (§13): consecutive months the country could
        // NOT cover the need itself — escalates the satisfaction penalty.
        record.shortageMonths[resourceId] = Math.min(
          120,
          Math.round((record.shortageMonths[resourceId] ?? 0) + 1)
        );
      } else {
        delete record.shortage[resourceId];
        delete record.shortageMonths[resourceId];
      }
    }
  }

  // —— ۶. هزینه‌ها: ارتش / دولت / زیرساخت (spec §3) ——
  // AFTER the contract step: the ledger's تجارت line reads THIS month's
  // contract money (deliveries − payments), applied to the treasury in
  // step ۷ EXACTLY once.
  for (const countryId of order) {
    const country = state.countries.countries[countryId];
    if (country === undefined) continue;
    const finance = state.economy.finance[countryId]!;
    const soldiers = Math.max(0, country.military.armySize);
    const areas = countCityAreas(state, countryId);
    finance.lastArmyExpense = applyStep ? armyExpenseOf(soldiers, config) : 0;
    finance.lastGovernmentExpense = applyStep ? governmentExpenseOf(country.population, config) : 0;
    finance.lastInfrastructureExpense = applyStep ? infrastructureExpenseOf(areas, config) : 0;
    // تجارت (خالص): فروش‌ها − خریدها — the §12 ledger's single trade line.
    const tradeNet = applyStep
      ? roundTo(
          (state.economy.resources[countryId]?.tradeIncome ?? 0) -
            (state.economy.resources[countryId]?.tradeExpense ?? 0),
          2
        )
      : 0;
    finance.lastTradeIncome = tradeNet;
  }

  // —— ۷. پول نهایی (spec §3): ONE treasury write per country ——
  if (applyStep) {
    for (const countryId of order) {
      const finance = state.economy.finance[countryId]!;
      const treasury = state.economy.treasury[countryId] ?? 0;
      const income = finance.lastTaxIncome + finance.lastTradeIncome;
      const expenses =
        finance.lastArmyExpense + finance.lastGovernmentExpense + finance.lastInfrastructureExpense;
      const balance = roundTo(income - expenses, 2);
      state.economy.treasury[countryId] = Math.max(0, roundTo(treasury + balance, 4));
      finance.lastBalance = balance;
    }
  }

  // —— ۸. ثبات و سطح اقتصاد (spec §7/§3) ——
  if (applyStep) {
    for (const countryId of order) {
      // (a) the GRADED satisfaction penalty (spec §7): coverage per good
      //     (production + imports vs consumption) → a piecewise penalty —
      //     100% none · 90% tiny · 70% moderate · 40% severe. Stability
      //     takes the stabilityFactor share while the shortage lasts.
      const political = state.political.countries[countryId];
      const penalty = satisfactionPenaltyTotalOf(state, countryId, config);
      if (political !== undefined) {
        if (penalty > 0) {
          political.stability = Math.max(0, political.stability - penalty * config.satisfaction.stabilityFactor);
        } else {
          political.stability = Math.min(1, political.stability + 0.002);
        }
      }
      // (b) the ECONOMY LEVEL (spec §3): drifts GRADUALLY toward a target
      //     derived from the real month — positive balance lifts it, every
      //     uncovered shortage drags it down. Next month's buildings read it.
      const target = economyLevelTargetOf(state, countryId, config);
      const current = state.economy.economyLevel[countryId] ?? config.economyLevel.start;
      const step = Math.max(
        -config.economyLevel.maxStepPerMonth,
        Math.min(config.economyLevel.maxStepPerMonth, target - current)
      );
      state.economy.economyLevel[countryId] = Math.min(100, Math.max(0, roundTo(current + step, 2)));
    }
  }
}

/**
 * The ECONOMY-LEVEL target of ONE country this month (spec §3): 50 by
 * default, lifted by the monthly balance (capped) and dragged down by every
 * resource the country could not cover (post-trade). Config-driven — the
 * drift toward it is capped at maxStepPerMonth so the level moves gradually.
 */
export function economyLevelTargetOf(
  state: GameState,
  countryId: string,
  config: StrategicResourcesConfig
): number {
  const spec = config.economyLevel;
  const balance = state.economy.finance[countryId]?.lastBalance ?? 0;
  const balanceTerm = Math.max(
    -spec.balanceCap,
    Math.min(spec.balanceCap, balance * spec.balanceFactor)
  );
  const uncovered = strategicResourceIds(config).filter(
    (resourceId) => (state.economy.resources[countryId]?.shortage[resourceId] ?? 0) > 0
  ).length;
  const target = spec.targetBase + balanceTerm - uncovered * spec.shortagePenalty;
  return Math.min(100, Math.max(0, target));
}

/** City-area count of ONE country (the infrastructure expense base). */
function countCityAreas(state: GameState, countryId: string): number {
  let count = 0;
  for (const area of Object.values(state.cityAreas.network.areas)) {
    if (area.countryId === countryId) count += 1;
  }
  return count;
}
