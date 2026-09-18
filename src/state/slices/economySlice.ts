/**
 * Economy state slice — treasuries, resource stockpiles, factories, region
 * infrastructure supply. Fully JSON-safe (save-friendly).
 *
 * TWO economies share this slice:
 *  - the LEGACY demo world (stockpiles/factories with the old faction ids);
 *  - the strategic resource economy (resources/finance/mines/research/
 *    construction/plants, keyed by strategic country ids).
 */

import type { FactoryRecord } from '../../economy/types';
// LEAF types module — importing from economy/resources here would close the
// cycle GameState → economySlice → resources → GameState (resources reads
// live GameState). The record SHAPE has no such dependency.
import type {
  CountryResourceState,
  CountryFinanceState,
  ResourceResearchState,
  CountryConstructionState,
  CountryPlant
} from '../../economy/resourceTypes';

export interface EconomySlice {
  /** faction/country id → treasury amount. */
  treasury: Record<string, number>;
  /** faction/country id → resource id → amount (LEGACY demo world only). */
  stockpiles: Record<string, Record<string, number>>;
  /** factory instance id → record (LEGACY demo world only). */
  factories: Record<string, FactoryRecord>;
  /** region id → supply satisfaction ratio 0..1 (SupplySystem writes). */
  supply: Record<string, number>;
  /**
   * Strategic resource economy per strategic country id — REAL stockpiles,
   * production from mines/baseline/factories, consumption, world-market
   * imports/exports. Written ONLY by recomputeResourceEconomies (never
   * hand-edited); `stock` is stepped by the same world pass.
   */
  resources: Record<string, CountryResourceState>;
  /**
   * The light monthly money ledger per strategic country id (spec §10):
   * Tax + Customs + Exports against the derived budget spending. Replaces
   * the old GDP/debt/inflation macro engine.
   */
  finance: Record<string, CountryFinanceState>;
  /**
   * Mine levels per deposit id (spec §12): depositId → level. Absent = 1.
   * Higher levels multiply the deposit's monthly production.
   */
  mines: Record<string, number>;
  /**
   * Resource research per strategic country id (spec §11): the highest
   * UNLOCKED mine level per resource branch. Absent resource = level 1.
   */
  research: Record<string, ResourceResearchState>;
  /**
   * Active construction projects per strategic country id (spec §4) —
   * resource costs paid month by month from the real stockpile.
   */
  construction: Record<string, CountryConstructionState>;
  /**
   * COMPLETED production factories per strategic country id: plantId →
   * {typeId, cityId}. Each plant boosts its resource's monthly production.
   */
  plants: Record<string, Record<string, CountryPlant>>;
}

export function addStockpile(
  stockpiles: Record<string, Record<string, number>>,
  ownerId: string,
  resourceId: string,
  amount: number
): void {
  const ownerStock = (stockpiles[ownerId] ??= {});
  ownerStock[resourceId] = (ownerStock[resourceId] ?? 0) + amount;
}

export function hasStockpile(
  stockpiles: Record<string, Record<string, number>>,
  ownerId: string,
  need: Readonly<Record<string, number>>
): boolean {
  const ownerStock = stockpiles[ownerId];
  if (ownerStock === undefined) return Object.keys(need).length === 0;
  return Object.entries(need).every(([resourceId, amount]) => (ownerStock[resourceId] ?? 0) >= amount);
}

export function consumeStockpile(
  stockpiles: Record<string, Record<string, number>>,
  ownerId: string,
  need: Readonly<Record<string, number>>
): void {
  const ownerStock = stockpiles[ownerId] ??= {};
  for (const [resourceId, amount] of Object.entries(need)) {
    ownerStock[resourceId] = (ownerStock[resourceId] ?? 0) - amount;
  }
}

export function totalPopulationOfCountry(
  populationByRegion: Readonly<Record<string, { population: number }>>,
  countryOfRegion: Readonly<Record<string, string>>,
  regionsOfCountry: readonly string[]
): number {
  let total = 0;
  for (const regionId of regionsOfCountry) {
    if (countryOfRegion[regionId] !== undefined) {
      total += populationByRegion[regionId]?.population ?? 0;
    }
  }
  return total;
}
