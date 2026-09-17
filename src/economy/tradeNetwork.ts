/**
 * Global Trade Network (world-level trade resolution) — pure, deterministic.
 *
 * The trade simulation is a WORLD system, not a player service: EVERY country
 * participates with the SAME rules, and trades form between ANY two countries
 * with a real surplus on one side and a real shortage on the other — even
 * when the player is not involved at all.
 *
 * THE pipeline (run once per campaign month, from the state at the month's
 * start — never per frame):
 *
 *   Countries Production
 *     ↓
 *   Countries Consumption
 *     ↓
 *   Surplus / Shortage per country and resource
 *       surplus  = max(production − consumption, 0)   ← exportable
 *       shortage = max(consumption − production, 0)   ← import required
 *     ↓
 *   Global Supply (Σ surplus) & Global Demand (Σ shortage)
 *     ↓
 *   Match Exporters with Importers  (deterministic)
 *     ↓
 *   Trade Transactions (A → B, C → B, … — any pair)
 *     ↓
 *   Final balances + Unfilled Shortage (when global supply < global demand)
 *
 * Matching rules (deterministic, order-independent):
 *  - sellers: LARGEST surplus first (tie → country id);
 *  - buyers:  LARGEST shortage first (tie → country id) — the most urgent
 *    demand is served first when the world cannot cover everyone;
 *  - a seller's pool decrements as it sells (supply is never sold twice);
 *  - a country NEVER sells what it needs itself (only the true surplus is
 *    on the market) and NEVER buys what it produces (only the true shortage
 *    is bid).
 *
 * The market price tier comes from the GLOBAL supply/demand ratio
 * (market.marketTierFromSupplyDemand): abundant → cheap, scarce → expensive.
 *
 * LEAF-friendly: depends only on market types + utils. No state, no UI.
 */

import { marketTierFromSupplyDemand, type TradeTier } from './market';

/** One resolved trade transaction: `amount` units flow seller → buyer. */
export interface TradeFlow {
  readonly sellerId: string;
  readonly buyerId: string;
  readonly amount: number;
}

/** The resolved world trade of ONE resource across ALL countries. */
export interface ResourceTradeResult {
  /** The actual transactions (each pair appears once, amount > 0). */
  readonly flows: readonly TradeFlow[];
  /** buyerId → units actually bought (Σ over its flows). */
  readonly importsByBuyer: Readonly<Record<string, number>>;
  /** sellerId → units actually sold (Σ over its flows). */
  readonly exportsBySeller: Readonly<Record<string, number>>;
  /**
   * buyerId → units still missing AFTER the market cleared. Non-zero only
   * when the GLOBAL supply could not cover the GLOBAL demand (spec §7).
   */
  readonly unfilledByBuyer: Readonly<Record<string, number>>;
  /** Global market price tier of this resource (cheap / normal / expensive). */
  readonly marketTier: TradeTier;
  /** Σ surplus over all countries (the supply offered to the market). */
  readonly globalSupply: number;
  /** Σ shortage over all countries (the demand bid to the market). */
  readonly globalDemand: number;
}

/**
 * Resolves the world trade of ONE resource over ALL countries.
 * `countryIds` fixes the deterministic iteration base; all tie-breaks fall
 * back to country id so the result is independent of caller ordering.
 */
export function resolveWorldTradeForResource(
  countryIds: readonly string[],
  production: Readonly<Record<string, Readonly<Record<string, number>>>>,
  consumption: Readonly<Record<string, Readonly<Record<string, number>>>>,
  resourceId: string
): ResourceTradeResult {
  // —— stages 1–3: domestic balances (production first, consumption second) ——
  const surplusOf: Record<string, number> = {};
  const shortageOf: Record<string, number> = {};
  let globalSupply = 0;
  let globalDemand = 0;
  for (const countryId of countryIds) {
    const produced = production[countryId]?.[resourceId] ?? 0;
    const consumed = consumption[countryId]?.[resourceId] ?? 0;
    const surplus = Math.max(0, produced - consumed);
    const shortage = Math.max(0, consumed - produced);
    surplusOf[countryId] = surplus;
    shortageOf[countryId] = shortage;
    globalSupply += surplus;
    globalDemand += shortage;
  }

  const marketTier = marketTierFromSupplyDemand(globalSupply, globalDemand);

  // —— stage 5: match exporters with importers (deterministic) ——
  const sellers = countryIds
    .filter((countryId) => surplusOf[countryId] > 0)
    .sort((a, b) => surplusOf[b] - surplusOf[a] || (a < b ? -1 : 1));
  const buyers = countryIds
    .filter((countryId) => shortageOf[countryId] > 0)
    .sort((a, b) => shortageOf[b] - shortageOf[a] || (a < b ? -1 : 1));

  const remaining: Record<string, number> = { ...surplusOf }; // seller pool
  const importsByBuyer: Record<string, number> = {};
  const exportsBySeller: Record<string, number> = {};
  const unfilledByBuyer: Record<string, number> = {};
  const flows: TradeFlow[] = [];

  for (const buyerId of buyers) {
    let needed = shortageOf[buyerId];
    for (const sellerId of sellers) {
      if (needed <= 0) break;
      const spare = remaining[sellerId];
      if (spare <= 0) continue;
      const amount = Math.min(spare, needed);
      remaining[sellerId] = spare - amount;
      needed -= amount;
      importsByBuyer[buyerId] = (importsByBuyer[buyerId] ?? 0) + amount;
      exportsBySeller[sellerId] = (exportsBySeller[sellerId] ?? 0) + amount;
      flows.push({ sellerId, buyerId, amount });
    }
    if (needed > 0) unfilledByBuyer[buyerId] = needed;
  }

  return {
    flows,
    importsByBuyer,
    exportsBySeller,
    unfilledByBuyer,
    marketTier,
    globalSupply,
    globalDemand
  };
}
