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
import type { TradeContract, TradeRequest } from './resourceTypes';
import type { StrategicResourcesConfig } from './types';
import { safetyReserveUnits, stockHeadroomOf } from './resources';
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
 * — the physical spare stock above the safety reserve, with the capacity
 * already signed away in active export contracts subtracted:
 *
 *     stock − safety reserve − already committed export contracts
 *
 * The stock already nets this month's production and consumption (the
 * cycle lands them before trade), the SAFETY RESERVE keeps the domestic
 * buffer out of export reach (spec §5 — a country never sells the units
 * its own consumption needs). Whole units.
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
 * The PLAYER's country id — or null when no campaign country is confirmed
 * yet. The export-request rule keys off this: an AI can never SIGN a
 * contract that sells the player's goods; it must ASK (a TradeRequest the
 * president approves or rejects).
 */
export function playerCountryIdOf(state: GameState): string | null {
  return state.player.countryConfirmed ? state.player.countryId : null;
}

/**
 * The EXPORT CAPACITY of ONE country for ONE good (the sale-quantity
 * directive's raw material) — the physical spare stock above the safety
 * reserve PLUS the month's real PRODUCTION SURPLUS FLOW:
 *
 *     capacity = stock − reserve + max(0, production − consumption)
 *
 * The flow term is what makes a fresh-campaign market REAL (the stock-only
 * formula offered 0-1 units everywhere at month 0: starting stockpiles sit
 * exactly AT the safety buffer) and what makes the offers breathe — the
 * number moves from month to month with the seller's own production and
 * consumption. The flow can never OVER-commit: the monthly execution finds
 * the seller's spare AFTER this month's production landed, which is always
 * ≥ the flow-inclusive signing capacity. Whole units.
 */
export function exportCapacityOf(
  state: GameState,
  sellerId: string,
  resourceId: string,
  config: StrategicResourcesConfig
): number {
  const record = state.economy.resources[sellerId];
  if (record === undefined) return 0;
  const stock = Math.floor(record.stock[resourceId] ?? 0);
  const reserve = safetyReserveUnits(record.consumption, resourceId, config);
  const flow = Math.max(
    0,
    Math.round((record.production[resourceId] ?? 0) - (record.consumption[resourceId] ?? 0))
  );
  return Math.max(0, stock - reserve + flow);
}

/**
 * THE SALE QUOTA of ONE country for ONE good (the sale-quantity
 * directive §1/§2/§7) — the FIXED, LIMITED monthly amount the country
 * puts up for sale:
 *
 *     sale quota = floor(export capacity × market.saleQuotaShare)
 *
 * The number is computed from the SELLER'S OWN STATE alone (its stock,
 * its safety reserve, the config share) — a buyer's shortage or need can
 * never move it (§1: the seller decides what it sells, the buyer only
 * decides what it buys). What the country keeps back stays with the
 * country (§6 — the remainder is preserved for the seller and later
 * deals, it does not grow with demand).
 */
export function saleQuotaOf(
  state: GameState,
  sellerId: string,
  resourceId: string,
  config: StrategicResourcesConfig
): number {
  const share = Math.min(1, Math.max(0, config.market.saleQuotaShare));
  return Math.floor(exportCapacityOf(state, sellerId, resourceId, config) * share);
}

/**
 * The REMAINING sale offer of ONE seller for ONE good — the sale quota
 * minus the monthly amounts already committed in active contracts. THE
 * number the market shows and the ONLY capacity a new contract may claim
 * (§7 — no path may bypass the quota: Σ active commitments ≤ sale quota,
 * and the quota ≤ the real physical spare, so no delivery can exceed it).
 */
export function remainingSaleOfferOf(
  state: GameState,
  sellerId: string,
  resourceId: string,
  config: StrategicResourcesConfig
): number {
  return Math.max(0, saleQuotaOf(state, sellerId, resourceId, config) -
    committedExportUnitsOf(state, sellerId, resourceId));
}

