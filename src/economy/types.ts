/**
 * Economy domain model — the SIMPLE economy (spec §1-§9): four goods
 * (غذا / آهن / نفت / کالاهای صنعتی), one stockpile per country, one
 * transparent monthly cycle, base prices, construction on geographic grid
 * cells paid in money + materials + workforce, per-region land quality,
 * finite extraction reserves, diminishing returns, country specialization,
 * a 0-100 economy level and duration-graded shortage satisfaction. Leaf
 * module.
 */

/** Data-driven resource definition (src/data/economy.json). */
export interface ResourceDef {
  readonly id: string;
  readonly name: string;
  readonly weight: number;
}

// —————————————————————— legacy demo-world shapes (untouched) ——————————————————

/** Data-driven factory archetype (economy.json → factoryTypes). */
export interface FactoryTypeDef {
  readonly id: string;
  readonly name: string;
  readonly inputs: Readonly<Record<string, number>>;
  readonly outputs: Readonly<Record<string, number>>;
  readonly cyclesPerDay: number;
  readonly workforce: number;
}

/** Runtime factory instance — persisted in the economy state slice (LEGACY). */
export interface FactoryRecord {
  readonly id: string;
  readonly typeId: string;
  readonly regionId: string;
  readonly ownerId: string;
  active: boolean;
  lastOutputAmount: number;
}

// ————————————————————————— the SIMPLE strategic economy ————————————————————————

/** One strategic resource: Persian display name + the BASE price (spec §7). */
export interface StrategicResourceDef {
  readonly id: string;
  /** Persian display name (UI renders it verbatim). */
  readonly name: string;
  /** Base money price per unit — buys AND sells bill at this price (§6/§7). */
  readonly price: number;
}

/** Consumption drivers of ONE resource (data-driven calibration, §4/§5). */
export interface ResourceConsumptionDef {
  /** Monthly units per 1M population (food). */
  readonly perMillionPopulation?: number;
  /** Monthly units per operational military unit (fuel, equipment wear). */
  readonly perMilitaryUnit?: number;
}

/** Geography weights of ONE resource for the domestic baseline. */
export interface DomesticBaselineResourceDef {
  /** Monthly units at FULL potential (geography 1.0 + max city term). */
  readonly base: number;
  /** Biome (climate) weights; omitted → class-neutral (`biomeNeutral`). */
  readonly biomes?: Readonly<Record<string, number>>;
  /** Neutral weight when `biomes` is omitted (default 0.5). */
  readonly biomeNeutral?: number;
  /** Terrain (land shape) weights; omitted → class-neutral (`terrainNeutral`). */
  readonly terrain?: Readonly<Record<string, number>>;
  /** Neutral weight when `terrain` is omitted (default 0.5). */
  readonly terrainNeutral?: number;
  /** City-term multiplier. */
  readonly cityFactor?: number;
}

/** Data-driven domestic baseline production (economy.json). */
export interface DomesticBaselineConfig {
  /** Monthly units per city (capped at cityTermMaxCities). */
  readonly cityTermScale: number;
  /** City count cap for the city term. */
  readonly cityTermMaxCities: number;
  /** Weight of the biome mix in the geography term (0..1). */
  readonly biomeWeight: number;
  /** Weight of the terrain mix in the geography term (0..1). */
  readonly terrainWeight: number;
  /** Per-resource geography profile. */
  readonly resources: Readonly<Record<string, DomesticBaselineResourceDef>>;
}

/**
 * One BUILDABLE building (spec §1/§4) — production of exactly ONE good:
 * adds `output` monthly units of `resource` when complete. The REAL output
 * is scaled by the REGION QUALITY of its cell (§3), the country's resource
 * POTENTIAL (§2/§15), the ECONOMY LEVEL (§14 — deliberately weak) and the
 * country's DIMINISHING RETURNS per building type (§7). Starting one costs
 * THREE one-time resources (§4): money + construction materials (drawn
 * from the industrial-goods stock) + workforce (a CAPACITY held while the
 * project builds, released on completion). Extractive buildings (oil, iron)
 * also hold a FINITE reserve (§8) that depletes with every produced unit.
 *
 * MILITARY buildings (kind 'military') share the SAME construction system,
 * the SAME one-facility-per-region rule and the SAME costs — they produce
 * NO resource yet (the military infrastructure directive: buildings and
 * placement only); `resource` is omitted and `output` is 0.
 */
