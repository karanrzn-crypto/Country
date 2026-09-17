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
  /** Monthly production per resource id (deposits + geography baseline). */
  production: Record<string, number>;
  /** Monthly consumption per resource id (population/sectors/military). */
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
  /** Last computed monthly import cost (M$) — enters the ledger as spending. */
  importCost: number;
  /** Last computed monthly export income (M$) — enters the ledger as revenue. */
  exportIncome: number;
}

/** Empty record (trade is resolved by the world market, not by policies). */
export function emptyCountryResourceState(): CountryResourceState {
  return {
    production: {},
    consumption: {},
    imports: {},
    exports: {},
    suppliers: {},
    unfilledShortage: {},
    importCost: 0,
    exportIncome: 0
  };
}
