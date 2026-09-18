/**
 * Resource purchase (spec §6) — ONE explicit deal between the player and
 * a chosen seller. There is no "Buy Cheapest" system: the player sees the
 * available sellers (and their real free stock), picks one, and the deal
 * executes at the resource's BASE price (spec §7 — one price for buys and
 * sells, from the config, no supply/demand machinery):
 *
 *   buyer  : −(amount × price) money   +(amount) units
 *   seller : +(amount × price) money   −(amount) units
 *
 * The deal caps at the seller's FREE stock (above its safety reserve — a
 * country never sells the units its own consumption needs) and at the
 * buyer's money (nothing ever goes negative — spec §14).
 *
 * Pure function over GameState — the command facade calls `purchaseResource`.
 * Leaf module: state types + config only.
 */

import type { GameState } from '../state/GameState';
import type { StrategicResourcesConfig } from './types';
import { safetyReserveUnits } from './resources';
import { roundTo } from '../utils/math';

/** The BASE unit price of ONE resource (spec §7 — config, no tiers). */
export function unitPriceOf(config: StrategicResourcesConfig, resourceId: string): number {
  return config.resources.find((resource) => resource.id === resourceId)?.price ?? 0;
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
 * free stock and the buyer's money (never negative anywhere). Stock and
 * treasury move immediately; the deal's units and money also land on the
 * two countries' trade records, so the month's ledger shows the deal.
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
  const price = unitPriceOf(config, resourceId);
  const available = Math.floor(
    (sellerRecord.stock[resourceId] ?? 0) -
      safetyReserveUnits(sellerRecord.consumption, resourceId, config)
  );
  if (available <= 0) return { ok: false, reason: 'no-stock' };

  const money = state.economy.treasury[buyerId] ?? 0;
  const affordable = price > 0 ? Math.floor(money / price) : available;
  if (affordable <= 0) return { ok: false, reason: 'no-funds' };

  const amount = Math.max(0, Math.min(Math.floor(requestedAmount), available, affordable));
  if (amount <= 0) return { ok: false, reason: 'no-stock' };

  const cost = roundTo(amount * price, 2);

  // REAL units move: seller −, buyer + (the §10 cycle's trade step).
  sellerRecord.stock[resourceId] = Math.round((sellerRecord.stock[resourceId] ?? 0) - amount);
  buyerRecord.stock[resourceId] = Math.round((buyerRecord.stock[resourceId] ?? 0) + amount);

  // REAL money moves: the buyer pays, the seller receives (§6 exactly).
  state.economy.treasury[buyerId] = roundTo((state.economy.treasury[buyerId] ?? 0) - cost, 4);
  state.economy.treasury[sellerId] = roundTo((state.economy.treasury[sellerId] ?? 0) + cost, 4);

  // The deal shows up in BOTH countries' month ledger (تجارت line).
  buyerRecord.imports[resourceId] = Math.round((buyerRecord.imports[resourceId] ?? 0) + amount);
  sellerRecord.exports[resourceId] = Math.round((sellerRecord.exports[resourceId] ?? 0) + amount);
  buyerRecord.tradeExpense = roundTo(buyerRecord.tradeExpense + cost, 2);
  sellerRecord.tradeIncome = roundTo(sellerRecord.tradeIncome + cost, 2);

  return { ok: true, amount, cost, sellerId, resourceId };
}

/**
 * The sellers of ONE resource for the purchase panel: every country that
 * can actually spare units, largest first. The AVAILABLE amount is the
 * seller's stockpile above its safety reserve (spec §5 — a country never
 * sells the units its own consumption needs). These are the real,
 * buyable units.
 */
export function sellersOf(
  state: GameState,
  buyerId: string,
  resourceId: string,
  config: StrategicResourcesConfig
): { countryId: string; amount: number }[] {
  const sellers: { countryId: string; amount: number }[] = [];
  for (const [countryId, record] of Object.entries(state.economy.resources)) {
    if (countryId === buyerId) continue;
    const free = Math.floor(record.stock[resourceId] ?? 0) -
      safetyReserveUnits(record.consumption, resourceId, config);
    const amount = Math.max(0, free);
    if (amount > 0) sellers.push({ countryId, amount });
  }
  return sellers.sort((a, b) => b.amount - a.amount || (a.countryId < b.countryId ? -1 : 1));
}