export interface BuildingDef {
  readonly id: string;
  readonly name: string;
  /** 'economic' (default) produces its good; 'military' is infrastructure
   *  only (no resource output yet) — both occupy exactly ONE region. */
  readonly kind?: 'economic' | 'military';
  /** Which good this building produces (config resource id) — omitted for
   *  military infrastructure buildings. */
  readonly resource?: string;
  /** BASE monthly units added while active (before all modifiers). */
  readonly output: number;
  /** ONE-TIME money cost, deducted from the treasury at start. */
  readonly cost: number;
  /** ONE-TIME construction materials (industrial-goods units) at start. */
  readonly materials: number;
  /** Workforce CAPACITY held for the whole build time (spec §4). */
  readonly workforce: number;
  /** Finite extraction reserve (oil/iron); 0 = inexhaustible (farm/factory). */
  readonly reserveUnits: number;
  /** Base build time in months (the economic budget scales the speed). */
  readonly buildMonths: number;
}

/** The money side of the simple economy (spec §2/§3) — all data-driven. */
export interface EconomyFinanceConfig {
  /** The treasury every country starts the campaign with. */
  readonly startingTreasury: number;
  /** Monthly population growth rate (0.001 = +0.1 %/month). */
  readonly populationGrowthPerMonth: number;
  /** درآمد مالیاتی = جمعیت(میلیون) × نرخ × THIS (spec §2). */
  readonly taxIncomePerMillionPerRate: number;
  /** هزینه دولت = جمعیت(میلیون) × THIS (spec §3). */
  readonly governmentCostPerMillion: number;
  /** هزینه ارتش = سرباز(هزار نفر) × THIS (spec §3). */
  readonly armyCostPerThousandSoldiers: number;
  /** هزینه زیرساخت = تعداد نواحی شهری × THIS (spec §3). */
  readonly infrastructureCostPerArea: number;
}

/**
 * Country SPECIALIZATION (spec §4/§15): every country is BETTER at some
 * goods and WEAKER at others — ranked against its own geography-derived
 * baseline (best / second / weakest). Multipliers stay moderate so every
 * country still produces every good (specialization ≠ inability).
 */
export interface EconomySpecializationConfig {
  /** Multiplier bonus for the country's strongest good (e.g. 0.5 → ×1.5). */
  readonly boostBest: number;
  /** Multiplier bonus for the second good (e.g. 0.15 → ×1.15). */
  readonly boostSecond: number;
  /** Multiplier cut for the weakest good (e.g. 0.35 → ×0.65). */
  readonly reduceWeakest: number;
  /**
   * The country's resource POTENTIAL per specialization rank (§2/§15):
   * a building's output scales by its good's rank multiplier — an oil
   * field in an oil-poor country yields far less than in an oil-rich one.
   * Index 0 = the country's BEST good; the array is read by rank.
   */
  readonly potentialByRank: readonly number[];
}

/**
 * The country ECONOMY LEVEL (spec §3) — one 0-100 number for the overall
 * state of the economy. It drifts GRADUALLY (max maxStepPerMonth) toward a
 * target derived from the real month (positive balance ↑, uncovered
 * shortages ↓) and scales BUILDING production by
 * (level − 50) × buildingBonusPerPoint around 50 (never multi-fold).
 */
export interface EconomyLevelConfig {
  /** Starting level of every country (the neutral midpoint). */
  readonly start: number;
  /** Maximum change per month (spec §3 — تدریجی, never a jump). */
  readonly maxStepPerMonth: number;
  /** Building production per point away from 50 (e.g. 0.006 → ±30% at 0/100). */
  readonly buildingBonusPerPoint: number;
  /** The neutral target (no balance, no shortages). */
  readonly targetBase: number;
  /** Monthly balance → target points (lastBalance × balanceFactor). */
  readonly balanceFactor: number;
  /** The balance term's magnitude cap (points). */
  readonly balanceCap: number;
  /** Target points lost PER uncovered resource. */
  readonly shortagePenalty: number;
}

/**
 * Graded SHORTAGE → SATISFACTION penalties (spec §7/§13): the penalty is a
 * piecewise-linear function of the supply COVERAGE ratio (تولید + واردات
 * against مصرف). Full coverage costs nothing; 90% hurts a little; 70%
 * moderately; 40% badly. A shortage that persists for MONTHS escalates
 * (durationEscalation) — one bad month never collapses satisfaction.
 * Breakpoints stay sorted descending by coverage.
 */
export interface SatisfactionConfig {
  readonly breakpoints: readonly { readonly coverage: number; readonly penalty: number }[];
  /** Penalty ceiling (deep below the last breakpoint). */
  readonly maxPenalty: number;
  /** Share of the total penalty applied to political stability per month. */
  readonly stabilityFactor: number;
  /** Escalation of the penalty per EXTRA shortage month (spec §13). */
  readonly durationEscalation: { readonly perMonth: number; readonly maxMultiplier: number };
}

/**
 * Per-REGION economic quality (spec §3): every grid cell carries its own
 * land quality per good — an excellent farm belt, a barren oil province…
 * The quality is DERIVED from the cell's biome/terrain through the same
 * weight tables the domestic baseline uses (one geography, one truth);
 * these thresholds only map a 0..1 quality to its Persian label.
 */
