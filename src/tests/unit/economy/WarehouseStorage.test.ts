/**
 * THE WAREHOUSE / STORAGE (the storage directive §2) — countries may buy
 * MORE than this month's consumption (stockpiling for construction and the
 * future) but never beyond the warehouse:
 *
 *  W1  the capacity formula: months × the country's own consumption, with
 *      the absolute floor for tiny countries, and the headroom = capacity −
 *      stock (the ONE number every buyer path reads);
 *  W2  the ONE-TIME SPOT PURCHASE moves real units + real money exactly
 *      once, bounded by the seller's displayed quota, the WAREHOUSE space
 *      and full payment — and refuses every dishonest request;
 *  W3  the MONTHLY CONTRACT delivery is capped by the buyer's free
 *      warehouse space — a full warehouse receives nothing (honestly);
 *  W4  the AI gathers for the FUTURE (no shortage + rich treasury → a
 *      bounded stockpile purchase, never from the player, never over the
 *      warehouse).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestGame } from '../../helpers/testGame';
import type { SystemContext } from '../../../core/GameContext';
import type { StrategicResourcesConfig } from '../../../economy/types';
import { executeMonthlyContracts, executeSpotPurchase, signContract, remainingSaleOfferOf } from '../../../economy/contracts';
import { safetyReserveUnits, stockHeadroomOf, warehouseCapacityOf } from '../../../economy/resources';
import { aiTradeStep } from '../../../economy/aiEconomy';
import type { Random } from '../../../utils/Random';

/** A fully-cooperative rng stub (every chance fires, deterministic picks). */
const yesRng = {
  chance: () => true,
  next: () => 0,
  int: () => 0
} as unknown as Random;

