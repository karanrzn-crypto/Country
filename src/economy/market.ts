/**
 * Market pricing (spec §10) — SIMPLE, CONTROLLED, derived from GLOBAL numbers.
 *
 * The price tier of ONE resource is a WORLD-MARKET property, computed from
 * the global supply (Σ surplus) and global demand (Σ shortage):
 *
 *   Supply زیاد + Demand کم   → ratio ≫ 1 → cheap   (low)
 *   Supply و Demand متعادل    → ratio ≈ 1 → normal  (medium)
 *   Supply کم + Demand زیاد   → ratio ≪ 1 → expensive (high)
 *
 * Never random, never hand-set: the same thresholds serve the trade
 * matcher (tradeNetwork) and the UI helper below, so what the player
 * reads is exactly what the simulation bills.
 *
 * Pure LEAF module — no state, no UI.
 */

/** The THREE user-facing market price tiers (spec §10: Low/Normal/High). */
export type TradeTier = 'low' | 'medium' | 'high';

/** Supply/demand ratio thresholds: ≥ 1.25 glut → cheap, < 0.75 scarcity → dear. */
const TIER_GLUT_RATIO = 1.25;
const TIER_SCARCITY_RATIO = 0.75;

/**
 * The market price tier from GLOBAL supply and demand (units of one
 * resource, summed over every country). Edge cases:
 *  - no demand  → 'low'   (a glut nobody bids for is cheap);
 *  - no supply  → 'high'  (uncovered demand is scarce);
 *  - neither    → 'medium' (no trade — the neutral tier).
 */
export function marketTierFromSupplyDemand(globalSupply: number, globalDemand: number): TradeTier {
  if (globalDemand <= 0) return globalSupply > 0 ? 'low' : 'medium';
  if (globalSupply <= 0) return 'high';
  const ratio = globalSupply / globalDemand;
  if (ratio >= TIER_GLUT_RATIO) return 'low';
  if (ratio >= TIER_SCARCITY_RATIO) return 'medium';
  return 'high';
}

/**
 * UI-parity helper: the market price tier of ONE resource read straight
 * from the live resource records (production/consumption sums over the
 * candidate countries). Same math the trade matcher bills with.
 */
export function marketPriceTierOf(
  records: Readonly<Record<string, { production: Record<string, number>; consumption: Record<string, number> }>>,
  candidateIds: readonly string[],
  resourceId: string
): TradeTier {
  let supply = 0;
  let demand = 0;
  for (const countryId of candidateIds) {
    const record = records[countryId];
    if (record === undefined) continue;
    const balance = (record.production[resourceId] ?? 0) - (record.consumption[resourceId] ?? 0);
    if (balance > 0) supply += balance;
    else demand -= balance;
  }
  return marketTierFromSupplyDemand(supply, demand);
}
