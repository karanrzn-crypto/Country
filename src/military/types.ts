/**
 * Military domain model — data-driven definitions (loaded from JSON) and
 * runtime records (stored in state slices). Leaf module.
 */

import type { EntityId } from '../core/IdGenerator';

export type FormationLevel = 'army' | 'corps' | 'division' | 'brigade' | 'battalion';

export interface FormationRecord {
  readonly id: EntityId;
  readonly name: string;
  readonly level: FormationLevel;
  readonly countryId: string;
  readonly parentId: EntityId | null;
  readonly commanderId: EntityId | null;
}

export type UnitOperationalState = 'idle' | 'moving' | 'inCombat' | 'retreating' | 'destroyed';

/** Runtime unit record — persisted in the military state slice. */
export interface UnitRecord {
  readonly id: EntityId;
  readonly typeId: string;
  readonly countryId: string;
  regionId: string | null;
  formationId: EntityId | null;
  operationalState: UnitOperationalState;
  soldiersCurrent: number;
  readonly soldiersMax: number;
  organization: number;
  readonly equipment: Readonly<Record<string, number>>;
}

/** Data-driven unit archetype (src/data/units.json). */
export interface UnitTypeDef {
  readonly id: string;
  readonly name: string;
  readonly category: 'infantry' | 'vehicle' | 'aircraft' | 'ship';
  readonly soldiers: number;
  readonly organizationMax: number;
  readonly supplyUsePerDay: number;
  readonly speedKmh: number;
  readonly equipment: Readonly<Record<string, number>>;
}

/** Data-driven equipment archetype (src/data/equipment.json). */
export interface EquipmentDef {
  readonly id: string;
  readonly name: string;
  readonly category: 'weapon' | 'vehicle' | 'aircraft' | 'ship' | 'support';
  readonly domain: 'ground' | 'air' | 'sea';
  readonly cost: number;
  readonly upkeepPerDay: number;
  readonly damage: number;
  readonly armorPen: number;
  readonly range: number;
  readonly accuracy: number;
  readonly cooldownTicks: number;
  readonly armor: number;
  readonly speedKmh: number;
}
