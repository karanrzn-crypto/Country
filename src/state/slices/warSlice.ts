/**
 * War state slice — active wars between country coalitions.
 */

export interface WarRecord {
  readonly id: string;
  readonly attackers: readonly string[];
  readonly defenders: readonly string[];
  readonly startedTick: number;
  exhaustionPerDay: number;
}

export interface WarSlice {
  wars: Record<string, WarRecord>;
}

export function activeWarsInvolving(slice: WarSlice, countryId: string): WarRecord[] {
  return Object.values(slice.wars).filter(
    (war) => war.attackers.includes(countryId) || war.defenders.includes(countryId)
  );
}

export function areWarring(slice: WarSlice, a: string, b: string): boolean {
  return Object.values(slice.wars).some(
    (war) =>
      (war.attackers.includes(a) && war.defenders.includes(b)) ||
      (war.attackers.includes(b) && war.defenders.includes(a))
  );
}
