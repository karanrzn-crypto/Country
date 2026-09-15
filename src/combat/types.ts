/**
 * Combat domain types. Combat is rendering-independent: no Three.js types,
 * no mesh handles — positions are chunk-grid coordinates only. The renderer
 * may later visualize these records, but combat logic never knows about it.
 */

import type { EntityId } from '../core/IdGenerator';

export interface CombatantView {
  readonly entityId: EntityId;
  readonly factionId: string;
  readonly regionId: string;
  readonly gx: number;
  readonly gz: number;
  /** 0..1 */
  readonly healthRatio: number;
  readonly power: number;
}

export type TargetingMode = 'nearest' | 'weakest' | 'strongest';

export interface HealthRecord {
  readonly entityId: EntityId;
  current: number;
  readonly max: number;
  destroyed: boolean;
}

export interface DamagePayload {
  readonly damage: number;
  readonly armorPen: number;
  readonly accuracy: number;
}
