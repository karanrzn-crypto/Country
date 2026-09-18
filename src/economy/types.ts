/**
 * Economy domain model — definitions (data-driven) and runtime records.
 * Leaf module.
 */

/** Data-driven resource definition (src/data/economy.json). */
export interface ResourceDef {
  readonly id: string;
  readonly name: string;
  readonly weight: number;
}

// ———————————————— resource-economy production factories (new model) ————————

/**
 * A BUILDABLE production factory (spec §4): costs resources to construct,
 * then boosts ONE resource's monthly production forever and consumes a small
 * upkeep amount of another resource (living demand → trade).
 */
export interface ProductionFactoryDef {
  readonly id: string;
  readonly name: string;
  /** The resource whose monthly production this factory boosts. */
  readonly boosts: string;
  /** Monthly units added to the boosted resource while active. */
  readonly output: number;
  /** Construction cost in resources (paid month by month during building). */
  readonly cost: Readonly<Record<string, number>>;
  /** Monthly upkeep in resources (consumption while active). */
  readonly upkeep: Readonly<Record<string, number>>;
}

/** Data-driven factory archetype (src/data/economy.json). */
export interface FactoryTypeDef {
  readonly id: string;
  readonly name: string;
  readonly inputs: Readonly<Record<string, number>>;
  readonly outputs: Readonly<Record<string, number>>;
  readonly cyclesPerDay: number;
  readonly workforce: number;
}

/** Runtime factory instance — persisted in the economy state slice. */
export interface FactoryRecord {
  readonly id: string;
  readonly typeId: string;
  readonly regionId: string;
  readonly ownerId: string;
  active: boolean;
  lastOutputAmount: number;
}

// ———————————————— strategic resource economy (HoI4-inspired, simple) ————————————————

/** One strategic resource of the country economy (data-driven, Persian name). */
export interface StrategicResourceDef {
  readonly id: string;
  /** Persian display name (UI renders it verbatim). */
  readonly name: string;
  /** Money (M$) per unit for the monthly import cost / export income. */
  readonly price: number;
}

/** Consumption drivers of ONE resource (data-driven calibration). */
export interface ResourceConsumptionDef {
  /** Monthly units per 1M population (food, housing wood …). */
  readonly perMillionPopulation?: number;
  /** Monthly units per operational military unit (fuel, equipment wear). */
  readonly perMilitaryUnit?: number;
}

// ———————————————— market pricing + domestic baseline (data-driven) ————————————————

/** Price multiplier of ONE trade tier (spec §7 — simple, controllable). */
export type TradeTierFactors = Readonly<Record<'low' | 'medium' | 'high', number>>;

/** Data-driven tier pricing (economy.json → strategicResources.priceTiers). */
export interface PriceTiersConfig {
  /** Seller-side: how much of the base price a tier charges (low < 1 < high). */
  readonly supply: TradeTierFactors;
  /** Buyer-side: how eager demand raises the received price (high > 1 > low). */
  readonly demand: TradeTierFactors;
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
  /** City-term multiplier (0 = cities never unlock this resource — gold). */
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

/** Data-driven tuning of the strategic resource economy (economy.json). */
export interface StrategicResourcesConfig {
  /** Deposit quantity (1..100) → monthly production multiplier. */
  readonly productionScale: number;
  /** Import price multiplier over the base price (transport premium). */
  readonly importMarkup: number;
  /** Customs (border trade) revenue as a fraction of the month's trade value. */
  readonly customsRate: number;
  /** Tier pricing factors (supply side + demand side). */
  readonly priceTiers: PriceTiersConfig;
  /** Mine level → production multiplier (1: 1.0, 2: 1.5, 3: 2.0 …). */
  readonly mineLevels: { readonly multipliers: Readonly<Record<string, number>> };
  /** Research: target mine level → unlock cost (M$). */
  readonly research: { readonly levels: Readonly<Record<string, number>> };
  /** Construction pacing: monthly progress fraction + concurrent-project cap. */
  readonly construction: { readonly monthlyRate: number; readonly maxProjects: number };
  /** Anti-famine safety buffer (spec §8.ز): months of consumption kept in reserve. */
  readonly safetyBuffer: { readonly foodMonths: number };
  /** The stockpile every country starts the campaign with (units per resource). */
  readonly startingStock: Readonly<Record<string, number>>;
  /** Geography-driven minimum domestic production (spec §3). */
  readonly domesticBaseline: DomesticBaselineConfig;
  /** The strategic resources themselves (id, Persian name, price). */
  readonly resources: readonly StrategicResourceDef[];
  /** Per-resource consumption drivers. */
  readonly consumption: Readonly<Record<string, ResourceConsumptionDef>>;
  /** Materials drawn from the stockpile per unit of equipment produced (§9). */
  readonly militaryMaterials: Readonly<Record<string, number>>;
  /** The buildable production factories (spec §4). */
  readonly productionFactories: readonly ProductionFactoryDef[];
}
