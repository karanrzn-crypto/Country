/**
 * Strategic resource record TYPES — pure leaf module.
 *
 * Lives apart from economy/resources.ts so the state layer can reference the
 * JSON-safe record WITHOUT reaching the recompute logic (which reads live
 * GameState + military slices). This keeps the dependency graph acyclic:
 *
 *   GameState → economySlice → resourceTypes (leaf)
 *   resources.ts → GameState (one-way, no path back into resources.ts)
 *
 * Fully JSON-safe (save-friendly).
 */

/** Clear visual status of ONE resource (derived, never stored by hand). */
export type ResourceStatus = 'surplus' | 'balanced' | 'shortage' | 'imported' | 'exported';

/** Per-country resource economy record — fully JSON-safe (save-friendly). */
export interface CountryResourceState {
  /**
   * The REAL stockpile (spec §2): units physically stored right now. Grows
   * with production + imports, drains with consumption, exports, military
   * production and construction. NOT a display number — every draw and
   * purchase moves it.
   */
  stock: Record<string, number>;
  /** Monthly production per resource id (mines + baseline + factories). */
  production: Record<string, number>;
  /** Monthly consumption per resource id (population/military/factory upkeep). */
  consumption: Record<string, number>;
  /** Monthly imports per resource id (ACTUALLY bought on the world market). */
  imports: Record<string, number>;
  /** Monthly exports per resource id (ACTUALLY sold to buyers). */
  exports: Record<string, number>;
  /**
   * The REAL trade partners of the world market: resourceId → sellerId →
   * monthly units bought from that seller. Empty inner records = no active
   * import flow. The same flows, read from the sellers' side, reconstruct
   * the exports (every unit sold appears on exactly one buyer's record).
   */
  suppliers: Record<string, Record<string, number>>;
  /**
   * resourceId → units still missing after the world market cleared (the
   * GLOBAL supply could not cover the GLOBAL demand — spec §7's Unfilled
   * Shortage). Zero/absent = the market (or domestic production) covered it.
   */
  unfilledShortage: Record<string, number>;
  /**
   * resourceId → units bought in the MONTHLY EMERGENCY PASS from other
   * countries' stockpiles (the food safety buffer, spec §8) — stock and
   * money moved immediately, so these units are NOT part of `imports` again.
   */
  emergencyImports: Record<string, number>;
  /** Last computed monthly import cost (M$) — enters the ledger as spending. */
  importCost: number;
  /** Last computed monthly export income (M$) — enters the ledger as revenue. */
  exportIncome: number;
}

/** Empty record (trade is resolved by the world market, not by policies). */
export function emptyCountryResourceState(): CountryResourceState {
  return {
    stock: {},
    production: {},
    consumption: {},
    imports: {},
    exports: {},
    suppliers: {},
    unfilledShortage: {},
    emergencyImports: {},
    importCost: 0,
    exportIncome: 0
  };
}

// ———————————————————————————— finance (money, light) ————————————————————————

/**
 * The MONTHLY government ledger (spec §10 — deliberately light): exactly
 * THREE revenue lines (Tax + Customs + Exports) against the derived budget
 * spending. No GDP, no debt, no interest, no inflation — money exists to
 * back deals and government costs, nothing more.
 */
export interface CountryFinanceState {
  /** Last month's tax revenue (M$) — the tax level's rate on domestic output. */
  lastTax: number;
  /** Last month's customs revenue (M$) — a fraction of the trade value. */
  lastCustoms: number;
  /** Last month's export income (M$) — resource sales receipts. */
  lastExports: number;
  /** Last month's total revenue (tax + customs + exports). */
  lastRevenue: number;
  /** Last month's government spending (M$) — the derived budget pot. */
  lastSpending: number;
  /** Last month's balance (revenue − spending) — applied to the treasury. */
  lastBalance: number;
  /**
   * Compounding production-growth multiplier from the tax level (LOW buffs,
   * MAX penalizes — spec §4's real economic side). Applied by the recompute
   * pass to the baseline + factory output; starts at 1.
   */
  outputGrowth: number;
}

export function emptyCountryFinanceState(): CountryFinanceState {
  return { lastTax: 0, lastCustoms: 0, lastExports: 0, lastRevenue: 0, lastSpending: 0, lastBalance: 0, outputGrowth: 1 };
}

// ————————————————————————————— research (mines) ——————————————————————————————

/**
 * Resource research state (spec §11/§12): per country, the highest UNLOCKED
 * mine level per resource branch. Absent resource = level 1 (the base).
 * Unlocking level N lets the country upgrade ITS mines of that resource to N.
 */
export interface ResourceResearchState {
  /** resourceId → highest unlocked mine level (absent = 1). */
  mineLevels: Record<string, number>;
}

export function emptyResourceResearchState(): ResourceResearchState {
  return { mineLevels: {} };
}

// ——————————————————————————————— construction ————————————————————————————————

/**
 * The TWO construction states (spec §6): a project waits until its FULL
 * resource cost is SECURED, then builds by TIME alone.
 */
export type ConstructionStatus = 'waiting' | 'building';

/**
 * One construction project (spec §4/§5/§6):
 *
 *  - STARTING is free; the project begins in `waiting`.
 *  - The cost is SECURED ONCE: units physically move out of the country's
 *    FREE stockpile into this project's `secured` escrow (spec §5 — the
 *    reservation another project can never spend). One source of truth:
 *    stock = free units, secured = reserved units.
 *  - When every cost line is fully secured the project flips to `building`
 *    and ONLY construction time (scaled by the economic budget) finishes
 *    it — resources are never consumed again month by month (spec §6:
 *    the cost is a ONE-TIME cost).
 */
export interface ConstructionProject {
  readonly id: string;
  /** ProductionFactoryDef id. */
  readonly typeId: string;
  /** Host city (the country's capital at start time). */
  readonly cityId: string;
  /** Absolute month the project started. */
  readonly startedMonth: number;
  status: ConstructionStatus;
  /**
   * 0..1 — for `building` projects the elapsed build time (time-based,
   * budget-scaled); for `waiting` projects the secured fraction of the
   * cost (informational).
   */
  progress: number;
  /** resourceId → units already SECURED (reserved escrow) for this project. */
  secured: Record<string, number>;
}

export interface CountryConstructionState {
  projects: ConstructionProject[];
}

export function emptyCountryConstructionState(): CountryConstructionState {
  return { projects: [] };
}

/** A COMPLETED production factory (the built thing that boosts production). */
export interface CountryPlant {
  readonly id: string;
  readonly typeId: string;
  readonly cityId: string;
}
