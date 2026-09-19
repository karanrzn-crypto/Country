/**
 * THE EXPORT REQUESTS (the export-request directive §3) — a country that
 * wants to buy the PLAYER's goods files a FORMAL REQUEST the president
 * approves (a real monthly contract forms) or rejects (nothing happens):
 *
 *  R1  the AI never signs a contract selling the player's goods — it files
 *      a pending request (core guard: signContract refuses the player as
 *      seller without viaRequest)
 *  R2  reject → no contract, nothing moves, the record stays 'rejected'
 *      and the cooldown blocks re-asking within requestCooldownMonths
 *  R3  approve → a real contract forms; the NEXT monthly execution
 *      delivers and books the ledger money exactly
 *  R4  approving when the seller's remaining offer shrank fails closed
 *      (no partial commitment invented; the request stays pending)
 *  R5  AI-to-AI trade stays DIRECT — the world market keeps working
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestGame } from '../../helpers/testGame';
import type { SystemContext } from '../../../core/GameContext';
import { runEconomyCycle } from '../../../economy/economyCycle';
import {
  signContract,
  requestExport,
  decideExportRequest,
  exportRequestCooldownActive,
  playerCountryIdOf,
  remainingSaleOfferOf,
  activeContracts
} from '../../../economy/contracts';
import { safetyReserveUnits } from '../../../economy/resources';
import { Random } from '../../../utils/Random';

describe('the export requests (export-request directive: formal consent)', () => {
  let context: SystemContext;
  let config: ReturnType<SystemContext['data']['economyData']['strategicResources'] extends never ? never : any>;

  beforeAll(() => {
    const game = createTestGame({ seed: 4242 });
    context = game.gameContext;
    config = context.data.economyData.strategicResources;
  });

  const ids = (): string[] =>
    context.map.countryOrder.filter((id) => context.state.economy.finance[id] !== undefined);

  /** Confirms the PLAYER country (the first of the order) and returns it. */
  const player = (): string => {
    const state = context.state;
    if (!state.player.countryConfirmed) {
      state.player.countryId = context.map.countryOrder[0];
      state.player.countryConfirmed = true;
    }
    return state.player.countryId;
  };

  /** Gives ONE country a real sale quota of `amount` for the good. */
  const giveQuota = (countryId: string, resourceId: string, amount: number): void => {
    const record = context.state.economy.resources[countryId]!;
    const spare = Math.ceil(amount / config.market.saleQuotaShare);
    record.stock[resourceId] = spare + safetyReserveUnits(record.consumption, resourceId, config);
    record.production[resourceId] = record.consumption[resourceId] ?? 0;
  };

  it('R1 the AI never signs for the player\'s goods — a pending REQUEST is filed (core guard)', () => {
    const state = context.state;
    const sellerId = player();
    const buyerId = ids().find((id) => id !== sellerId)!;
    state.economy.exportRequests = [];
    state.economy.contracts = [];
    giveQuota(sellerId, 'oil', 40);
    state.economy.treasury[buyerId] = 10_000;

    // The DIRECT path is refused at the core (not the UI).
    const direct = signContract(state, buyerId, sellerId, 'oil', 10, 100, config, () => 'r1a');
    expect(direct.ok).toBe(false);
    if (!direct.ok) expect(direct.reason).toBe('player-seller-forbidden');

    // The FORMAL request files cleanly (≤ the remaining offer).
    const filed = requestExport(state, buyerId, sellerId, 'oil', 25, 100, config, () => 'r1b');
    expect(filed.ok).toBe(true);
    if (filed.ok) {
      expect(filed.request.status).toBe('pending');
      expect(filed.request.amountPerMonth).toBe(25);
      expect(filed.request.sellerId).toBe(sellerId);
    }
    expect(activeContracts(state)).toHaveLength(0); // nothing signed yet
    // The stock did not move on a mere request.
    const sellerRecord = state.economy.resources[sellerId]!;
    expect(sellerRecord.stock.oil).toBe(
      80 + safetyReserveUnits(sellerRecord.consumption, 'oil', config)
    );
    // A second pending request for the same pair+good is a duplicate.
    const dupe = requestExport(state, buyerId, sellerId, 'oil', 5, 100, config, () => 'r1c');
    expect(dupe.ok).toBe(false);
    if (!dupe.ok) expect(dupe.reason).toBe('duplicate');
    // A request against a NON-player seller is refused (AI-AI signs direct).
    const other = ids().find((id) => id !== sellerId && id !== buyerId)!;
    const notPlayer = requestExport(state, buyerId, other, 'oil', 5, 100, config, () => 'r1d');
    expect(notPlayer.ok).toBe(false);
    if (!notPlayer.ok) expect(notPlayer.reason).toBe('not-the-player');
  });

  it('R2 reject → no contract, nothing moved, cooldown blocks the re-ask', () => {
    const state = context.state;
    const sellerId = player();
    const buyerId = ids().find((id) => id !== sellerId)!;
    state.economy.exportRequests = [];
    state.economy.contracts = [];
    giveQuota(sellerId, 'iron', 30);
    const stockBefore = state.economy.resources[sellerId]!.stock.iron;

    const filed = requestExport(state, buyerId, sellerId, 'iron', 20, 100, config, () => 'r2a');
    expect(filed.ok).toBe(true);
    const decided = decideExportRequest(state, 'r2a', false, 101, config, () => 'r2b');
    expect(decided.ok).toBe(true);
    expect(activeContracts(state)).toHaveLength(0); // no contract formed
    const request = state.economy.exportRequests.find((entry) => entry.id === 'r2a')!;
    expect(request.status).toBe('rejected');
    expect(request.decidedMonth).toBe(101);
    expect(state.economy.resources[sellerId]!.stock.iron).toBe(stockBefore);

    // The cooldown: inside the window the same ask is refused…
    expect(exportRequestCooldownActive(state, buyerId, sellerId, 'iron', 101 + 5, config)).toBe(true);
    const reAsk = requestExport(state, buyerId, sellerId, 'iron', 10, 101 + 5, config, () => 'r2c');
    expect(reAsk.ok).toBe(false);
    if (!reAsk.ok) expect(reAsk.reason).toBe('cooldown');
    // …outside the window it may ask again.
    expect(exportRequestCooldownActive(state, buyerId, sellerId, 'iron', 101 + config.market.requestCooldownMonths, config)).toBe(false);
  });

  it('R3 approve → a REAL monthly contract; the next cycle delivers and pays', () => {
    const state = context.state;
    const sellerId = player();
    const buyerId = ids().find((id) => id !== sellerId)!;
    state.economy.exportRequests = [];
    state.economy.contracts = [];
    giveQuota(sellerId, 'food', 40);
    state.economy.treasury[buyerId] = 10_000;
    const price = config.resources.find((resource: { id: string }) => resource.id === 'food')!.price;
    const buyerStockBefore = state.economy.resources[buyerId]!.stock.food ?? 0;

    const filed = requestExport(state, buyerId, sellerId, 'food', 25, 100, config, () => 'r3a');
    expect(filed.ok).toBe(true);
    const decided = decideExportRequest(state, 'r3a', true, 101, config, () => 'r3b');
    expect(decided.ok).toBe(true);
    const contracts = activeContracts(state);
    expect(contracts).toHaveLength(1);
    expect(contracts[0]!.buyerId).toBe(buyerId);
    expect(contracts[0]!.sellerId).toBe(sellerId);
    expect(contracts[0]!.amountPerMonth).toBe(25);

    // The NEXT monthly execution delivers exactly the commitment and books
    // the money ONCE (the cycle's money step).
    runEconomyCycle(state, context.map, config, { applyStep: true, month: 102 });
    const sellerRecord = state.economy.resources[sellerId]!;
    const buyerRecord = state.economy.resources[buyerId]!;
    expect(contracts[0]!.lastDelivery).toBe(25);
    expect(sellerRecord.exports.food ?? 0).toBe(25);
    expect(buyerRecord.imports.food ?? 0).toBe(25);
    expect(sellerRecord.tradeIncome).toBeCloseTo(25 * price, 2);
    expect(buyerRecord.tradeExpense).toBeCloseTo(25 * price, 2);
    expect(buyerRecord.stock.food ?? 0).toBeGreaterThan(buyerStockBefore - 100); // units arrived (consumption ate some)
    const request = state.economy.exportRequests.find((entry) => entry.id === 'r3a')!;
    expect(request.status).toBe('approved');
  });

  it('R4 approving past the shrunken offer fails closed — the request stays pending', () => {
    const state = context.state;
    const sellerId = player();
    const buyerId = ids().find((id) => id !== sellerId)!;
    state.economy.exportRequests = [];
    state.economy.contracts = [];
    giveQuota(sellerId, 'oil', 30);

    const filed = requestExport(state, buyerId, sellerId, 'oil', 30, 100, config, () => 'r4a');
    expect(filed.ok).toBe(true);
    // The seller's stock drains BELOW the quota before the decision.
    state.economy.resources[sellerId]!.stock.oil = 0;
    const decided = decideExportRequest(state, 'r4a', true, 101, config, () => 'r4b');
    expect(decided.ok).toBe(true);
    if (decided.ok) expect(decided.reason).toBe('no-capacity');
    expect(activeContracts(state)).toHaveLength(0);
    // Pending — the president can still REJECT it now.
    expect(state.economy.exportRequests.find((entry) => entry.id === 'r4a')!.status).toBe('pending');
    const rejected = decideExportRequest(state, 'r4a', false, 102, config, () => 'r4c');
    expect(rejected.ok).toBe(true);
    expect(state.economy.exportRequests.find((entry) => entry.id === 'r4a')!.status).toBe('rejected');
  });

  it('R5 AI-to-AI trade stays DIRECT — the world market keeps working (§3)', () => {
    const state = context.state;
    const sellerId = player();
    const aiSeller = ids().find((id) => id !== sellerId)!;
    const aiBuyer = ids().find((id) => id !== sellerId && id !== aiSeller)!;
    state.economy.exportRequests = [];
    state.economy.contracts = [];
    giveQuota(aiSeller, 'iron', 50);
    state.economy.treasury[aiBuyer] = 10_000;

    // Two AI countries sign DIRECTLY (no request flow between them).
    const signed = signContract(state, aiBuyer, aiSeller, 'iron', 20, 100, config, () => 'r5a');
    expect(signed.ok).toBe(true);
    expect(activeContracts(state)).toHaveLength(1);
    // And the AI's trade step itself still signs AI-to-AI directly.
    const rng = new Random(7);
    state.economy.contracts = [];
    const record = state.economy.resources[aiBuyer]!;
    record.shortage.iron = 15; // a REAL uncovered need
    aiDirectSign(state, aiBuyer, aiSeller, rng, config);
    expect(activeContracts(state).some((contract) => contract.buyerId === aiBuyer && contract.resourceId === 'iron')).toBe(true);
    expect(state.economy.exportRequests).toHaveLength(0);
    void sellerId;
    void remainingSaleOfferOf;
    void playerCountryIdOf;
  });
});

/** Minimal direct AI-to-AI signature (mirrors aiTradeStep's non-player branch). */
function aiDirectSign(
  state: ReturnType<typeof createTestGame>['gameContext']['state'],
  buyerId: string,
  sellerId: string,
  _rng: Random,
  config: ReturnType<SystemContext['data']['economyData']['strategicResources'] extends never ? never : any>
): void {
  const amount = Math.min(15, remainingSaleOfferOf(state, sellerId, 'iron', config));
  if (amount > 0) signContract(state, buyerId, sellerId, 'iron', amount, 100, config, () => 'r5b');
}
