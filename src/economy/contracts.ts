/**
 * THE TRADE CONTRACTS (spec §6-§10/§15-§18/§21/§23/§24) — the ONE trade
 * path of the economy. Trade between countries is a permanent MONTHLY
 * CONTRACT, never a one-time purchase and never an automatic matcher:
 *
 *   Market Offer  (پیشنهاد فروش)  — a country's REAL available surplus,
 *                                   derived live from its own state (§24):
 *
 *     available surplus = stock − safety reserve − committed exports
 *
 *     The buyer's shortage NEVER shapes an offer (§1) — a country with no
 *     real surplus simply does not appear on the market (§3), and a
 *     country with surplus may serve MANY buyers (§17).
 *
 *   Trade Contract (قرارداد تجاری) — the president signs with a chosen
 *                                   seller: X units / month at the BASE
 *                                   price, permanent until cancelled
 *                                   (§6/§18). Signing RESERVES the
 *                                   seller's export capacity (§16).
 *
 * The monthly execution (economyCycle step ۴ — spec §12's «دریافت
 * قراردادهای وارداتی») moves REAL units from the seller's stock to the
 * buyer's stock and books REAL ledger money — nothing is created out of
 * thin air (§10/§21): when the seller's stock runs short, the delivery is
 * HONESTLY partial (§9) and the buyer's shortage stays real (§15).
 *
 * Money: deliveries book ledger lines (tradeIncome/tradeExpense); the
 * treasury is written ONCE per month by the cycle's money step — never
 * here (one write, no double-count).
 *
 * Leaf module: state types + config + utils only. Unit-testable without a
 * system harness.
 */

import type { GameState } from '../state/GameState';
import type { TradeContract } from './resourceTypes';
import type { StrategicResourcesConfig } from './types';
import { safetyReserveUnits } from './resources';
import { roundTo } from '../utils/math';

/** The BASE unit price of ONE resource (spec §7 — config, no tiers). */
export function unitPriceOf(config: StrategicResourcesConfig, resourceId: string): number {
  return config.resources.find((resource) => resource.id === resourceId)?.price ?? 0;
}

/** Every ACTIVE contract of the world (cancelled ones never execute). */
export function activeContracts(state: GameState): TradeContract[] {
  return (state.economy.contracts ?? []).filter((contract) => contract.status === 'active');
}

/**
 * The export capacity ONE seller has already RESERVED through active
 * contracts (spec §16): the sum of its monthly commitments for ONE good.
 * This is what keeps a 100-surplus country from signing three 100/month
 * contracts (§16's exact example).
 */
export function committedExportUnitsOf(
  state: GameState,
  sellerId: string,
  resourceId: string
): number {
  let committed = 0;
  for (const contract of activeContracts(state)) {
    if (contract.sellerId === sellerId && contract.resourceId === resourceId) {
      committed += contract.amountPerMonth;
    }
  }
  return committed;
}

/**
 * The REAL AVAILABLE SURPLUS of ONE country for ONE good (spec §2/§3/§24)
 * — the ONLY number that may appear as a market offer or back a new
 * contract:
 *
 *     stock − safety reserve − already committed export contracts
 *
 * The stock already nets this month's production and consumption (the
 * cycle lands them before trade), the SAFETY RESERVE keeps the domestic
 * buffer out of export reach (spec §5 — a country never sells the units
 * its own consumption needs), and the committed exports subtract the
 * capacity signed away in active contracts (§16). Whole units.
 */
export function availableSurplusOf(
  state: GameState,
  sellerId: string,
  resourceId: string,
  config: StrategicResourcesConfig
): number {
  const record = state.economy.resources[sellerId];
  if (record === undefined) return 0;
  const spare =
    Math.floor(record.stock[resourceId] ?? 0) -
    safetyReserveUnits(record.consumption, resourceId, config) -
    committedExportUnitsOf(state, sellerId, resourceId);
  return Math.max(0, spare);
}

/**
 * The MARKET OFFERS of ONE good (spec §3/§18/§24): every OTHER country
 * with a REAL available surplus, largest offer first (tie → country id,
 * deterministic). A country that is itself short, holds no stock above its
 * safety reserve, or has already committed its surplus NEVER appears —
 * the market cannot invent sellers (§3) and the offers never depend on
 * the buyer's shortage (§1).
 */
export function marketOffersOf(
  state: GameState,
  buyerId: string,
  resourceId: string,
  config: StrategicResourcesConfig
): { countryId: string; amount: number }[] {
  const offers: { countryId: string; amount: number }[] = [];
  for (const countryId of Object.keys(state.economy.resources)) {
    if (countryId === buyerId) continue;
    const amount = availableSurplusOf(state, countryId, resourceId, config);
    if (amount > 0) offers.push({ countryId, amount });
  }
  return offers.sort((a, b) => b.amount - a.amount || (a.countryId < b.countryId ? -1 : 1));
}

