/**
 * Economy domain model — the SIMPLE economy (spec §1-§8): three resources
 * (غذا / آهن / نفت), one stockpile per country, one transparent monthly
 * cycle, base prices, money-paid construction. Leaf module.
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
 * One BUILDABLE building (spec §8) — exactly ONE main economic effect:
 *  - production: adds `output` monthly units of `resource` when complete;
 *  - income: adds `income` money to the monthly treasury balance.
 * The cost is ONE-TIME money, paid fully at start (never re-drawn).
 */
export interface BuildingDef {
  readonly id: string;
  readonly name: string;
  readonly effect: 'production' | 'income';
  /** Production buildings only: which resource this building produces. */
  readonly resource?: string;
  /** Production buildings only: monthly units added while active. */
  readonly output?: number;
  /** Income buildings only: monthly money added while active. */
  readonly income?: number;
  /** ONE-TIME money cost, deducted from the treasury at start. */
  readonly cost: number;
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

/** Data-driven tuning of the simple economy (economy.json). */
export interface StrategicResourcesConfig {
  /** Deposit quantity (1..100) → monthly production multiplier. */
  readonly productionScale: number;
  /** The stockpile every country starts the campaign with (units). */
  readonly startingStock: Readonly<Record<string, number>>;
  /** Anti-famine safety buffer (§5): months of consumption kept out of
   *  exports — food its own (larger) reserve, others `reserveMonths`. */
  readonly safetyBuffer: { readonly foodMonths: number; readonly reserveMonths: number };
  /** Display-status thresholds: a +1/month trickle is NOT a surplus. */
  readonly displayStatus: {
    readonly surplusBufferMonths: number;
    readonly minSurplusShare: number;
  };
  /** Concurrent construction cap. */
  readonly construction: { readonly maxProjects: number };
  /** The buildable buildings (spec §8 — one effect each). */
  readonly buildings: readonly BuildingDef[];
  /** The money side (tax formula, expenses, starting treasury). */
  readonly finance: EconomyFinanceConfig;
  /** Geography-driven minimum domestic production (§4). */
  readonly domesticBaseline: DomesticBaselineConfig;
  /** The strategic resources themselves (id, Persian name, base price). */
  readonly resources: readonly StrategicResourceDef[];
  /** Per-resource consumption drivers. */
  readonly consumption: Readonly<Record<string, ResourceConsumptionDef>>;
  /** Materials drawn from the stockpile per unit of equipment produced. */
  readonly militaryMaterials: Readonly<Record<string, number>>;
}
