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
  /** Monthly units per 1B$ ANNUAL output of each sector. */
  readonly perBillionOutput?: Readonly<Record<string, number>>;
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
  /** Fraction of the surplus offered on the market when exporting. */
  readonly exportShare: number;
  /** Import price multiplier over the base price (transport premium). */
  readonly importMarkup: number;
  /** Tier pricing factors (supply side + demand side). */
  readonly priceTiers: PriceTiersConfig;
  /** Geography-driven minimum domestic production (spec §3). */
  readonly domesticBaseline: DomesticBaselineConfig;
  /** The strategic resources themselves (id, Persian name, price). */
  readonly resources: readonly StrategicResourceDef[];
  /** Per-resource consumption drivers. */
  readonly consumption: Readonly<Record<string, ResourceConsumptionDef>>;
}