export interface CellQualityConfig {
  /** quality ≥ THIS → «عالی». */
  readonly excellent: number;
  /** quality ≥ THIS → «خوب» (below excellent). */
  readonly good: number;
  /** quality ≥ THIS → «متوسط» (below good); anything lower is «ضعیف». */
  readonly fair: number;
}

/**
 * DIMINISHING RETURNS per building type (spec §7): the k-th building of
 * one type in a country yields less than the first — multiplier
 * max(min, 1 − step × (k − 1)). Moderate by design: stacking farms still
 * adds food, but never linearly forever.
 */
export interface DiminishingReturnsConfig {
  /** Multiplier lost per additional building of the same type. */
  readonly step: number;
  /** The multiplier floor (the stack never becomes worthless). */
  readonly min: number;
}

/**
 * Starting-stock rules (spec §1/§10): every country starts with a LIMITED
 * buffer — a few MONTHS of its own consumption per good (population-scaled
 * automatically), flavored by its economic profile (a food-rich country
 * holds relatively more food), with an absolute floor for tiny countries.
 */
export interface StartingStockConfig {
  /** Months of the country's OWN consumption the initial stock covers. */
  readonly months: Readonly<Record<string, number>>;
  /** The absolute floor per good (tiny populations still get a seed). */
  readonly floor: Readonly<Record<string, number>>;
  /** Profile multipliers by the country's specialization rank per good. */
  readonly flavorByRank: readonly number[];
}

/**
 * THE MARKET SALE QUOTA (the sale-quantity directive): every country puts
 * up a FIXED, LIMITED monthly amount of each good for sale — a config SHARE
 * of its real export capacity (stock above the safety reserve PLUS the
 * month's real production surplus flow). The number is derived ONLY from
 * the seller's own state, NEVER from any buyer's shortage or need; a
 * buyer's demand can never inflate it.
 */
export interface MarketConfig {
  /** Share of the real export capacity a country offers for sale (0..1;
   *  0.5 → a country with 1,000 spare units puts up 500/month). */
  readonly saleQuotaShare: number;
  /** After a REJECTED export request, the buyer waits THIS many months
   *  before asking the same seller for the same good again. */
  readonly requestCooldownMonths: number;
}

/**
 * YEAR-OVER-YEAR CONSUMPTION GROWTH (the demand directive + its growth
 * refinement): the population demand base of EVERY good stays at its BASE
 * level for the first `graceYears` years (the opening must not be too hard
 * — the president gets time to develop the country), THEN begins to grow
 * GRADUALLY — (1 + perYear) compounded per month after the grace, so each
 * year's need is larger than the last and no sudden jump ever happens
 * (population + development raise the domestic need over a long game).
 * Stateless: derived from the absolute campaign month, so saves need no
 * new fields and old + new saves behave identically. `maxFactor` caps the
 * compounding so no economy collapses under it.
 */
export interface ConsumptionGrowthConfig {
  /** Years the consumption stays at its BASE level before growing
   *  (the growth refinement §1: سال ۱ تا ۵ مصرف پایه). Default 0. */
  readonly graceYears?: number;
  /** Yearly growth of the population demand base AFTER the grace
   *  (0.05 → +5 %/year, compounding monthly). */
  readonly perYear: number;
  /** The compounding ceiling (4 → demand never exceeds ×4 the base). */
  readonly maxFactor: number;
}

/**
 * THE ECONOMIC BUDGET → PRODUCTION (the budget directive §2): the economic
 * budget (0..100, TEN-point steps, 50 = neutral) scales ALL domestic
 * production LINEARLY around 50 — (budgetPct − 50) × productionPerPoint.
 * With 0.006: budget 60 → +6% production, 40 → −6%, 0 → −30%, 100 → +30%.
 * ONE shared factor for EVERY production path (deposits, baseline and
 * buildings) — no per-building formula.
 */
export interface EconomicBudgetConfig {
  /** Production change per budget point away from the neutral 50. */
  readonly productionPerPoint: number;
}

/**
 * THE WAREHOUSE / STORAGE (the storage directive §2): how much of each good
 * a country can hold FOR THE FUTURE — countries may buy MORE than this
 * month's consumption (stockpiling for construction, lean months, trade),
 * but never beyond the warehouse. Optional (undefined → unbounded, legacy
 * configs): every reader falls back to "no cap".
 */
export interface StorageConfig {
  /** Months of the country's OWN consumption the warehouse holds
   *  (capacity = maxMonths × monthly consumption, scaled per country). */
  readonly maxMonths: number;
  /** The absolute per-good floor for tiny countries (units). */
  readonly floor: Readonly<Record<string, number>>;
  /** AI future-gathering: the stock-months an AI country builds toward
   *  when it has no shortage and money to spare (the storage directive's
   *  «AI کشورها نیز بتوانند برای آینده منابع جمع کنند»). */
  readonly aiFutureMonths: number;
  /** Monthly chance an AI country WITHOUT shortages tries one stockpile
   *  purchase (kept low — gathering for the future never beats surviving). */
  readonly aiStockpileChance: number;
}