/** All ACTIVE contracts where `countryId` is the buyer or the seller. */
export function activeContractsOf(state: GameState, countryId: string): TradeContract[] {
  return activeContracts(state).filter(
    (contract) => contract.buyerId === countryId || contract.sellerId === countryId
  );
}

/** TRUE when `countryId` already holds an ACTIVE IMPORT contract for the
 *  good (§23 — the existing contract continues; never stack duplicates). */
export function hasActiveImportContract(
  state: GameState,
  buyerId: string,
  resourceId: string
): boolean {
  return activeContracts(state).some(
    (contract) => contract.buyerId === buyerId && contract.resourceId === resourceId
  );
}

export type SignContractResult =
  | { readonly ok: true; readonly contract: TradeContract }
  | {
      readonly ok: false;
      readonly reason:
        | 'unknown-resource'
        | 'unknown-country'
        | 'self-contract'
        | 'bad-amount'
        | 'no-capacity'
        | 'no-funds';
    };

/**
 * Signs ONE monthly trade contract (spec §6/§16): `buyerId` commits to
 * buying `amountPerMonth` units of the good from `sellerId` EVERY month at
 * the BASE price, until cancelled. Guards (§16 — capacity is checked AT
 * SIGNING):
 *  - the good and both countries exist; a country never contracts itself;
 *  - the amount is a positive whole number;
 *  - the seller's REAL available surplus covers the new commitment
 *    (stock − reserve − already committed exports ≥ amount, §16/§17);
 *  - the buyer can pay the FIRST month's bill (money is checked again at
 *    every execution — a broke buyer simply receives less, §9).
 *
 * The contract starts ACTIVE; its FIRST delivery arrives in the next
 * monthly cycle (§12's order — a mid-month signature commits the FUTURE
 * months).
 */
export function signContract(
  state: GameState,
  buyerId: string,
  sellerId: string,
  resourceId: string,
  amountPerMonth: number,
  month: number,
  config: StrategicResourcesConfig,
  newId: (kind: string) => string
): SignContractResult {
  if (!config.resources.some((resource) => resource.id === resourceId)) {
    return { ok: false, reason: 'unknown-resource' };
  }
  if (sellerId === buyerId) return { ok: false, reason: 'self-contract' };
  if (
    state.economy.resources[buyerId] === undefined ||
    state.economy.resources[sellerId] === undefined ||
    state.economy.finance[buyerId] === undefined ||
    state.economy.finance[sellerId] === undefined
  ) {
    return { ok: false, reason: 'unknown-country' };
  }
  const amount = Math.floor(amountPerMonth);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: 'bad-amount' };
  if (availableSurplusOf(state, sellerId, resourceId, config) < amount) {
    return { ok: false, reason: 'no-capacity' };
  }
  const price = unitPriceOf(config, resourceId);
  if (price <= 0) return { ok: false, reason: 'unknown-resource' };
  if ((state.economy.treasury[buyerId] ?? 0) < roundTo(amount * price, 2)) {
    return { ok: false, reason: 'no-funds' };
  }
  const contract: TradeContract = {
    id: newId('contract'),
    sellerId,
    buyerId,
    resourceId,
    amountPerMonth: amount,
    price,
    status: 'active',
    createdAtMonth: month,
    lastDelivery: 0
  };
  state.economy.contracts.push(contract);
  return { ok: true, contract };
}

export type CancelResult = 'ok' | 'unknown-contract' | 'not-a-party' | 'already-cancelled';

/**
 * Cancels ONE contract (spec §7): either contracting party may walk away;
 * from the NEXT monthly execution on, the delivery is zero (§6 — the
 * contract runs until cancelled). The record STAYS in the state (the
 * قراردادها panel shows the history, §8 — read from the real State).
 */
export function cancelContract(
  state: GameState,
  contractId: string,
  countryId: string,
  month: number
): CancelResult {
  const contract = (state.economy.contracts ?? []).find((entry) => entry.id === contractId);
  if (contract === undefined) return 'unknown-contract';
  if (contract.buyerId !== countryId && contract.sellerId !== countryId) return 'not-a-party';
  if (contract.status !== 'active') return 'already-cancelled';
  contract.status = 'cancelled';
  contract.cancelledMonth = month;
  return 'ok';
}

/**
 * THE MONTHLY EXECUTION (spec §9/§12 — step ۴ «دریافت قراردادهای وارداتی»)
 * — runs INSIDE the cycle, between production and consumption, so a
 * month's deliveries are REAL SUPPLY of that month (§15):
 *
 *  ۱. find the ACTIVE contracts (deterministic: oldest first, tie → id);
 *  ۲. check the seller really holds the good — each seller's spare is its
 *     stock above the safety reserve, computed ONCE and drawn down by
 *     every delivery (Σ deliveries ≤ real spare, §16/§21);
 *  ۳. check the buyer's money — one running import budget per buyer
 *     (its treasury; M13's honesty, never negative);
 *  ۴. deliver EXACTLY min(commitment, spare, affordable) — a shortfall is
 *     NEVER faked (§9: contract 100 / seller 60 → delivered 60);
 *  ۵. move the units seller → buyer, book the ledger lines (the treasury
 *     itself is written ONCE by the cycle's money step);
 *  ۶. contracts whose countries vanished are auto-cancelled (§18's
 *     «دیگر قابل اجرا نباشد»).
 *
 * This step ALSO resets the records' trade lines (imports/exports/
 * tradeIncome/tradeExpense) — the ONE monthly reset, so a record always
 * holds THIS month's contract deliveries.
 */
