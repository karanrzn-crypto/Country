/**
 * Strategic resource record TYPES — pure leaf module.
 *
 * Lives apart from economy/resources.ts so the state layer can reference the
 * JSON-safe records WITHOUT reaching the recompute logic (which reads live
 * GameState + military slices). This keeps the dependency graph acyclic:
 *
 *   GameState → economySlice → resourceTypes (leaf)
 *   economyCycle.ts → GameState (one-way, no path back)
 *
 * Fully JSON-safe (save-friendly).
 */

/** Clear visual status of ONE resource (derived, never stored by hand). */
export type ResourceStatus = 'surplus' | 'balanced' | 'shortage';

/** The THREE user-facing display statuses (کمبود / متعادل / مازاد). */
export type ResourceDisplayStatus = 'surplus' | 'balanced' | 'shortage';

/**
 * Per-country resource economy record — fully JSON-safe (save-friendly).
 *
 * Exactly ONE record per country holds the resource truth (spec §13 — one
 * source of truth): every draw, purchase, trade and consumption moves THESE
 * numbers and nothing else.
 */
export interface CountryResourceState {
  /**
   * The REAL stockpile (spec §1/§3): units physically stored right now.
   * Grows with production + purchases, drains with consumption + sales.
   * Never negative.
   */
  stock: Record<string, number>;
  /** Monthly production per resource id (deposits + baseline + buildings). */
  production: Record<string, number>;
  /** Monthly consumption per resource id (population food, military wear). */
  consumption: Record<string, number>;
  /** Units ACTUALLY bought this month (world trade + manual deals). */
  imports: Record<string, number>;
  /** Units ACTUALLY sold this month (world trade + manual deals). */
  exports: Record<string, number>;
  /**
   * The uncovered deficit of THIS month (spec §5): consumption the
   * production AND the warehouse could not cover. Non-zero only when the
   * stockpile ran dry — the number the shortage status, opinion and the
   * population-growth penalty all read.
   */
  shortage: Record<string, number>;
  /** Money RECEIVED this month from selling resources (spec §3 تجارت). */
  tradeIncome: number;
  /** Money PAID this month for buying resources (spec §3 تجارت). */
  tradeExpense: number;
}

/** Empty record (trade is resolved by the monthly cycle, not by policies). */
export function emptyCountryResourceState(): CountryResourceState {
  return {
    stock: {},
    production: {},
    consumption: {},
    imports: {},
    exports: {},
    shortage: {},
    tradeIncome: 0,
    tradeExpense: 0
  };
}

// ————————————————————————————— finance (money) ——————————————————————————————

/**
 * The MONTHLY government ledger (spec §3/§12 — deliberately simple):
 *
 *   درآمد   : مالیات (جمعیت × نرخ) + تجارت (خالص فروش‌ها)
 *   هزینه‌ها : ارتش + دولت + زیرساخت
 *   تغییر خزانه = درآمد − هزینه‌ها
 *
 * No GDP, no customs, no debt, no interest, no inflation, no budget pot.
 * (Buildings produce GOODS — the factory no longer prints money.)
 */
export interface CountryFinanceState {
  /** Last month's tax income (جمعیت × نرخ × ضریب — spec §2). */
  lastTaxIncome: number;
  /** Last month's NET trade money (sales receipts − purchase bills). */
  lastTradeIncome: number;
  /** Last month's army expense. */
  lastArmyExpense: number;
  /** Last month's government expense. */
  lastGovernmentExpense: number;
  /** Last month's infrastructure expense. */
  lastInfrastructureExpense: number;
  /** Last month's balance (income − expenses) — applied to the treasury. */
  lastBalance: number;
}

export function emptyCountryFinanceState(): CountryFinanceState {
  return {
    lastTaxIncome: 0,
    lastTradeIncome: 0,
    lastArmyExpense: 0,
    lastGovernmentExpense: 0,
    lastInfrastructureExpense: 0,
    lastBalance: 0
  };
}

// ——————————————————————————————— construction ————————————————————————————————

/**
 * One construction project (spec §1): the ONE-TIME money cost is paid IN
 * FULL at start (a project that cannot be paid cannot be started), so a
 * project is always BUILDING — only its build time remains. No escrow, no
 * waiting-for-resources state, no monthly draws.
 */
export interface BuildingProject {
  readonly id: string;
  /** BuildingDef id. */
  readonly typeId: string;
  /**
   * The host GRID CELL (spec §1 — the player picked the exact region):
   * canonical key `countryId#gridId` (e.g. "country_3#A3"). One economic
   * building per cell — a cell holding a project or a building is taken.
   */
  readonly cellKey: string;
  /** Absolute month the project started. */
  readonly startedMonth: number;
  /** 0..1 elapsed build time (economic budget scales the speed). */
  progress: number;
}

export interface CountryConstructionState {
  projects: BuildingProject[];
}

export function emptyCountryConstructionState(): CountryConstructionState {
  return { projects: [] };
}

/** A COMPLETED building — anchored to its grid cell (spec §1/§2). */
export interface BuildingRecord {
  readonly id: string;
  readonly typeId: string;
  /** Canonical cell key `countryId#gridId` the building stands on. */
  readonly cellKey: string;
}