/**
 * ONE ECONOMIC EVENT DEFINITION (the events directive §5): a TEMPORARY
 * production cut on ONE good — «پالایشگاه نفت خراب شده است» cuts the oil
 * output, a famine cuts the food output — for `durationMonths` months,
 * then the economy returns to normal BY ITSELF (nothing is permanent).
 */
export interface EconomicEventDef {
  readonly id: string;
  /** Persian short name (notifications + the active-events list). */
  readonly short: string;
  /** The full Persian notification message shown when the event starts. */
  readonly message: string;
  /** Which good's production the event cuts (config resource id). */
  readonly resource: string;
  /** The production multiplier while active (0.5 → half output). */
  readonly factor: number;
  /** How many months the event lasts, then the economy auto-recovers. */
  readonly durationMonths: number;
  /** Relative pick weight when the monthly roll fires (default 1). */
  readonly weight?: number;
}

/** The ECONOMIC EVENTS system (the events directive §5) — config-driven. */
export interface EconomicEventsConfig {
  /** Monthly chance ONE country STARTS an event (0.05 → every ~20 months
   *  per country on average — «هر ماه یا هر چند ماه»). */
  readonly checkChance: number;
  /** At most THIS many events on ONE country at once (no event storms). */
  readonly maxConcurrent: number;
  /** The event pool (each a temporary production cut). */
  readonly events: readonly EconomicEventDef[];
}

/** Data-driven tuning of the simple economy (economy.json). */
export interface StrategicResourcesConfig {
  /** Deposit quantity (1..100) → monthly production multiplier. */
  readonly productionScale: number;
  /** The market sale-quota rule (§market — the sellers' fixed offers). */
  readonly market: MarketConfig;
  /** Year-over-year demand growth (§consumptionGrowth — the years' hunger). */
  readonly consumptionGrowth: ConsumptionGrowthConfig;
  /** The economic-budget production modifier (§budget — 50 = neutral). */
  readonly economicBudget: EconomicBudgetConfig;
  /** The WAREHOUSE capacity + AI future-gathering (the storage directive
   *  §2). Optional: legacy configs without it keep an unbounded warehouse. */
  readonly storage?: StorageConfig;
  /** The TEMPORARY economic events (the events directive §5) — optional:
   *  legacy configs without it simply never fire events. */
  readonly economicEvents?: EconomicEventsConfig;
  /** Anti-famine safety buffer (§5): months of consumption kept out of
   *  exports — food its own (larger) reserve, others `reserveMonths`. */
  readonly safetyBuffer: { readonly foodMonths: number; readonly reserveMonths: number };
  /** Display-status thresholds: a +1/month trickle is NOT a surplus. */
  readonly displayStatus: {
    readonly surplusBufferMonths: number;
    readonly minSurplusShare: number;
  };
  /**
   * Concurrent construction limits (spec §6): at most `maxProjects`
   * projects at once AND their combined workforce must fit the country's
   * construction workforce (base + per-million, spec §4).
   */
  readonly construction: {
    readonly maxProjects: number;
    readonly workforceBase: number;
    readonly workforcePerMillion: number;
  };
  /** Diminishing returns per building type (spec §7). */
  readonly diminishingReturns: DiminishingReturnsConfig;
  /** Per-region quality thresholds → labels (spec §3). */
  readonly cellQuality: CellQualityConfig;
  /** Limited starting-stock rules (spec §1/§10). */
  readonly startingStock: StartingStockConfig;
  /** The buildable buildings (spec §8 — one effect each). */
  readonly buildings: readonly BuildingDef[];
  /** The money side (tax formula, expenses, starting treasury). */
  readonly finance: EconomyFinanceConfig;
  /** Geography-driven minimum domestic production (§4). */
  readonly domesticBaseline: DomesticBaselineConfig;
  /** Country specialization multipliers over the baseline (§4). */
  readonly specialization: EconomySpecializationConfig;
  /** The 0-100 economy level that scales building production (§3). */
  readonly economyLevel: EconomyLevelConfig;
  /** Graded shortage → satisfaction penalties (§7). */
  readonly satisfaction: SatisfactionConfig;
  /** The strategic resources themselves (id, Persian name, base price). */
  readonly resources: readonly StrategicResourceDef[];
  /** Per-resource consumption drivers. */
  readonly consumption: Readonly<Record<string, ResourceConsumptionDef>>;
  /** Materials drawn from the stockpile per unit of equipment produced. */
  readonly militaryMaterials: Readonly<Record<string, number>>;
}
