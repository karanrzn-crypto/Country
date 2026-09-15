/**
 * Population state slice — per-region population dynamics.
 */

export interface PopulationRegionRecord {
  population: number;
  capacity: number;
  lastGrowth: number;
}

export interface PopulationSlice {
  regions: Record<string, PopulationRegionRecord>;
}

export function totalPopulation(slice: PopulationSlice): number {
  let total = 0;
  for (const record of Object.values(slice.regions)) total += record.population;
  return total;
}
