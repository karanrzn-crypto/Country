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
  /** Monthly production per resource id (Σ attributed city deposits). */
  production: Record<string, number>;
  /** Monthly consumption per resource id (population/sectors/military). */
  consumption: Record<string, number>;
  /** Active monthly imports per resource id (after world-market capping). */
  imports: Record<string, number>;
  /** Active monthly exports per resource id (surplus × exportShare). */
  exports: Record<string, number>;
  /** Player policies — import/export toggles (mutually exclusive per resource). */
  importPolicy: Record<string, boolean>;
  exportPolicy: Record<string, boolean>;
  /** resourceId → the supplier country the market routes the import through. */
  suppliers: Record<string, string | null>;
  /** Last computed monthly import cost (M$) — enters the ledger as spending. */
  importCost: number;
  /** Last computed monthly export income (M$) — enters the ledger as revenue. */
  exportIncome: number;
}

/** Empty record with the given policies preserved (defaults off). */
export function emptyCountryResourceState(
  importPolicy: Record<string, boolean> = {},
  exportPolicy: Record<string, boolean> = {}
): CountryResourceState {
  return {
    production: {},
    consumption: {},
    imports: {},
    exports: {},
    importPolicy: { ...importPolicy },
    exportPolicy: { ...exportPolicy },
    suppliers: {},
    importCost: 0,
    exportIncome: 0
  };
}