/**
 * The MARKET OFFERS of ONE good (the sale-quantity directive + spec
 * §3/§18/§24): every OTHER country with a REMAINING sale offer, largest
 * first (tie → country id, deterministic). A country that is itself short,
 * holds no stock above its safety reserve, has already sold its quota, or
 * has already committed its surplus NEVER appears — the market cannot
 * invent sellers (§3) and the offers never depend on the buyer's shortage
 * (§1). Each offer is the seller's OWN fixed sale quantity.
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
    const amount = remainingSaleOfferOf(state, countryId, resourceId, config);
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

// —————— THE SPOT PURCHASE (the storage directive §2) ——————

export type SpotPurchaseResult =
  | { readonly ok: true; readonly amount: number; readonly cost: number }
  | {
      readonly ok: false;
      readonly reason:
        | 'unknown-resource'
        | 'unknown-country'
        | 'self-deal'
        | 'bad-amount'
        | 'no-capacity'
        | 'no-space'
        | 'no-funds';
    };

/**
 * ONE-TIME SPOT PURCHASE (the storage directive §2) — the buyer takes
 * `amount` units of the good from ONE seller's REAL stock NOW, pays the
 * base price once, and the units land in the buyer's warehouse for the
 * FUTURE (construction materials, lean months — buying is no longer
 * limited to this month's consumption). Guards (everything checked BEFORE
 * anything moves — negative stocks/treasuries are unrepresentable):
 *  - the good and both countries exist; a country never buys from itself;
 *  - the amount is a positive whole number;
 *  - the seller's REMAINING SALE OFFER covers the amount (the same quota
 *    the market displays — a spot deal can never bypass what the seller
 *    put up for sale);
 *  - the buyer's WAREHOUSE has space for the amount (stockpiling is
 *    bounded — خرید بی‌نهایت نیست);
 *  - the buyer can pay in full.
 *
 * Money moves directly (the ONE honest transfer — no ledger trade lines,
 * the same convention as the construction payment and the AI's material
 * deals: nothing is booked twice, §11/§13). The records' import/export
 * lines receive the units so the §12 view sees this month's real flows.
 */
export function executeSpotPurchase(
  state: GameState,
  buyerId: string,
  sellerId: string,
  resourceId: string,
  amountPerRequest: number,
  config: StrategicResourcesConfig
): SpotPurchaseResult {
  if (!config.resources.some((resource) => resource.id === resourceId)) {
    return { ok: false, reason: 'unknown-resource' };
  }
  if (sellerId === buyerId) return { ok: false, reason: 'self-deal' };
  if (
    state.economy.resources[buyerId] === undefined ||
    state.economy.resources[sellerId] === undefined ||
    state.economy.finance[buyerId] === undefined ||
    state.economy.finance[sellerId] === undefined
  ) {
    return { ok: false, reason: 'unknown-country' };
  }
  const amount = Math.floor(amountPerRequest);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: 'bad-amount' };
  if (remainingSaleOfferOf(state, sellerId, resourceId, config) < amount) {
    return { ok: false, reason: 'no-capacity' };
  }
  const buyerRecord = state.economy.resources[buyerId]!;
  if (stockHeadroomOf(buyerRecord, resourceId, config) < amount) {
    return { ok: false, reason: 'no-space' };
  }
  const price = unitPriceOf(config, resourceId);
  if (price <= 0) return { ok: false, reason: 'unknown-resource' };
  const cost = roundTo(amount * price, 2);
  if ((state.economy.treasury[buyerId] ?? 0) < cost) {
    return { ok: false, reason: 'no-funds' };
  }
  const sellerRecord = state.economy.resources[sellerId]!;
  // REAL units + REAL money move, exactly once (§10 — a purchase is a
  // transfer; the treasury is written HERE and never again for this deal).
  sellerRecord.stock[resourceId] =
    Math.max(0, Math.round((sellerRecord.stock[resourceId] ?? 0) - amount));
  buyerRecord.stock[resourceId] =
    Math.round((buyerRecord.stock[resourceId] ?? 0) + amount);
  state.economy.treasury[buyerId] = roundTo((state.economy.treasury[buyerId] ?? 0) - cost, 4);
  state.economy.treasury[sellerId] = roundTo((state.economy.treasury[sellerId] ?? 0) + cost, 4);
  buyerRecord.imports[resourceId] = Math.round((buyerRecord.imports[resourceId] ?? 0) + amount);
  sellerRecord.exports[resourceId] = Math.round((sellerRecord.exports[resourceId] ?? 0) + amount);
  return { ok: true, amount, cost };
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
        | 'no-funds'
        | 'player-seller-forbidden';
    };

