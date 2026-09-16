/**
 * Macro-economy domain (Phase 2) — national accounts, sectors and trade.
 *
 * This is the REAL country economy simulation state, keyed by strategic-map
 * country ids. The legacy Phase-0 economy slice (treasury/stockpiles/
 * factories) keeps serving the demo world; its `treasury` record is SHARED —
 * strategic countries keep their balances in the same single source of truth.
 *
 * CAUSAL CHAIN (implemented in MacroEconomySystem, monthly):
 *   population → workforce → sector jobs → sector output → GDP
 *   tax rates × bases → revenue; spending shares × GDP → spending
 *   revenue − spending → treasury & debt; debt → interest → spending
 *   infrastructure/education spending + city-area connectivity → capacity
 *   unemployment / inflation / taxes / growth → public opinion → approval
 *
 * UNITS: money in $ millions (M$, annual flows unless stated), people in
 * persons, productivity in $ per worker per year.
 */

export const SECTORS = [
  'agriculture',
  'industry',
  'energy',
  'mining',
  'technology',
  'construction',
  'services',
  'trade'
] as const;

export type SectorId = (typeof SECTORS)[number];

export interface SectorState {
  /** Employed workers (persons). */
  jobs: number;
  /** Job capacity (persons) — grows with investment and connectivity. */
  capacityJobs: number;
  /** $ output per worker per year — grows with education and technology. */
  productivity: number;
  /** Last computed annual output in M$ (jobs × productivity / 1e6). */
  output: number;
}

export interface TradeState {
  /** Annual export volume (M$). */
  exports: number;
  /** Annual import volume (M$). */
  imports: number;
  /** exports − imports (M$, last computed). */
  balance: number;
}

export interface MacroEconomyState {
  /** Annual gross domestic product (M$, last computed). */
  gdp: number;
  /** Annualized real growth fraction (smoothed monthly). */
  gdpGrowth: number;
  /** Annual inflation fraction. */
  inflation: number;
  /** Unemployment fraction of the workforce. */
  unemployment: number;
  /** National debt (M$) — negative treasury converts into debt. */
  debt: number;
  sectors: Record<SectorId, SectorState>;
  trade: TradeState;
  /** Last month's government ledger (M$) — UI + tests read these. */
  lastRevenue: number;
  lastSpending: number;
  lastBalance: number;
  /** Previous month's GDP (M$) — growth computation base. */
  gdpPreviousMonth: number;
}

/** Sector job-capacity weights (relative size of each sector). */
export const SECTOR_CAPACITY_WEIGHTS: Readonly<Record<SectorId, number>> = {
  agriculture: 0.22,
  industry: 0.16,
  energy: 0.04,
  mining: 0.05,
  technology: 0.05,
  construction: 0.08,
  services: 0.3,
  trade: 0.1
};

/** Baseline productivity per sector ($ per worker per year). */
export const SECTOR_PRODUCTIVITY: Readonly<Record<SectorId, number>> = {
  agriculture: 38_000,
  industry: 82_000,
  energy: 160_000,
  mining: 120_000,
  technology: 140_000,
  construction: 60_000,
  services: 66_000,
  trade: 58_000
};

/** Creates a neutral sector record. */
export function createSector(sectorId: SectorId, jobs: number): SectorState {
  return {
    jobs,
    capacityJobs: jobs,
    productivity: SECTOR_PRODUCTIVITY[sectorId],
    output: 0
  };
}

/** Labor force participation (fraction of population in the workforce). */
export const LABOR_PARTICIPATION = 0.52;
