/**
 * THE ECONOMIC CYCLE (spec §10) — one transparent, deterministic pass that
 * advances the WHOLE simple economy by ONE campaign month:
 *
 *   شروع ماه
 *     ↓
 *   ۱. محاسبه جمعیت        — growth slows when the food stockpile ran dry (§5)
 *     ↓
 *   ۲. محاسبه درآمد مالیاتی — جمعیت × نرخ (سطح مالیات) — recorded, not applied
 *     ↓
 *   ۳. تولید منابع          — deposits + baseline + buildings → stock += P
 *     ↓
 *   ۴. مصرف غذا             — population food + military wear → stock −= C
 *     ↓
 *   ۵. هزینه ارتش/دولت/زیرساخت — recorded, not applied
 *     ↓
 *   ۶. تجارت               — world trade: shortage countries buy from
 *                             surplus countries at the BASE price (§6/§7);
 *                             units AND ledger lines move, treasury not yet
 *     ↓
 *   ۷. محاسبه پول نهایی     — treasury += tax + trade + factories − expenses
 *                             (ONE treasury write per country, floored at 0)
 *     ↓
 *   ۸. ثبات و توسعه         — food shortage drops stability; opinion and
 *                             development read the same shortage numbers
 *     ↓
 *   پایان ماه
 *
 * Invariants (spec §13/§14):
 *  - ONE writer: this pass is the only thing that mutates resource records
 *    monthly, the ledger, and (with the construction/military systems) the
 *    stockpile — no parallel systems, no double application;
 *  - trade never touches the treasury directly: the money lands in step ۷
 *    through the ledger (one honest تغییر خزانه per month);
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
  buildingIncomeOf,
  safetyReserveUnits
} from './resources';
import { countryBaselineProduction } from './domesticBaseline';
import { emptyCountryResourceState, emptyCountryFinanceState } from './resourceTypes';
import { roundTo } from '../utils/math';

export interface EconomyCycleOptions {
  /**
   * TRUE on the monthly pass: applies the full cycle (population growth,
   * stock step, trade, treasury). FALSE at state creation / load heal —
   * those only seed the records (a heal must not spend a month).
   */
  readonly applyStep?: boolean;
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
  // production.
  const productionCache = new Map<string, Record<string, number>>();
  const stockAtMonthStart = new Map<string, Record<string, number>>();
  for (const countryId of order) {
    const deposits = countryResourceProduction(mapModel, countryId, config, productionCache);
    const record = state.economy.resources[countryId]!;
    const startStock: Record<string, number> = {};
    for (const resourceId of resourceIds) {
      startStock[resourceId] = Math.max(0, Math.round(record.stock[resourceId] ?? 0));
    }
    stockAtMonthStart.set(countryId, startStock);
    record.production = { ...deposits };
    for (const [resourceId, amount] of Object.entries(buildingProductionOf(state, countryId, config))) {
      record.production[resourceId] = Math.round((record.production[resourceId] ?? 0) + amount);
    }
    const baseline = countryBaselineProduction(mapModel, countryId, config.domesticBaseline);
    for (const [resourceId, amount] of Object.entries(baseline)) {
      record.production[resourceId] = Math.round((record.production[resourceId] ?? 0) + amount);
    }
    if (applyStep) {
      for (const resourceId of resourceIds) {
        const produced = record.production[resourceId] ?? 0;
        if (produced > 0 || (record.stock[resourceId] ?? 0) > 0) {
          record.stock[resourceId] = Math.max(0, Math.round((record.stock[resourceId] ?? 0) + produced));
        }
      }
    }
  }

  // —— ۴. مصرف غذا (spec §5) → stock −= consumption + shortage detection ——
  for (const countryId of order) {
    const record = state.economy.resources[countryId]!;
    record.consumption = countryResourceConsumption(state, countryId, config);
    if (!applyStep) continue;
    const startStock = stockAtMonthStart.get(countryId)!;
    for (const resourceId of resourceIds) {
      const consumed = record.consumption[resourceId] ?? 0;
      const before = record.stock[resourceId] ?? 0;
      record.stock[resourceId] = Math.max(0, Math.round(before - consumed));
      // Honest shortage (§5): consumption − production − the warehouse's
      // month-start buffer. Positive = the country ran DRY this month.
      const gap = consumed - (record.production[resourceId] ?? 0) - Math.max(0, startStock[resourceId] ?? 0);
      const short = Math.max(0, Math.round(gap));
      if (short > 0) record.shortage[resourceId] = short;
      else delete record.shortage[resourceId];
    }
  }

  // —— ۵. هزینه‌ها: ارتش / دولت / زیرساخت (spec §3) ——
  for (const countryId of order) {
    const country = state.countries.countries[countryId];
    if (country === undefined) continue;
    const finance = state.economy.finance[countryId]!;
    const soldiers = Math.max(0, country.military.armySize);
    const areas = countCityAreas(state, countryId);
    finance.lastArmyExpense = applyStep ? armyExpenseOf(soldiers, config) : 0;
    finance.lastGovernmentExpense = applyStep ? governmentExpenseOf(country.population, config) : 0;
    finance.lastInfrastructureExpense = applyStep ? infrastructureExpenseOf(areas, config) : 0;
    finance.lastFactoryIncome = applyStep ? buildingIncomeOf(state, countryId, config) : 0;
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

  // —— ۶. تجارت (spec §6/§7): shortage buys from surplus at the BASE price ——
  if (applyStep) {
    resolveWorldTrade(state, order, resourceIds, config);
  }

  // —— ۷. پول نهایی (spec §3): ONE treasury write per country ——
  if (applyStep) {
    for (const countryId of order) {
      const finance = state.economy.finance[countryId]!;
      const treasury = state.economy.treasury[countryId] ?? 0;
      const income =
        finance.lastTaxIncome + finance.lastTradeIncome + finance.lastFactoryIncome;
      const expenses =
        finance.lastArmyExpense + finance.lastGovernmentExpense + finance.lastInfrastructureExpense;
      const balance = roundTo(income - expenses, 2);
      state.economy.treasury[countryId] = Math.max(0, roundTo(treasury + balance, 4));
      finance.lastBalance = balance;
    }
  }

  // —— ۸. ثبات (spec §5: کمبود غذا → کاهش ثبات) ——
  if (applyStep) {
    for (const countryId of order) {
      const record = state.economy.resources[countryId]!;
      const political = state.political.countries[countryId];
      if (political === undefined) continue;
      const shortageMonths = Object.values(record.shortage).reduce((sum, value) => sum + (value > 0 ? 1 : 0), 0);
      if (shortageMonths > 0) {
        political.stability = Math.max(0, political.stability - 0.01 * shortageMonths);
      } else {
        political.stability = Math.min(1, political.stability + 0.002);
      }
    }
  }
}

