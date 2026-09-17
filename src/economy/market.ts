/**
 * Market pricing (spec §4–§7) — SIMPLE, CONTROLLED, derived from REAL numbers.
 *
 *   Seller side:  surplus ↑ → supply ↑   → price tier ↓  (low = cheap)
 *   Buyer side:   shortage ↑ → demand ↑  → willingness to pay ↑ (high)
 *
 * A tier is never random and never hand-set: it is the country's NET spare
 * surplus (or uncovered deficit) of ONE resource relative to the LARGEST
 * holder of that resource on the live market:
 *
 *   ratio ≥ 0.60 → biggest holder tier (cheap seller / eager buyer)
 *   ratio ≥ 0.25 → middle tier
 *   otherwise    → smallest tier (expensive seller / reluctant buyer)
 *
 * Pure LEAF module over the JSON-safe resource records — no state, no UI.
 */

import type { CountryResourceState } from './resourceTypes';
import { roundTo } from '../utils/math';

/** The THREE user-facing trade price/demand tiers (spec §8). */
export type TradeTier = 'low' | 'medium' | 'high';

/** Tier thresholds relative to the largest holder's spare (spec §4 example:
 *  100 → low, 40 → medium, 10 → high when the max spare is 100). */
const TIER_LOW_RATIO = 0.6;
const TIER_MEDIUM_RATIO = 0.25;

/**
 * NET spare surplus ONE country could sell of ONE resource — what is left
 * of the surplus AFTER the units it already offered on the market. The UI
 * shows it as «موجود» and the tier math normalizes by it.
 */
export function spareSurplusOf(record: CountryResourceState, resourceId: string): number {
  const surplus = (record.production[resourceId] ?? 0) - (record.consumption[resourceId] ?? 0);
  const offered = record.exports[resourceId] ?? 0;
  return Math.max(0, roundTo(surplus - offered, 2));
}

/** Uncovered deficit ONE country wants to buy of ONE resource (its «نیاز»). */
export function unmetDeficitOf(record: CountryResourceState, resourceId: string): number {
  return Math.max(0, roundTo((record.consumption[resourceId] ?? 0) - (record.production[resourceId] ?? 0), 2));
}

function tierForRatio(ratio: number, big: TradeTier, middle: TradeTier, small: TradeTier): TradeTier {
  if (ratio >= TIER_LOW_RATIO) return big;
  if (ratio >= TIER_MEDIUM_RATIO) return middle;
  return small;
}

/**
 * Price tiers from RAW spare amounts (countryId → net spare surplus; entries
 * with spare ≤ 0 are not sellers and get no tier). Deterministic and
 * order-independent. The ONE threshold source both the recompute and the
 * record-based helpers below share.
 */
export function tiersFromSpares(spareById: Readonly<Record<string, number>>): Record<string, TradeTier> {
  let maxSpare = 0;
  for (const spare of Object.values(spareById)) {
    if (spare > maxSpare) maxSpare = spare;
  }
  const tiers: Record<string, TradeTier> = {};
  for (const [countryId, spare] of Object.entries(spareById)) {
    if (spare <= 0) continue;
    tiers[countryId] = tierForRatio(spare / maxSpare, 'low', 'medium', 'high');
  }
  return tiers;
}

/**
 * Seller price tiers of ONE resource across the candidate seller ids.
 * Deterministic and order-independent (max-based). Countries WITHOUT spare
 * are not sellers — they get no entry.
 */
export function sellerPriceTiersOf(
  records: Readonly<Record<string, CountryResourceState>>,
  candidateIds: readonly string[],
  resourceId: string
): Record<string, TradeTier> {
  const spares: Record<string, number> = {};
  for (const countryId of candidateIds) {
    const record = records[countryId];
    if (record === undefined) continue;
    const spare = spareSurplusOf(record, resourceId);
    if (spare > 0) spares[countryId] = spare;
  }
  return tiersFromSpares(spares);
}

/**
 * Buyer demand tiers from RAW deficit amounts (countryId → uncovered need;
 * need ≤ 0 entries are not buyers). Eager buyers (big deficit) pay more.
 */
export function demandTiersFromNeeds(needById: Readonly<Record<string, number>>): Record<string, BuyerDemand> {
  let maxNeed = 0;
  for (const need of Object.values(needById)) {
    if (need > maxNeed) maxNeed = need;
  }
  const demands: Record<string, BuyerDemand> = {};
  for (const [countryId, need] of Object.entries(needById)) {
    if (need <= 0) continue;
    demands[countryId] = { need, tier: tierForRatio(need / maxNeed, 'high', 'medium', 'low') };
  }
  return demands;
}

export interface BuyerDemand {
  /** Units the buyer is short of (its «نیاز»). */
  readonly need: number;
  /** Willingness to pay — eager buyers pay more (spec §6). */
  readonly tier: TradeTier;
}

/**
 * Buyer demand tiers of ONE resource across the candidate buyer ids.
 * Countries WITHOUT a deficit are not buyers — they get no entry.
 */
export function buyerDemandTiersOf(
  records: Readonly<Record<string, CountryResourceState>>,
  candidateIds: readonly string[],
  resourceId: string
): Record<string, BuyerDemand> {
  const needs: Record<string, number> = {};
  for (const countryId of candidateIds) {
    const record = records[countryId];
    if (record === undefined) continue;
    const need = unmetDeficitOf(record, resourceId);
    if (need > 0) needs[countryId] = need;
  }
  return demandTiersFromNeeds(needs);
}

/**
 * Average demand-tier factor over the given buyer needs — the market's
 * willingness to pay that an exporter receives per unit. No buyers →
 * neutral 1.0. Deterministic.
 */
export function demandFactorFromNeeds(
  needById: Readonly<Record<string, number>>,
  demandFactors: Readonly<Record<TradeTier, number>>
): number {
  const demands = Object.values(demandTiersFromNeeds(needById));
  if (demands.length === 0) return 1;
  const sum = demands.reduce((total, demand) => total + demandFactors[demand.tier], 0);
  return sum / demands.length;
}
