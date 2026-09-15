import type { EntityId } from '../core/IdGenerator';
import type { DataRegistry } from '../data/DataRegistry';
import type { UnitRecord } from '../military/types';

/** Builds a runtime unit record from a data-driven unit type. */
export function createUnitFromType(
  data: DataRegistry,
  ids: { next(kind: string): EntityId },
  typeId: string,
  countryId: string,
  regionId: string | null
): UnitRecord {
  const unitType = data.unitType(typeId);
  const id = ids.next('unit');
  return {
    id,
    typeId,
    countryId,
    regionId,
    formationId: null,
    operationalState: 'idle',
    soldiersCurrent: unitType.soldiers,
    soldiersMax: unitType.soldiers,
    organization: unitType.organizationMax,
    equipment: { ...unitType.equipment }
  };
}
