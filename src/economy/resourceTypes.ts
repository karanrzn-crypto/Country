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
  /**
   * How many CONSECUTIVE months each resource has been short (spec §13):
   * a shortage that persists escalates its satisfaction penalty. Reset the
   * month the shortage ends. Same keys as `shortage`.
   */
  shortageMonths: Record<string, number>;
  /** Money RECEIVED this month from selling resources (spec §3 تجارت). */
  tradeIncome: number;
  /** Money PAID this month for buying resources (spec §3 تجارت). */
  tradeExpense: number;
}

/**
 * ONE monthly TRADE CONTRACT (spec §6/§18/§24) — a permanent agreement
 * between two countries: every month the seller delivers `amountPerMonth`
 * units of the good to the buyer at the agreed unit `price`, until the
 * contract is CANCELLED (§18) or becomes unexecutable (a country is gone).
 *
 * A contract is NOT production (§10): it only TRANSFERS units that really
 * exist in the seller's stock — the monthly execution (economyCycle step ۴)
 * delivers whatever the seller can actually spare and never fakes the rest.
 * The seller's export capacity is RESERVED at signing (§16): the sum of a
 * seller's active contracts can never exceed its real available surplus.
 *
 * Fully JSON-safe (save-friendly). The ONE list lives in
 * `state.economy.contracts` — the قراردادها panel, the market and the AI
 * all read the same records (§8 — no UI-side shadow state).
 */
export interface TradeContract {
  readonly id: string;
  /** The country that delivers the goods every month. */
  readonly sellerId: string;
  /** The country that receives the goods and pays every month. */
  readonly buyerId: string;
  /** Which good (config resource id). */
  readonly resourceId: string;
  /** Committed units PER MONTH (the delivery may be smaller when the
   *  seller's real stock runs short — §9's honest partial delivery). */
  readonly amountPerMonth: number;
  /** Agreed money per unit (the BASE price at signing). */
  readonly price: number;
  /** Active contracts execute monthly; cancelled ones never do again. */
  status: 'active' | 'cancelled';
  /** The absolute month the contract was signed. */
  readonly createdAtMonth: number;
  /** Set when cancelled (spec §7 — لغو قرارداد). */
  cancelledMonth?: number;
  /** What the last monthly execution ACTUALLY delivered (display + tests). */
  lastDelivery?: number;
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
    shortageMonths: {},
    tradeIncome: 0,
    tradeExpense: 0
  };
}

/**
 * ONE FORMAL EXPORT REQUEST (the export-request directive §3): a country
 * (typically an AI) asks the PLAYER's country to SELL it a good — the
 * president sees a clear message («کشور X می‌خواهد ماهانه N واحد … خریداری
 * کند») and either APPROVES (a real TradeContract forms; monthly deliveries
 * + income follow under the ordinary contract system) or REJECTS (nothing
 * is created, nothing moves). Records live in `state.economy.exportRequests`
 * (ONE global list — the قراردادها panel reads the real State, §8).
 * Fully JSON-safe.
 */
export interface TradeRequest {
  readonly id: string;
  /** The country that WANTS to buy (would pay monthly). */
  readonly buyerId: string;
  /** The country asked to SELL — for pending requests this is the player's
   *  country (AI-to-AI trade signs directly, no approval flow). */
  readonly sellerId: string;
  /** Which good (config resource id). */
  readonly resourceId: string;
  /** Requested units PER MONTH (≤ the seller's remaining sale offer at
   *  request time; re-checked at approval). */
  readonly amountPerMonth: number;
  /** Money per unit offered (the BASE price at request time). */
  readonly price: number;
  /** pending → approved | rejected (decided by the president). */
  status: 'pending' | 'approved' | 'rejected';
  /** The absolute month the request was created. */
  readonly createdAtMonth: number;
  /** Set when the president decides (approve or reject). */
  decidedMonth?: number;
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
 * One construction project (spec §1): the ONE-TIME costs (money +
 * construction materials) are paid IN FULL at start (a project that cannot
 * pay cannot be started) and the project holds WORKFORCE capacity for its
 * whole build time (released on completion), so a project is always
 * BUILDING — only its build time remains. No escrow, no waiting state.
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

/**
 * A COMPLETED building — anchored to its grid cell (spec §1/§2).
 * Extractive buildings (oil field, iron mine) additionally hold a FINITE
 * reserve (spec §8): every produced unit drains `reserveRemaining`; at zero
 * the extraction stops. Farm/factory records carry no reserve fields.
 */
export interface BuildingRecord {
  readonly id: string;
  readonly typeId: string;
  /** Canonical cell key `countryId#gridId` the building stands on. */
  readonly cellKey: string;
  /** Extractable units left (oil/iron only — omitted for other types). */
  reserveRemaining?: number;
  /** The reserve the building STARTED with (display / depletion ratio). */
  reserveCapacity?: number;
}
