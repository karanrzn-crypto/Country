/**
 * Monthly economy simulation (Phase 2) — pure functions over GameState.
 *
 * Runs once per campaign month per strategic country (invoked by the
 * GovernmentSystem's monthly catch-up, AFTER the legacy daily economy
 * system has touched the shared treasury). Causality implemented here:
 *
 *   population → workforce → sector jobs (hiring toward capacity)
 *   capacity  ← city-area connectivity × infrastructure/education spending
 *   output    = jobs × productivity (per sector) → GDP
 *   revenue   = income/corporate/trade taxes × rates × tax efficiency
 *   spending  = budget shares × GDP + debt interest
 *   balance   → treasury (shared legacy record) & debt (auto-borrowing)
 *   unemployment, inflation, growth emerge — opinion reads them next.
 *
 * All rate effects (decision/event modifiers) enter through the central
 * Metrics resolver — this module never inspects specific decisions.
 */

import type { GameState } from '../state/GameState';
import type { MacroEconomyState, SectorState } from './macro';
import { LABOR_PARTICIPATION, SECTOR_CAPACITY_WEIGHTS, SECTORS, SECTOR_PRODUCTIVITY } from './macro';
import { networkSummary } from '../world/cityareas/CityAreaPathfinding';
import { readMetric, activeMulFactor } from '../government/Metrics';
import type { Random } from '../utils/Random';
import { roundTo } from '../utils/math';

const WAGE_SHARE_OF_GDP = 0.45;
const CORPORATE_MARGIN = 0.24;
const TARIFF_FRACTION = 0.06;
const DEBT_INTEREST_RATE = 0.045;
const DEBT_REPAYMENT_SHARE = 0.25;
const BASE_INFLATION = 0.02;

export interface MonthlyLedger {
  revenue: number;
  spending: number;
  balance: number;
  gdp: number;
}

/** Builds the initial macro record for one country (≈ neutral economy). */
export function createMacroEconomy(population: number): MacroEconomyState {
  const workforce = population * LABOR_PARTICIPATION;
  const sectors: Record<string, SectorState> = {};
  let gdp = 0;
  for (const sectorId of SECTORS) {
    const capacityJobs = workforce * SECTOR_CAPACITY_WEIGHTS[sectorId];
    const jobs = capacityJobs * 0.93; // ≈ 7 % unemployment at campaign start
    const output = (jobs * SECTOR_PRODUCTIVITY[sectorId]) / 1e6;
    gdp += output;
    sectors[sectorId] = {
      jobs: roundTo(jobs, 1),
      capacityJobs: roundTo(capacityJobs, 1),
      productivity: SECTOR_PRODUCTIVITY[sectorId],
      output: roundTo(output, 3)
    };
  }
  const unemployment = Math.max(0, (workforce - Object.values(sectors).reduce((sum, s) => sum + s.jobs, 0)) / workforce);
  return {
    gdp: roundTo(gdp, 3),
    gdpGrowth: 0.02,
    inflation: 0.03,
    unemployment: roundTo(unemployment, 4),
    debt: 0,
    sectors: sectors as MacroEconomyState['sectors'],
    trade: { exports: roundTo(gdp * 0.14, 3), imports: roundTo(gdp * 0.15, 3), balance: roundTo(-gdp * 0.01, 3) },
    lastRevenue: 0,
    lastSpending: 0,
    lastBalance: 0,
    gdpPreviousMonth: roundTo(gdp, 3)
  };
}

/**
 * Processes ONE campaign month for one country. Deterministic given state
 * + rng. The GLOBAL TRADE NETWORK has already been resolved for this month
 * by the caller (GovernmentSystem runs ONE world pass per month BEFORE the
 * country ledgers — spec §11: all countries' production/consumption first,
 * then the world market, then the ledgers) — this ledger only BILLS the
 * country's trade flows (export income / import cost).
 * Returns the ledger for events/UI/tests.
 */
