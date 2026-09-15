/**
 * Economy state slice — treasuries, resource stockpiles, factories, region
 * infrastructure supply. Fully JSON-safe (save-friendly).
 */

import type { FactoryRecord } from '../../economy/types';

export interface EconomySlice {
  /** faction/country id → treasury amount. */
  treasury: Record<string, number>;
  /** faction/country id → resource id → amount. */
  stockpiles: Record<string, Record<string, number>>;
  /** factory instance id → record. */
  factories: Record<string, FactoryRecord>;
  /** region id → supply satisfaction ratio 0..1 (SupplySystem writes). */
  supply: Record<string, number>;
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
