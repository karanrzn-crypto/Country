/**
 * Resource purchase (spec §5/§6) — ONE explicit deal between the player and
 * a chosen seller. There is no "Buy Cheapest" system: the player sees the
 * available sellers (and their stock), picks one, and the deal executes —
 * real units leave the seller's stockpile and enter the buyer's, real money
 * moves (the price follows the global market tier; it may be shown when
 * selecting a seller, nothing more).
 *
 * Pure function over GameState — the command facade calls `purchaseResource`.
 * Leaf module: state types + config + market pricing only.
 */

import type { GameState } from '../state/GameState';
import type { StrategicResourcesConfig } from './types';
import { marketPriceTierOf } from './market';
import { roundTo } from '../utils/math';

/** The per-unit prices of ONE deal (what the UI may show on selection). */
export interface DealPrice {
  /** M$ per unit the buyer pays (base price × markup × tier factor). */
  readonly buyPerUnit: number;
  /** M$ per unit the seller receives (base price × tier factor). */
  readonly sellPerUnit: number;
}

/** The unit price of buying ONE resource from the world market right now. */
export function dealPriceOf(
  state: GameState,
  _buyerId: string,
  resourceId: string,
  config: StrategicResourcesConfig
): DealPrice {
  const price = config.resources.find((resource) => resource.id === resourceId)?.price ?? 0;
  const tier = marketPriceTierOf(state.economy.resources, Object.keys(state.economy.resources), resourceId);
  return {
    buyPerUnit: roundTo(price * config.importMarkup * config.priceTiers.supply[tier], 4),
    sellPerUnit: roundTo(price * config.priceTiers.demand[tier], 4)
  };
}

export type PurchaseResult =
  | {
      readonly ok: true;
      readonly amount: number;
      readonly cost: number;
      readonly sellerId: string;
      readonly resourceId: string;
    }
  | {
      readonly ok: false;
      readonly reason: 'unknown-resource' | 'unknown-seller' | 'self-sale' | 'no-stock' | 'no-funds';
    };

/**
 * Executes ONE purchase: the buyer's own country buys `amount` units of a
 * resource FROM a specific seller country. Caps the deal by the seller's
 * stock and the buyer's money (never negative anywhere). Stock and treasury
 * move immediately; the next world pass sees the new stockpiles.
 */
export function purchaseResource(
  state: GameState,
  buyerId: string,
  sellerId: string,
  resourceId: string,
  requestedAmount: number,
  config: StrategicResourcesConfig
): PurchaseResult {
  if (!config.resources.some((resource) => resource.id === resourceId)) {
    return { ok: false, reason: 'unknown-resource' };
  }
  if (sellerId === buyerId) return { ok: false, reason: 'self-sale' };
  const sellerRecord = state.economy.resources[sellerId];
  const buyerRecord = state.economy.resources[buyerId];
  if (sellerRecord === undefined || buyerRecord === undefined) {
    return { ok: false, reason: 'unknown-seller' };
  }
  const available = Math.floor(sellerRecord.stock[resourceId] ?? 0);
  if (available <= 0) return { ok: false, reason: 'no-stock' };

  const price = dealPriceOf(state, buyerId, resourceId, config);
  const money = state.economy.treasury[buyerId] ?? 0;
  const affordable = price.buyPerUnit > 0 ? Math.floor(money / price.buyPerUnit) : available;
  if (affordable <= 0) return { ok: false, reason: 'no-funds' };

  const amount = Math.max(0, Math.min(Math.floor(requestedAmount), available, affordable));
  if (amount <= 0) return { ok: false, reason: 'no-stock' };

  const cost = roundTo(amount * price.buyPerUnit, 2);
  const received = roundTo(amount * price.sellPerUnit, 2);

  // REAL stock moves: seller −, buyer + (the §17 cycle's "buy" step).
  sellerRecord.stock[resourceId] = available - amount;
  buyerRecord.stock[resourceId] = Math.round((buyerRecord.stock[resourceId] ?? 0) + amount);

  // REAL money moves: the buyer pays, the seller receives.
  state.economy.treasury[buyerId] = roundTo((state.economy.treasury[buyerId] ?? 0) - cost, 4);
  state.economy.treasury[sellerId] = roundTo((state.economy.treasury[sellerId] ?? 0) + received, 4);

  return { ok: true, amount, cost, sellerId, resourceId };
}

/**
 * The sellers of ONE resource for the purchase panel: every country that
 * currently has units in its stockpile, largest first. Amounts are REAL
 * stockpiles — what a seller actually owns (spec §5's example list).
 */
export function sellersOf(
  state: GameState,
  buyerId: string,
  resourceId: string
): { countryId: string; amount: number }[] {
  const sellers: { countryId: string; amount: number }[] = [];
  for (const [countryId, record] of Object.entries(state.economy.resources)) {
    if (countryId === buyerId) continue;
    const amount = Math.floor(record.stock[resourceId] ?? 0);
    if (amount > 0) sellers.push({ countryId, amount });
  }
  return sellers.sort((a, b) => b.amount - a.amount || (a.countryId < b.countryId ? -1 : 1));
}
