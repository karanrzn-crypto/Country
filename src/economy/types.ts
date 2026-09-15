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