export function processMonthEconomy(state: GameState, countryId: string, _rng: Random): MonthlyLedger {
  const macro = state.economy.macro[countryId];
  const government = state.government.countries[countryId];
  const country = state.countries.countries[countryId];
  if (macro === undefined || government === undefined || country === undefined) {
    return { revenue: 0, spending: 0, balance: 0, gdp: 0 };
  }

  const month = government.lastSimMonth;
  const population = country.population;
  const workforce = population * LABOR_PARTICIPATION;

  // —— city-area network hook: connectivity & development lift capacity ——
  const summary = networkSummary(state.cityAreas.network, countryId);
  const urbanFactor = 0.9 + 0.2 * summary.connectivity + 0.1 * summary.averageDevelopment;

  const educationEfficiency = government.ministries.education?.efficiency ?? 0.5;
  const infrastructureShare = government.budget.spendingShares.infrastructure;
  const generalStrike = government.politics.generalStrikeUntilMonth !== null && government.politics.generalStrikeUntilMonth >= month;

  // —— sector dynamics ——
  let jobsTotal = 0;
  for (const sectorId of SECTORS) {
    const sector = macro.sectors[sectorId];
    const capacityTarget = workforce * SECTOR_CAPACITY_WEIGHTS[sectorId] * urbanFactor;
    sector.capacityJobs += (capacityTarget - sector.capacityJobs) * (0.05 + infrastructureShare * 0.6);
    // Hiring pulls jobs toward capacity; a general strike idles workers.
    const strikeHit = generalStrike && (sectorId === 'industry' || sectorId === 'construction' || sectorId === 'trade') ? 0.7 : 1;
    const jobTarget = Math.min(sector.capacityJobs, workforce) * strikeHit;
    sector.jobs += (jobTarget - sector.jobs) * 0.15;
    // Productivity compounds slowly; education funding accelerates it.
    sector.productivity *= 1 + 0.0006 + government.budget.spendingShares.education * 0.004 * educationEfficiency;
    const baseOutput = (sector.jobs * sector.productivity) / 1e6;
    sector.output = Math.max(0, baseOutput);
    jobsTotal += sector.jobs;
  }

  // —— GDP with read-time modifiers (decisions/events) ——
  let gdp = 0;
  for (const sectorId of SECTORS) {
    gdp += readMetric(state, countryId, `sector.${sectorId}`);
  }
  gdp = Math.max(0, gdp * activeMulFactor(state, countryId, 'gdp'));
  macro.gdp = roundTo(gdp, 3);

  // —— growth (annualized, smoothed) ——
  const previous = macro.gdpPreviousMonth;
  if (previous > 1e-6) {
    const monthlyGrowth = gdp / previous - 1;
    macro.gdpGrowth = Math.max(-0.5, Math.min(0.5, macro.gdpGrowth + (monthlyGrowth * 12 - macro.gdpGrowth) * 0.25));
  }
  macro.gdpPreviousMonth = macro.gdp;

  // —— unemployment ——
  macro.unemployment = workforce > 0 ? Math.max(0, Math.min(1, (workforce - jobsTotal) / workforce)) : 0;

  // —— trade ——
  const openness = 0.85 + (government.ministries.foreign?.efficiency ?? 0.5) * 0.3;
  macro.trade.exports = roundTo((macro.sectors.trade.output + macro.sectors.industry.output * 0.25) * openness, 3);
  macro.trade.imports = roundTo(gdp * 0.15 - macro.trade.balance * 0.1, 3);
  macro.trade.imports = Math.max(0, macro.trade.imports);
  macro.trade.balance = roundTo(macro.trade.exports - macro.trade.imports, 3);

  // ————————————————————————————————— ledger ——————————————————————————————
  const financeEfficiency = government.ministries.finance?.efficiency ?? 0.5;
  const taxEfficiency = (0.85 + financeEfficiency * 0.3) * (1 - government.politics.corruption * 0.25);
  const rates = government.budget.taxRates;

  let revenue =
    gdp * WAGE_SHARE_OF_GDP * rates.income * taxEfficiency +
    (macro.sectors.industry.output + macro.sectors.mining.output + macro.sectors.energy.output + macro.sectors.construction.output) *
      CORPORATE_MARGIN *
      rates.corporate *
      taxEfficiency +
    (macro.trade.exports + macro.trade.imports) * TARIFF_FRACTION * rates.trade * taxEfficiency +
    gdp * 0.004;

  const spendingBase = government.budget.spendingShares;
  let spending = 0;
  for (const share of Object.values(spendingBase)) spending += share * gdp;
  spending += macro.debt * DEBT_INTEREST_RATE; // annual interest

  // —— strategic resource trade: bill the month's RESOLVED world flows ——
  // Trade amounts are MONTHLY flows; the ledger below is ANNUAL (÷12 later),
  // so the monthly trade money enters as ×12 to survive the division exactly.
  const resources = state.economy.resources[countryId];
  let resourceExportIncome = resources?.exportIncome ?? 0;
  let resourceImportCost = resources?.importCost ?? 0;
  if (resourceExportIncome > 0) revenue += resourceExportIncome * 12;
  if (resourceImportCost > 0) spending += resourceImportCost * 12;

  // Revenue and spending are ANNUAL amounts at current levels; the monthly
  // flow is 1/12 of them (calendar-exact months are handled by the caller).
  const monthlyRevenue = revenue / 12;
  const monthlySpending = spending / 12;
  const monthlyBalance = monthlyRevenue - monthlySpending;

  // —— treasury & debt (single shared treasury source of truth) ——
  const treasuryKey = countryId;
  const newTreasury = (state.economy.treasury[treasuryKey] ?? 0) + monthlyBalance;
  if (newTreasury >= 0) {
    state.economy.treasury[treasuryKey] = roundTo(newTreasury, 4);
    if (macro.debt > 0 && monthlyBalance > 0) {
      macro.debt = Math.max(0, macro.debt - monthlyBalance * DEBT_REPAYMENT_SHARE);
    }
  } else {
    // Automatic borrowing: the deficit lands on the national debt.
    state.economy.treasury[treasuryKey] = 0;
    macro.debt = Math.max(0, macro.debt + (-newTreasury));
  }

  macro.lastRevenue = roundTo(monthlyRevenue, 4);
  macro.lastSpending = roundTo(monthlySpending, 4);
  macro.lastBalance = roundTo(monthlyBalance, 4);

  // —— inflation (Phillips-curve flavored drift toward a target) ——
  const deficitRatio = gdp > 0 ? Math.max(0, -macro.lastBalance * 12) / gdp : 0;
  const inflationTarget =
    BASE_INFLATION + Math.max(0, 0.06 - macro.unemployment) * 0.35 + deficitRatio * 0.18;
  macro.inflation += (inflationTarget - macro.inflation) * 0.08;
  macro.inflation = Math.max(-0.2, Math.min(1, macro.inflation));

  return { revenue: macro.lastRevenue, spending: macro.lastSpending, balance: macro.lastBalance, gdp: macro.gdp };
}