/**
 * Signs ONE monthly trade contract (the sale-quantity directive + spec
 * §6/§16): `buyerId` commits to buying `amountPerMonth` units of the good
 * from `sellerId` EVERY month at the BASE price, until cancelled. Guards
 * (the seller's limit is checked AT SIGNING, and no other path can bypass
 * it):
 *  - the good and both countries exist; a country never contracts itself;
 *  - the amount is a positive whole number;
 *  - the seller's REMAINING SALE OFFER covers the new commitment (its
 *    fixed quota minus what active contracts already claim — a buyer's
 *    need never inflates it, and Σ commitments can never exceed the quota);
 *  - the buyer can pay the FIRST month's bill (money is checked again at
 *    every execution — a broke buyer simply receives less, §9);
 *  - THE PLAYER'S GOODS ARE NEVER SOLD WITHOUT CONSENT (the export-request
 *    directive §3): when the seller is the confirmed PLAYER country, only
 *    the export-request approval path ({@link approveExportRequest}, via
 *    `viaRequest`) may sign — an AI (or any other route) is refused with
 *    'player-seller-forbidden'.
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
  newId: (kind: string) => string,
  viaRequest = false
): SignContractResult {
  if (!config.resources.some((resource) => resource.id === resourceId)) {
    return { ok: false, reason: 'unknown-resource' };
  }
  if (sellerId === buyerId) return { ok: false, reason: 'self-contract' };
  const player = playerCountryIdOf(state);
  if (!viaRequest && sellerId === player) {
    return { ok: false, reason: 'player-seller-forbidden' };
  }
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
  if (remainingSaleOfferOf(state, sellerId, resourceId, config) < amount) {
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

// —————— THE FORMAL EXPORT REQUESTS (the export-request directive) ——————

export type RequestExportResult =
  | { readonly ok: true; readonly request: TradeRequest }
  | {
      readonly ok: false;
      readonly reason:
        | 'unknown-resource'
        | 'unknown-country'
        | 'self-request'
        | 'bad-amount'
        | 'no-capacity'
        | 'not-the-player'
        | 'duplicate'
        | 'cooldown';
    };

/**
 * Files ONE formal export request against the PLAYER's country (the
 * export-request directive §3): `buyerId` (an AI) asks `sellerId` (the
 * player) to sell `amountPerMonth` units monthly. Guards:
 *  - the good and both countries exist; never a self-request;
 *  - the SELLER IS THE CONFIRMED PLAYER country (AI-to-AI trade signs
 *    directly — the request flow exists for the president's consent);
 *  - the amount is positive AND ≤ the seller's REMAINING SALE OFFER
 *    (honest sizing — a request beyond the seller's quota is refused);
 *  - no PENDING duplicate for the same buyer+seller+good;
 *  - a REJECTED request for the same triple blocks re-asking for
 *    `market.requestCooldownMonths` (no monthly pestering).
 *
 * The request does NOT move anything — it waits for the president.
 */
