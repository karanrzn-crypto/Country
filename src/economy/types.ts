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

/** Data-driven tuning of the strategic resource economy (economy.json). */
export interface StrategicResourcesConfig {
  /** Deposit quantity (1..100) → monthly production multiplier. */
  readonly productionScale: number;
  /** Fraction of the surplus offered on the market when exporting. */
  readonly exportShare: number;
  /** Import price multiplier over the base price (transport premium). */
  readonly importMarkup: number;
  /** The strategic resources themselves (id, Persian name, price). */
  readonly resources: readonly StrategicResourceDef[];
  /** Per-resource consumption drivers. */
  readonly consumption: Readonly<Record<string, ResourceConsumptionDef>>;
}
