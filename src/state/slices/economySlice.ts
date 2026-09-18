/**
 * Economy state slice — treasuries, resource stockpiles, factories, region
 * infrastructure supply. Fully JSON-safe (save-friendly).
 *
 * TWO economies share this slice:
 *  - the LEGACY demo world (stockpiles/factories with the old faction ids);
 *  - the SIMPLE strategic economy (resources/finance/construction/buildings,
 *    keyed by strategic country ids — spec §1-§8).
 *
 * ONE writer per record family (spec §13 — no parallel systems):
 *  - resources  : runEconomyCycle (the monthly pass) + purchase/construction
 *  - finance    : runEconomyCycle (the money step applies to the treasury)
 *  - construction/buildings : the construction commands + the monthly step
 */

import type { FactoryRecord } from '../../economy/types';
// LEAF types module — importing from economy/resources here would close the
// cycle GameState → economySlice → resources → GameState (resources reads
// live GameState). The record SHAPE has no such dependency.
import type {
  CountryResourceState,
  CountryFinanceState,
  CountryConstructionState,
  BuildingRecord
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
   * The SIMPLE economy per strategic country id — the ONE resource truth:
   * stock / production / consumption / this month's trade / shortage.
   */
  resources: Record<string, CountryResourceState>;
  /**
   * The simple monthly money ledger per strategic country id (spec §3/§12):
   * مالیات + تجارت + کارخانه‌ها against ارتش + دولت + زیرساخت. The balance
   * lands on the treasury ONCE per month.
   */
  finance: Record<string, CountryFinanceState>;
  /**
   * Active construction projects per strategic country id (spec §8) — the
   * ONE-TIME money cost was paid at start; only build time remains.
   */
  construction: Record<string, CountryConstructionState>;
  /**
   * COMPLETED buildings per strategic country id: buildingId →
   * {typeId, cityId}. Each building adds its ONE effect (production or
   * income) to the monthly cycle.
   */
  buildings: Record<string, Record<string, BuildingRecord>>;
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