export function executeMonthlyContracts(
  state: GameState,
  order: readonly string[],
  config: StrategicResourcesConfig,
  month: number
): void {
  // ONE monthly reset of the trade lines (§11 — no stale accumulations).
  for (const countryId of order) {
    const record = state.economy.resources[countryId];
    if (record !== undefined) {
      record.tradeIncome = 0;
      record.tradeExpense = 0;
      record.imports = {};
      record.exports = {};
    }
  }
  const resourceRank = new Map<string, number>(
    config.resources.map((resource, index) => [resource.id, index] as const)
  );
  const contracts = activeContracts(state).sort(
    (a, b) =>
      // ESSENTIALS FIRST (spec §12 — config resource order): a buyer's ONE
      // running import budget settles its food before its luxuries, so an
      // old industrial contract can never starve a food contract.
      (resourceRank.get(a.resourceId) ?? config.resources.length) -
        (resourceRank.get(b.resourceId) ?? config.resources.length) ||
      // Within ONE good: the oldest commitment is served first (FIFO).
      a.createdAtMonth - b.createdAtMonth ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );

  // Each seller's REAL spare stock above its reserve — computed ONCE and
  // drawn down delivery by delivery (the total can never exceed it).
  // Each buyer's running import budget — its REAL treasury (M13).
  const sellerSpare = new Map<string, Map<string, number>>();
  const importBudget = new Map<string, number>();
  for (const countryId of order) {
    const record = state.economy.resources[countryId];
    if (record === undefined) continue;
    const spareMap = new Map<string, number>();
    for (const resourceId of Object.keys(record.stock)) {
      spareMap.set(
        resourceId,
        Math.max(
          0,
          Math.floor(record.stock[resourceId] ?? 0) -
            safetyReserveUnits(record.consumption, resourceId, config)
        )
      );
    }
    sellerSpare.set(countryId, spareMap);
    importBudget.set(countryId, Math.max(0, state.economy.treasury[countryId] ?? 0));
  }

  for (const contract of contracts) {
    const sellerRecord = state.economy.resources[contract.sellerId];
    const buyerRecord = state.economy.resources[contract.buyerId];
    // A country that no longer exists (annexed, deleted) ends the contract
    // (§18 — a contract that cannot execute is not kept alive artificially).
    if (sellerRecord === undefined || buyerRecord === undefined) {
      contract.status = 'cancelled';
      contract.cancelledMonth = month;
      continue;
    }
    const spareMap = sellerSpare.get(contract.sellerId);
    const spare = spareMap?.get(contract.resourceId) ?? 0;
    if (spare <= 0) {
      contract.lastDelivery = 0; // the seller holds nothing above its reserve
      continue;
    }
    const budget = importBudget.get(contract.buyerId) ?? 0;
    const affordable = contract.price > 0 ? Math.floor(budget / contract.price) : contract.amountPerMonth;
    const delivered = Math.max(
      0,
      Math.min(contract.amountPerMonth, spare, affordable)
    );
    if (delivered <= 0) {
      contract.lastDelivery = 0;
      continue;
    }
    const cost = roundTo(delivered * contract.price, 2);
    // REAL units move: seller −, buyer + (§10 — a contract is a transfer).
    sellerRecord.stock[contract.resourceId] =
      Math.round((sellerRecord.stock[contract.resourceId] ?? 0) - delivered);
    buyerRecord.stock[contract.resourceId] =
      Math.round((buyerRecord.stock[contract.resourceId] ?? 0) + delivered);
    // The seller's spare draws down; the buyer's budget too.
    spareMap!.set(contract.resourceId, spare - delivered);
    importBudget.set(contract.buyerId, roundTo(budget - cost, 2));
    // Ledger lines — the cycle's money step applies them ONCE (step ۷).
    buyerRecord.imports[contract.resourceId] =
      Math.round((buyerRecord.imports[contract.resourceId] ?? 0) + delivered);
    sellerRecord.exports[contract.resourceId] =
      Math.round((sellerRecord.exports[contract.resourceId] ?? 0) + delivered);
    buyerRecord.tradeExpense = roundTo(buyerRecord.tradeExpense + cost, 2);
    sellerRecord.tradeIncome = roundTo(sellerRecord.tradeIncome + cost, 2);
    contract.lastDelivery = delivered;
  }
}
