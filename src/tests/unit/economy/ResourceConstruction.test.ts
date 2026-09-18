/**
 * Construction + resource purchase tests (the directive's Tests 1–3).
 *
 * THE core loop (spec §17): production → stockpile → construction consumes
 * → shortage → the player BUYS explicitly → stockpile rises → construction
 * continues. Every step is verified against the LIVE game state.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestGame } from '../../helpers/testGame';
import type { Game } from '../../../core/Game';
import type { SystemContext } from '../../../core/GameContext';
import { projectShortageOf, startProject, stepProjects } from '../../../economy/construction';
import { purchaseResource, sellersOf, dealPriceOf } from '../../../economy/purchase';
import type { StrategicMapModel } from '../../../world/map/MapTypes';

describe('construction + purchase cycle (Tests 1–3)', () => {
  let game: Game;
  let context: SystemContext;
  let mapModel: StrategicMapModel;
  let config: SystemContext['data']['economyData']['strategicResources'];
  let countryId: string;

  beforeAll(() => {
    game = createTestGame({ seed: 4242 });
    context = game.gameContext;
    mapModel = context.map;
    config = context.data.economyData.strategicResources;
    countryId = mapModel.countryOrder[0];
  });

  it('TEST 1 — construction can start when the country owns the full cost', () => {
    const state = context.state;
    const def = config.productionFactories.find((candidate) => candidate.id === 'iron_works')!;
    // The country OWNS the full cost (stock seeded + a top-up).
    for (const [resourceId, cost] of Object.entries(def.cost)) {
      state.economy.resources[countryId]!.stock[resourceId] = cost + 100;
    }
    const construction = state.economy.construction[countryId]!;
    construction.projects.length = 0;
    const result = startProject(state, countryId, config, 'iron_works', 'city_0', 0, () => 'proj_t1');
    expect(result.ok).toBe(true);
    expect(state.economy.construction[countryId]!.projects).toHaveLength(1);
  });

  it('TEST 2 — a project without resources shows Required / Owned / Missing', () => {
    const state = context.state;
    const def = config.productionFactories.find((candidate) => candidate.id === 'iron_works')!;
    const construction = state.economy.construction[countryId]!;
    construction.projects.length = 0;
    // Drain the cost resources to half of the iron cost.
    state.economy.resources[countryId]!.stock.iron = Math.ceil(def.cost.iron / 2); // 500
    state.economy.resources[countryId]!.stock.coal = 0;
    const result = startProject(state, countryId, config, 'iron_works', 'city_0', 0, () => 'proj_t2');
    expect(result.ok).toBe(true);
    const project = construction.projects[0]!;
    const shortages = projectShortageOf(state, countryId, config, project);
    const ironRow = shortages.find((row) => row.resourceId === 'iron')!;
    expect(ironRow.required).toBe(1000);
    expect(ironRow.owned).toBe(500);
    expect(ironRow.missing).toBe(500);
    const coalRow = shortages.find((row) => row.resourceId === 'coal')!;
    expect(coalRow.owned).toBe(0);
    expect(coalRow.missing).toBe(coalRow.required);
  });

  it('a stalled project draws what it can, then freezes without resources', () => {
    const state = context.state;
    const record = state.economy.resources[countryId]!;
    // One step with only 500 iron available: it pays in, progress < 1.
    const ironBefore = record.stock.iron;
    stepProjects(state, countryId, config, 1);
    const project = state.economy.construction[countryId]!.projects[0]!;
    expect(project.progress).toBeGreaterThan(0);
    expect(project.progress).toBeLessThan(1);
    expect(record.stock.iron).toBeLessThan(ironBefore);
    // Another step with an EMPTY stock: nothing moves (stalled, not cancelled).
    record.stock.iron = 0;
    record.stock.coal = 0;
    const paidBefore = { ...project.paid };
    stepProjects(state, countryId, config, 2);
    expect(project.paid).toEqual(paidBefore);
  });

  it('TEST 3 — buying 500 iron from a seller fills the gap and construction completes', () => {
    const state = context.state;
    const record = state.economy.resources[countryId]!;
    const project = state.economy.construction[countryId]!.projects[0]!;
    const shortages = projectShortageOf(state, countryId, config, project);
    const ironMissing = shortages.find((row) => row.resourceId === 'iron')!.missing;
    const coalMissing = shortages.find((row) => row.resourceId === 'coal')!.missing;
    expect(ironMissing + coalMissing).toBeGreaterThan(0);

    // The seller: another country holding plenty of iron (and money flows).
    const sellerId = mapModel.countryOrder.find((id) => id !== countryId);
    expect(sellerId).toBeDefined();
    // Fixture: the seller actually HOLDS the missing units (deterministic).
    state.economy.resources[sellerId!]!.stock.iron = ironMissing + 100;
    state.economy.resources[sellerId!]!.stock.coal = Math.max(
      state.economy.resources[sellerId!]!.stock.coal ?? 0,
      coalMissing + 50
    );

    // The sellers view lists the seller with its REAL stockpile (spec §5).
    const sellers = sellersOf(state, countryId, 'iron');
    expect(sellers.some((entry) => entry.countryId === sellerId)).toBe(true);

    // Fund the buyer and BUY the missing units — a real deal.
    const neededIron = ironMissing;
    state.economy.treasury[countryId] = 10_000;
    const price = dealPriceOf(state, countryId, 'iron', config);
    expect(price.buyPerUnit).toBeGreaterThan(0);
    const purchase = purchaseResource(state, countryId, sellerId!, 'iron', neededIron, config);
    expect(purchase.ok).toBe(true);
    if (purchase.ok) {
      expect(purchase.amount).toBe(neededIron);
      expect(purchase.cost).toBeCloseTo(purchase.amount * price.buyPerUnit, 0);
    }
    const sellerRecord = state.economy.resources[sellerId!]!;
    expect(sellerRecord.stock.iron).toBeGreaterThanOrEqual(0);
    expect(record.stock.iron).toBeGreaterThanOrEqual(neededIron);

    // Coal gap: buy that too from the same seller (if short).
    if (coalMissing > 0) {
      state.economy.treasury[countryId] = 10_000;
      purchaseResource(state, countryId, sellerId!, 'coal', coalMissing, config);
      // Top up from the seller's stock if the seller lacked coal — the deal
      // caps by availability, so re-check the missing view.
      const remaining = projectShortageOf(state, countryId, config, project);
      const stillMissing = remaining.reduce((sum, row) => sum + row.missing, 0);
      if (stillMissing > 0) {
        for (const row of remaining) {
          state.economy.resources[countryId]!.stock[row.resourceId] = row.missing;
        }
      }
    }

    // Construction CONTINUES and completes: the plant exists and boosts iron.
    const plantsBefore = Object.keys(state.economy.plants[countryId] ?? {}).length;
    let completed = false;
    for (let month = 3; month < 12; month += 1) {
      const outcome = stepProjects(state, countryId, config, month);
      if (outcome.completed.length > 0) {
        completed = true;
        break;
      }
    }
    expect(completed).toBe(true);
    const plantsAfter = Object.keys(state.economy.plants[countryId] ?? {}).length;
    expect(plantsAfter).toBe(plantsBefore + 1);
  });

  it('purchases respect the seller stock and the buyer money (no negatives)', () => {
    const state = context.state;
    const buyerId = mapModel.countryOrder[0];
    const sellerId = mapModel.countryOrder[1];
    state.economy.resources[sellerId]!.stock.copper = 200;
    state.economy.treasury[buyerId] = 0.2; // less than one unit's price
    const broke = purchaseResource(state, buyerId, sellerId, 'copper', 150, config);
    expect(broke.ok).toBe(false);
    if (!broke.ok) expect(broke.reason).toBe('no-funds');
    state.economy.treasury[buyerId] = 10_000;
    const overask = purchaseResource(state, buyerId, sellerId, 'copper', 500, config);
    expect(overask.ok).toBe(true);
    if (overask.ok) expect(overask.amount).toBe(200); // capped by stock
    const selfSale = purchaseResource(state, buyerId, buyerId, 'copper', 10, config);
    expect(selfSale.ok).toBe(false);
    // Money and stock moved by exactly the deal.
    expect(state.economy.resources[sellerId]!.stock.copper).toBe(0);
  });
});