/**
 * THE WORLD TRADE (spec §6/§7) — the ONE trade path of the simple economy.
 * Every shortage country tries to buy its deficit from surplus countries at
 * the resource's BASE price; real units and real ledger money move together.
 *
 * Timing: this pass FIRST resets the records' tradeIncome/tradeExpense —
 * so a record always holds THIS month's trade money. The LEDGER line
 * (finance.lastTradeIncome) is written in step ۵ from the PREVIOUS pass's
 * accumulation (plus any manual deals the player made since), and step ۷
 * applies THAT number to the treasury — trade money is applied exactly
 * once, one month later, never double-counted.
 *
 * Deterministic: most urgent buyer first (largest deficit, tie → country
 * id), largest seller stock first (tie → country id). A buyer with no money
 * simply buys nothing (no debt exists). Sellers never dip below their
 * safety reserve (food keeps the larger buffer — §5's anti-famine guard).
 */
export function resolveWorldTrade(
  state: GameState,
  order: readonly string[],
  resourceIds: readonly string[],
  config: StrategicResourcesConfig
): void {
  for (const countryId of order) {
    const record = state.economy.resources[countryId];
    if (record !== undefined) {
      record.tradeIncome = 0;
      record.tradeExpense = 0;
      record.imports = {};
      record.exports = {};
    }
  }
  for (const resourceId of resourceIds) {
    const price = config.resources.find((resource) => resource.id === resourceId)?.price ?? 0;
    if (price <= 0) continue;

    // Buyers: uncovered consumption this month (shortage), most urgent first.
    const buyers = order
      .map((countryId) => ({
        countryId,
        needed: state.economy.resources[countryId]?.shortage[resourceId] ?? 0
      }))
      .filter((entry) => entry.needed > 0)
      .sort((a, b) => b.needed - a.needed || (a.countryId < b.countryId ? -1 : 1));

    // Sellers: real free stock above the safety reserve, largest first.
    const sellers = order
      .map((countryId) => {
        const record = state.economy.resources[countryId]!;
        const reserve = safetyReserveUnits(record.consumption, resourceId, config);
        return {
          countryId,
          spare: Math.floor((record.stock[resourceId] ?? 0) - reserve)
        };
      })
      .filter((entry) => entry.spare > 0)
      .sort((a, b) => b.spare - a.spare || (a.countryId < b.countryId ? -1 : 1));

    for (const buyer of buyers) {
      let needed = buyer.needed;
      for (const seller of sellers) {
        if (needed <= 0) break;
        if (seller.countryId === buyer.countryId) continue;
        const sellerRecord = state.economy.resources[seller.countryId]!;
        const buyerRecord = state.economy.resources[buyer.countryId]!;
        // The seller's spare shrinks as the resource trades this month.
        const spare = Math.floor(
          (sellerRecord.stock[resourceId] ?? 0) -
            safetyReserveUnits(sellerRecord.consumption, resourceId, config)
        );
        if (spare <= 0) continue;
        const affordable =
          price > 0 ? Math.floor((state.economy.treasury[buyer.countryId] ?? 0) / price) : needed;
        const amount = Math.max(0, Math.min(needed, spare, affordable));
        if (amount <= 0) continue;

        const cost = roundTo(amount * price, 2);
        // REAL units move: seller −, buyer +.
        sellerRecord.stock[resourceId] = (sellerRecord.stock[resourceId] ?? 0) - amount;
        buyerRecord.stock[resourceId] = Math.round((buyerRecord.stock[resourceId] ?? 0) + amount);
        // Ledger lines (treasury is written ONCE in step ۷ — never here).
        buyerRecord.imports[resourceId] = Math.round((buyerRecord.imports[resourceId] ?? 0) + amount);
        sellerRecord.exports[resourceId] = Math.round((sellerRecord.exports[resourceId] ?? 0) + amount);
        buyerRecord.tradeExpense = roundTo(buyerRecord.tradeExpense + cost, 2);
        sellerRecord.tradeIncome = roundTo(sellerRecord.tradeIncome + cost, 2);
        seller.spare -= amount;
        needed -= amount;
      }
    }
  }
}

/** City-area count of ONE country (the infrastructure expense base). */
function countCityAreas(state: GameState, countryId: string): number {
  let count = 0;
  for (const area of Object.values(state.cityAreas.network.areas)) {
    if (area.countryId === countryId) count += 1;
  }
  return count;
}
