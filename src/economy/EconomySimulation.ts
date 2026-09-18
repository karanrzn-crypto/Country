/**
 * Monthly government finance (Phase 2, spec §10 — deliberately LIGHT).
 *
 * Pure functions over GameState. Runs once per campaign month per strategic
 * country (invoked by the GovernmentSystem's monthly catch-up, AFTER the
 * global trade pass has resolved the month's flows and applied the stock
 * step). The ledger has exactly THREE revenue lines:
 *
 *   Tax      — the ONE tax level's rate × the country's monthly output value
 *   Customs  — a fraction of the month's trade value (imports + exports)
 *   Exports  — the resource sale receipts themselves
 *
 * against ONE spending line: the derived budget pot (the 100% pool money).
 * The balance lands on the treasury. NO GDP, NO debt, NO interest, NO
 * inflation, NO sectors — money exists to back deals and government costs.
 *
 * The tax level's ECONOMIC side is real too: each month the level's
 * economyGrowth buff/penalty compounds into `outputGrowth`, which the
 * recompute pass applies to the country's baseline + factory production
 * (LOW grows the economy, MAX shrinks it).
 */

import type { GameState } from '../state/GameState';
import type { StrategicResourcesConfig } from './types';
import { TAX_LEVEL_SPECS, GOVERNMENT_SIZE_OF_GDP } from '../government/types';
import { roundTo } from '../utils/math';

/** Treasury floor: NO debt machinery — money bottoms out at zero (§10). */
const TREASURY_FLOOR = 0;

export interface MonthlyLedger {
  tax: number;
  customs: number;
  exports: number;
  revenue: number;
  spending: number;
  balance: number;
}

/**
 * The country's monthly ECONOMY VALUE (M$/month): the market value of its
 * resource production — the simple, real base that tax and spending both
 * scale with. Replaces GDP.
 */
export function monthlyEconomyValueOf(
  record: { production: Record<string, number> },
  config: StrategicResourcesConfig
): number {
  let value = 0;
  for (const resource of config.resources) {
    value += (record.production[resource.id] ?? 0) * resource.price;
  }
  return roundTo(value, 2);
}

/** Bounds of the compounding output-growth multiplier (playable, reversible). */
export const OUTPUT_GROWTH_MIN = 0.5;
export const OUTPUT_GROWTH_MAX = 2;

/**
 * Processes ONE campaign month of government finance for one country.
 * Deterministic. The GLOBAL TRADE NETWORK has already been resolved for
 * this month by the caller (GovernmentSystem runs ONE world pass per month
 * BEFORE the ledgers) — this ledger bills the country's trade money
 * (customs + export receipts + import costs) and applies the light budget.
 * The treasury floors at ZERO (spec §10: NO debt machinery — a broke
 * government simply cannot afford deals, research or decisions until its
 * revenue recovers). Returns the ledger for events/UI/tests.
 */
export function processMonthFinance(
  state: GameState,
  countryId: string,
  config: StrategicResourcesConfig
): MonthlyLedger {
  const finance = state.economy.finance[countryId];
  const government = state.government.countries[countryId];
  const record = state.economy.resources[countryId];
  if (finance === undefined || government === undefined || record === undefined) {
    return { tax: 0, customs: 0, exports: 0, revenue: 0, spending: 0, balance: 0 };
  }

  const month = government.lastSimMonth;

  // —— the economy value base (production value, not GDP) ——
  const economyValue = monthlyEconomyValueOf(record, config);

  // —— revenue line 1: TAX (the ONE tax level) ——
  const taxSpec = TAX_LEVEL_SPECS[government.budget.tax];
  const financeEfficiency = government.ministries.finance?.efficiency ?? 0.5;
  const strikeActive =
    government.politics.generalStrikeUntilMonth !== null &&
    government.politics.generalStrikeUntilMonth >= month;
  const taxEfficiency =
    (0.85 + financeEfficiency * 0.3) * (1 - government.politics.corruption * 0.25) *
    (strikeActive ? 0.85 : 1);
  const tax = economyValue * taxSpec.rate * taxEfficiency;

  // —— revenue line 2: CUSTOMS (a fraction of the trade value) ——
  const customs = config.customsRate * (record.importCost + record.exportIncome);

  // —— revenue line 3: EXPORTS (the sale receipts themselves) ——
  const exportRevenue = record.exportIncome;

  const revenue = tax + customs + exportRevenue;

  // —— spending: the derived budget pot (the 100% pool money) + import bill ——
  const spending = economyValue * GOVERNMENT_SIZE_OF_GDP + record.importCost;

  const balance = revenue - spending;

  // —— treasury (the ONE money source of truth; no debt machinery) ——
  state.economy.treasury[countryId] = Math.max(
    TREASURY_FLOOR,
    roundTo((state.economy.treasury[countryId] ?? 0) + balance, 4)
  );

  finance.lastTax = roundTo(tax, 4);
  finance.lastCustoms = roundTo(customs, 4);
  finance.lastExports = roundTo(exportRevenue, 4);
  finance.lastRevenue = roundTo(revenue, 4);
  finance.lastSpending = roundTo(spending, 4);
  finance.lastBalance = roundTo(balance, 4);

  // —— the tax level's REAL economic side: compounding production growth ——
  const grown = finance.outputGrowth * (1 + taxSpec.economyGrowth);
  finance.outputGrowth = Math.min(OUTPUT_GROWTH_MAX, Math.max(OUTPUT_GROWTH_MIN, grown));

  return {
    tax: finance.lastTax,
    customs: finance.lastCustoms,
    exports: finance.lastExports,
    revenue: finance.lastRevenue,
    spending: finance.lastSpending,
    balance: finance.lastBalance
  };
}
