/**
 * Military state slice — units, formations and the aggregated strength cache
 * written by the abstract-level military simulation.
 */

import type { FormationRecord, UnitRecord } from '../../military/types';

export interface MilitarySlice {
  units: Record<string, UnitRecord>;
  formations: Record<string, FormationRecord>;
  /** country id → aggregated combat strength (MilitaryStrengthSystem writes). */
  strengthCache: Record<string, number>;
}

export function liveUnits(slice: MilitarySlice): UnitRecord[] {
  return Object.values(slice.units).filter((unit) => unit.operationalState !== 'destroyed');
}

export function unitsOfCountry(slice: MilitarySlice, countryId: string): UnitRecord[] {
  return Object.values(slice.units).filter((unit) => unit.countryId === countryId);
}

export function unitsInRegion(slice: MilitarySlice, regionId: string): UnitRecord[] {
  return Object.values(slice.units).filter(
    (unit) => unit.regionId === regionId && unit.operationalState !== 'destroyed'
  );
}