export function requestExport(
  state: GameState,
  buyerId: string,
  sellerId: string,
  resourceId: string,
  amountPerMonth: number,
  month: number,
  config: StrategicResourcesConfig,
  newId: (kind: string) => string
): RequestExportResult {
  if (!config.resources.some((resource) => resource.id === resourceId)) {
    return { ok: false, reason: 'unknown-resource' };
  }
  if (sellerId === buyerId) return { ok: false, reason: 'self-request' };
  if (
    state.economy.resources[buyerId] === undefined ||
    state.economy.resources[sellerId] === undefined
  ) {
    return { ok: false, reason: 'unknown-country' };
  }
  if (sellerId !== playerCountryIdOf(state)) return { ok: false, reason: 'not-the-player' };
  const amount = Math.floor(amountPerMonth);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: 'bad-amount' };
  if (remainingSaleOfferOf(state, sellerId, resourceId, config) < amount) {
    return { ok: false, reason: 'no-capacity' };
  }
  const requests = state.economy.exportRequests ?? [];
  if (
    requests.some(
      (entry) =>
        entry.status === 'pending' &&
        entry.buyerId === buyerId &&
        entry.sellerId === sellerId &&
        entry.resourceId === resourceId
    )
  ) {
    return { ok: false, reason: 'duplicate' };
  }
  if (exportRequestCooldownActive(state, buyerId, sellerId, resourceId, month, config)) {
    return { ok: false, reason: 'cooldown' };
  }
  const request: TradeRequest = {
    id: newId('request'),
    buyerId,
    sellerId,
    resourceId,
    amountPerMonth: amount,
    price: unitPriceOf(config, resourceId),
    status: 'pending',
    createdAtMonth: month
  };
  state.economy.exportRequests.push(request);
  return { ok: true, request };
}

/**
 * TRUE while a REJECTED request for the same buyer+seller+good still holds
 * the cooldown (the president said no — the asking country waits
 * `market.requestCooldownMonths` before asking again).
 */
export function exportRequestCooldownActive(
  state: GameState,
  buyerId: string,
  sellerId: string,
  resourceId: string,
  month: number,
  config: StrategicResourcesConfig
): boolean {
  const cooldown = Math.max(0, Math.round(config.market.requestCooldownMonths));
  if (cooldown === 0) return false;
  return (state.economy.exportRequests ?? []).some(
    (entry) =>
      entry.status === 'rejected' &&
      entry.buyerId === buyerId &&
      entry.sellerId === sellerId &&
      entry.resourceId === resourceId &&
      month - (entry.decidedMonth ?? entry.createdAtMonth) < cooldown
  );
}

export type DecideRequestResult =
  | {
      readonly ok: true;
      readonly contract?: TradeContract;
      readonly reason?: 'no-capacity';
    }
  | { readonly ok: false; readonly reason: 'unknown-request' | 'not-pending' | 'sign-refused' };

/**
 * The president's DECISION on ONE export request (the export-request
 * directive §3). Approving re-checks the seller's remaining offer at the
 * decision month and signs the REAL monthly contract (`viaRequest` — the
 * only path that may sell the player's goods); if the seller's capacity
 * shrank below the requested amount the approval fails closed with
 * 'no-capacity' (no partial commitment is invented) — the request stays
 * pending so the president can reject it later. Rejecting settles the
 * request ('rejected') — nothing was ever created or moved.
 */
export function decideExportRequest(
  state: GameState,
  requestId: string,
  approve: boolean,
  month: number,
  config: StrategicResourcesConfig,
  newId: (kind: string) => string
): DecideRequestResult {
  const request = (state.economy.exportRequests ?? []).find((entry) => entry.id === requestId);
  if (request === undefined) return { ok: false, reason: 'unknown-request' };
  if (request.status !== 'pending') return { ok: false, reason: 'not-pending' };
  if (!approve) {
    request.status = 'rejected';
    request.decidedMonth = month;
    return { ok: true };
  }
  if (remainingSaleOfferOf(state, request.sellerId, request.resourceId, config) <
    request.amountPerMonth) {
    return { ok: true, reason: 'no-capacity' };
  }
  const signed = signContract(
    state,
    request.buyerId,
    request.sellerId,
    request.resourceId,
    request.amountPerMonth,
    month,
    config,
    newId,
    true
  );
  if (!signed.ok) return { ok: false, reason: 'sign-refused' };
  request.status = 'approved';
  request.decidedMonth = month;
  return { ok: true, contract: signed.contract };
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
    // THE WAREHOUSE (the storage directive §2): the buyer's free space caps
    // the delivery — a country may stockpile for the future, but the
    // warehouse fills up and then the delivery honestly shrinks to what
    // fits (the seller keeps the rest; the buyer pays only for what moved).
    const headroom = stockHeadroomOf(buyerRecord, contract.resourceId, config);
    const delivered = Math.max(
      0,
      Math.min(contract.amountPerMonth, spare, affordable, headroom)
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
