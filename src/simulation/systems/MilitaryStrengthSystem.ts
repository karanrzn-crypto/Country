import type { SystemContext } from '../../core/GameContext';
import type { TickInfo } from '../../time/TimeSystem';
import type { SimulationSystemDef } from '../SimulationEngine';
import type { DataRegistry } from '../../data/DataRegistry';

const STRENGTH_INTERVAL_TICKS = 6;

interface UnitLike {
  readonly countryId: string;
  operationalState: string;
  soldiersCurrent: number;
  readonly soldiersMax: number;
  organization: number;
  readonly equipment: Readonly<Record<string, number>>;
}

/**
 * Military simulation — abstract (aggregated) level.
 *
 * Computes a per-country strength scalar from unit readiness and equipment
 * without touching any 3D representation. This is the "very far entity"
 * simulation tier: thousands of units can be processed cheaply. Detailed
 * per-unit combat runs in the CombatSystem for active regions only.
 */
export class MilitaryStrengthSystem implements SimulationSystemDef {
  readonly id = 'military_strength';

  tick(context: SystemContext, tick: TickInfo): void {
    if (tick.tick % STRENGTH_INTERVAL_TICKS !== 0) return;
    const { state, data } = context;
    const units = state.military.units as Record<string, UnitLike>;

    const totals: Record<string, number> = {};
    for (const unit of Object.values(units)) {
      if (unit.operationalState === 'destroyed') continue;
      const readiness =
        (unit.soldiersMax > 0 ? unit.soldiersCurrent / unit.soldiersMax : 0) * 0.6 +
        (unit.organization / 100) * 0.4;
      totals[unit.countryId] = (totals[unit.countryId] ?? 0) + readiness * unitPower(unit, data);
    }

    for (const [countryId, strength] of Object.entries(totals)) {
      state.military.strengthCache[countryId] = strength;
    }
  }
}

function unitPower(unit: UnitLike, data: DataRegistry): number {
  let power = 0;
  for (const [equipmentId, count] of Object.entries(unit.equipment)) {
    try {
      const def = data.equipment(equipmentId);
      power += (def.damage / 20 + def.armor / 40) * count;
    } catch {
      // Unknown equipment contributes nothing (data drift protection).
    }
  }
  return Math.max(1, power);
}