describe('the warehouse / storage (storage directive §2)', () => {
  let context: SystemContext;
  let config: StrategicResourcesConfig;

  beforeAll(() => {
    const game = createTestGame({ seed: 909 });
    context = game.gameContext;
    config = context.data.economyData.strategicResources;
  });

  const ids = (): string[] =>
    context.map.countryOrder.filter((id) => context.state.economy.finance[id] !== undefined);

  it('W1 capacity = max(months × consumption, floor); headroom = capacity − stock', () => {
    const state = context.state;
    const record = state.economy.resources[ids()[0]]!;
    // A 100/mo oil consumer has an 800-unit warehouse (8 months)…
    record.consumption.oil = 100;
    record.stock.oil = 0;
    expect(warehouseCapacityOf(record.consumption, 'oil', config)).toBe(800);
    expect(stockHeadroomOf(record, 'oil', config)).toBe(800);
    // …the floor protects small consumers (industrial 20/mo → 160 < 600).
    record.consumption.industrial = 20;
    record.stock.industrial = 100;
    expect(warehouseCapacityOf(record.consumption, 'industrial', config)).toBe(600);
    expect(stockHeadroomOf(record, 'industrial', config)).toBe(500);
    // A full warehouse has NO headroom, and the stock never goes negative.
    record.stock.oil = 900;
    expect(stockHeadroomOf(record, 'oil', config)).toBe(0);
  });

  it('W2 the spot purchase moves real units + real money ONCE, bounded honestly', () => {
    const state = context.state;
    state.economy.contracts = [];
    const order = ids();
    const sellerId = order[0];
    const buyerId = order[1];
    // The seller puts real spare up for sale (quota 250 at share 0.5).
    const seller = state.economy.resources[sellerId]!;
    seller.stock.oil = 500 + safetyReserveUnits(seller.consumption, 'oil', config);
    seller.production.oil = seller.consumption.oil ?? 0; // neutralize the flow term
    const offer = remainingSaleOfferOf(state, sellerId, 'oil', config);
    expect(offer).toBe(250);
    // The buyer has an empty warehouse (oil: capacity = 8 × 50 = 400).
    const buyer = state.economy.resources[buyerId]!;
    buyer.stock.oil = 0;
    buyer.consumption.oil = 50;
    state.economy.treasury[buyerId] = 10_000;
    const price = config.resources.find((resource) => resource.id === 'oil')!.price;
    const treasuryBefore = state.economy.treasury[buyerId]!;
    const sellerTreasuryBefore = state.economy.treasury[sellerId]!;

    // Buying within every bound works — units and money move exactly once.
    const ok = executeSpotPurchase(state, buyerId, sellerId, 'oil', 200, config);
    expect(ok).toEqual({ ok: true, amount: 200, cost: 200 * price });
    expect(buyer.stock.oil).toBe(200);
    expect(seller.stock.oil).toBe(300 + safetyReserveUnits(seller.consumption, 'oil', config));
    expect(state.economy.treasury[buyerId]).toBeCloseTo(treasuryBefore - 200 * price, 4);
    expect(state.economy.treasury[sellerId]).toBeCloseTo(sellerTreasuryBefore + 200 * price, 4);
    expect(buyer.imports.oil).toBe(200);
    expect(seller.exports.oil).toBe(200);

    // The quota recomputed from the seller's REDUCED stock: capacity 300 →
    // quota 150. A 500 request is refused (nothing moves).
    expect(executeSpotPurchase(state, buyerId, sellerId, 'oil', 500, config)).toEqual({
      ok: false,
      reason: 'no-capacity'
    });
    // A 100 request fits the remaining quota — it goes through…
    const second = executeSpotPurchase(state, buyerId, sellerId, 'oil', 100, config);
    expect(second).toEqual({ ok: true, amount: 100, cost: 100 * price });
    expect(buyer.stock.oil).toBe(300);
    // …and when the seller is left with NOTHING above its safety reserve,
    // even 1 unit is refused — the market cannot sell what does not exist.
    seller.stock.oil = safetyReserveUnits(seller.consumption, 'oil', config); // spare 0
    expect(executeSpotPurchase(state, buyerId, sellerId, 'oil', 1, config)).toEqual({
      ok: false,
      reason: 'no-capacity'
    });
    // THE WAREHOUSE: a full tank farm refuses even a quota-backed request.
    buyer.stock.oil = 400; // exactly AT capacity → headroom 0
    seller.stock.oil = 1_000 + safetyReserveUnits(seller.consumption, 'oil', config);
    expect(executeSpotPurchase(state, buyerId, sellerId, 'oil', 50, config)).toEqual({
      ok: false,
      reason: 'no-space'
    });
    // A broken buyer cannot buy, and nobody trades with themselves.
    state.economy.treasury[buyerId] = 0;
    buyer.stock.oil = 0;
    expect(executeSpotPurchase(state, buyerId, sellerId, 'oil', 50, config)).toEqual({
      ok: false,
      reason: 'no-funds'
    });
    expect(executeSpotPurchase(state, buyerId, buyerId, 'oil', 1, config)).toEqual({
      ok: false,
      reason: 'self-deal'
    });
  });

  it('W3 a full warehouse caps the monthly delivery to what actually fits', () => {
    const state = context.state;
    state.economy.contracts = [];
    const order = ids();
    const sellerId = order[0];
    const buyerId = order[1];
    const seller = state.economy.resources[sellerId]!;
    seller.stock.oil = 1_000 + safetyReserveUnits(seller.consumption, 'oil', config);
    seller.production.oil = seller.consumption.oil ?? 0;
    const buyer = state.economy.resources[buyerId]!;
    // A 100/mo oil buyer: the warehouse holds 800; 700 already inside.
    buyer.consumption.oil = 100;
    buyer.stock.oil = 700;
    state.economy.treasury[buyerId] = 1_000_000;
    expect(signContract(state, buyerId, sellerId, 'oil', 300, 10, config, () => 'w3a').ok).toBe(true);
    executeMonthlyContracts(state, order, config, 11);
    // Only the FREE SPACE was delivered (honest partial — the seller keeps
    // the rest; the buyer paid only for what moved).
    expect(buyer.imports.oil ?? 0).toBe(100);
    expect(buyer.stock.oil).toBe(800); // exactly AT capacity
    // Next month the warehouse is full → the delivery is ZERO.
    buyer.imports.oil = 0;
    executeMonthlyContracts(state, order, config, 12);
    expect(buyer.imports.oil ?? 0).toBe(0);
    expect(buyer.stock.oil).toBe(800);
  });

  it('W4 the AI gathers for the future — bounded, never from the player', () => {
    const state = context.state;
    state.economy.contracts = [];
    const order = ids();
    const sellerId = order[0];
    const aiId = order[1];
    const seller = state.economy.resources[sellerId]!;
    seller.stock.food = 2_000 + safetyReserveUnits(seller.consumption, 'food', config);
    seller.production.food = seller.consumption.food ?? 0;
    const ai = state.economy.resources[aiId]!;
    // No shortage anywhere, a thin food stock, a rich treasury → the
    // stockpile path fires (the rng stub approves every chance).
    ai.shortage = {};
    ai.stock.food = 10;
    ai.consumption.food = 100;
    state.economy.treasury[aiId] = 100_000;
    const before = ai.stock.food;
    const filed = aiTradeStep(state, aiId, config, 30, yesRng, () => 'w4');
    expect(filed).toBeNull(); // a stockpile purchase files no request
    const target = Math.ceil(config.storage!.aiFutureMonths * 100); // 300
    expect(ai.stock.food).toBeGreaterThan(before);
    expect(ai.stock.food).toBeLessThanOrEqual(
      warehouseCapacityOf(ai.consumption, 'food', config)
    );
    expect(ai.stock.food).toBeLessThanOrEqual(Math.max(before + 1, target));
  });
});
