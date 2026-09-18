/**
 * Construction + resource purchase tests (the directive's Tests 1–6 of §24).
 *
 * THE core loop (spec §21): production → stockpile → construction →
 * shortage → the player BUYS explicitly → stockpile/escrow rises →
 * construction continues. Every step is verified against the LIVE game
 * state:
 *  - T1  a project with the full cost can start (and starts BUILDING);
 *  - T3  Required 1,000 / Stockpile 500 → Missing = 500 (WAITING state);
 *  - T4  buying 500 iron fills the escrow 500 → 1,000 → the project builds;
 *  - T5  RESERVED (secured) units are never reusable by another project;
 *  - T6  the construction cost is consumed exactly ONCE (a building project
 *        never draws resources again — time decides, spec §6).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestGame } from '../../helpers/testGame';
import type { Game } from '../../../core/Game';
import type { SystemContext } from '../../../core/GameContext';
import { projectShortageOf, startProject, stepProjects, secureWaitingProjects, reservedResourcesOf } from '../../../economy/construction';
import { purchaseResource, sellersOf, dealPriceOf } from '../../../economy/purchase';
import type { StrategicMapModel } from '../../../world/map/MapTypes';

describe('construction + purchase cycle (Tests 1–6)', () => {
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

  it('TEST 1 — a project can start when the country owns the full cost', () => {
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
    const project = construction.projects[0]!;
    // Starting secures the full cost immediately → the project is BUILDING.
    expect(project.status).toBe('building');
    for (const [resourceId, cost] of Object.entries(def.cost)) {
      expect(project.secured[resourceId]).toBe(Math.ceil(cost));
      // The escrow is REAL: the units left the free stockpile.
      expect(state.economy.resources[countryId]!.stock[resourceId]).toBe(100);
    }
    expect(reservedResourcesOf(state, countryId).iron).toBe(Math.ceil(def.cost.iron));
    // Clean up for the next test.
    construction.projects.length = 0;
  });

  it('TEST 3 — Required 1,000 / Stockpile 500 → Missing = 500 (WAITING)', () => {
    const state = context.state;
    const def = config.productionFactories.find((candidate) => candidate.id === 'iron_works')!;
    const construction = state.economy.construction[countryId]!;
    construction.projects.length = 0;
    // Drain the cost resources to half of the iron cost.
    state.economy.resources[countryId]!.stock.iron = Math.ceil(def.cost.iron / 2); // 500
    state.economy.resources[countryId]!.stock.coal = 0;
    const result = startProject(state, countryId, config, 'iron_works', 'city_0', 0, () => 'proj_t3');
    expect(result.ok).toBe(true);
    const project = construction.projects[0]!;
    // The available 500 are reserved, the rest is missing, state = WAITING.
    expect(project.status).toBe('waiting');
    const shortages = projectShortageOf(state, countryId, config, project);
    const ironRow = shortages.find((row) => row.resourceId === 'iron')!;
    expect(ironRow.required).toBe(1000);
    expect(ironRow.secured).toBe(500);
    expect(ironRow.missing).toBe(500);
    const coalRow = shortages.find((row) => row.resourceId === 'coal')!;
    expect(coalRow.secured).toBe(0);
    expect(coalRow.missing).toBe(coalRow.required);
    // The reserved units are OUT of the free stockpile (spec §5).
    expect(state.economy.resources[countryId]!.stock.iron).toBe(0);
  });

  it('TEST 4 — buying 500 iron fills the escrow and the project starts building', () => {
    const state = context.state;
    const construction = state.economy.construction[countryId]!;
    const project = construction.projects[0]!;
    const shortages = projectShortageOf(state, countryId, config, project);
    const ironMissing = shortages.find((row) => row.resourceId === 'iron')!.missing;
    const coalMissing = shortages.find((row) => row.resourceId === 'coal')!.missing;
    expect(ironMissing).toBe(500);

    // The seller: another country holding the missing units (deterministic).
    const sellerId = mapModel.countryOrder.find((id) => id !== countryId)!;
    state.economy.resources[sellerId]!.stock.iron = ironMissing + 100;
    state.economy.resources[sellerId]!.stock.coal = Math.max(
      state.economy.resources[sellerId]!.stock.coal ?? 0,
      coalMissing + 50
    );

    // The market lists the seller with its REAL spare stock (spec §7).
    const sellers = sellersOf(state, countryId, 'iron', config);
    expect(sellers.some((entry) => entry.countryId === sellerId)).toBe(true);

    // The FACADE path: the explicit deal lands in stock, then the securing
    // pass reserves it into the project (spec §6: the project proceeds).
    state.economy.treasury[countryId] = 10_000;
    const price = dealPriceOf(state, countryId, 'iron', config);
    expect(price.buyPerUnit).toBeGreaterThan(0);
    expect(game.economyBuyResource(countryId, sellerId, 'iron', ironMissing)).toBe(true);
    if (coalMissing > 0) {
      state.economy.treasury[countryId] = 10_000;
      game.economyBuyResource(countryId, sellerId, 'coal', coalMissing);
    }
    // Everything is secured now → BUILDING.
    expect(project.secured.iron).toBe(1000);
    expect(project.status).toBe('building');

    // The build advances by TIME alone and completes into a real plant.
    const plantsBefore = Object.keys(state.economy.plants[countryId] ?? {}).length;
    let completed = false;
    for (let month = 3; month < 30; month += 1) {
      const outcome = stepProjects(state, countryId, config, month);
      if (outcome.completed.length > 0) {
        completed = true;
        break;
      }
    }
    expect(completed).toBe(true);
    const plantsAfter = Object.keys(state.economy.plants[countryId] ?? {}).length;
    expect(plantsAfter).toBe(plantsBefore + 1);
    construction.projects.length = 0;
  });

  it('TEST 5 — reserved resources are never reusable by a second project', () => {
    const state = context.state;
    const construction = state.economy.construction[countryId]!;
    construction.projects.length = 0;
    // Exactly 1,000 iron in the free stockpile.
    state.economy.resources[countryId]!.stock.iron = 1000;
    state.economy.resources[countryId]!.stock.coal = 1000;
    const first = startProject(state, countryId, config, 'iron_works', 'city_0', 0, () => 'proj_5a');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.project.status).toBe('building'); // took all 1,000 iron
    expect(state.economy.resources[countryId]!.stock.iron).toBe(0);
    // A second iron-hungry project CANNOT reserve the same units.
    const second = startProject(state, countryId, config, 'oil_refinery', 'city_0', 0, () => 'proj_5b');
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const shortages = projectShortageOf(state, countryId, config, second.project);
    const ironRow = shortages.find((row) => row.resourceId === 'iron')!;
    expect(ironRow.secured).toBe(0);
    expect(ironRow.missing).toBe(ironRow.required);
    expect(second.project.status).toBe('waiting');
    construction.projects.length = 0;
  });

  it('TEST 6 — the construction cost is consumed exactly ONCE', () => {
    const state = context.state;
    const record = state.economy.resources[countryId]!;
    const construction = state.economy.construction[countryId]!;
    construction.projects.length = 0;
    record.stock.iron = 1500;
    record.stock.coal = 500;
    const started = startProject(state, countryId, config, 'iron_works', 'city_0', 0, () => 'proj_6');
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.project.status).toBe('building');
    const ironAfterSecuring = record.stock.iron; // 1500 − 1000 = 500
    const coalAfterSecuring = record.stock.coal; // 500 − 400 = 100
    expect(ironAfterSecuring).toBe(500);
    expect(coalAfterSecuring).toBe(100);
    // Building months pass: NO further resource draws, only progress.
    for (let month = 1; month <= 4; month += 1) {
      stepProjects(state, countryId, config, month);
    }
    expect(record.stock.iron).toBe(ironAfterSecuring);
    expect(record.stock.coal).toBe(coalAfterSecuring);
    expect(started.project.progress).toBeGreaterThan(0);
    expect(started.project.progress).toBeLessThan(1);
    construction.projects.length = 0;
  });

  it('a waiting project secures monthly production as it arrives (§17 loop)', () => {
    const state = context.state;
    const record = state.economy.resources[countryId]!;
    const construction = state.economy.construction[countryId]!;
    construction.projects.length = 0;
    record.stock.iron = 0;
    record.stock.coal = 0;
    const started = startProject(state, countryId, config, 'lumber_mill', 'city_0', 0, () => 'proj_7');
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.project.status).toBe('waiting');
    // Domestic production arrives → the next securing pass reserves it.
    record.stock.iron = 250;
    record.stock.wood = 300;
    secureWaitingProjects(state, countryId, config);
    expect(started.project.secured.iron).toBe(250);
    expect(started.project.secured.wood).toBe(300);
    expect(started.project.status).toBe('waiting'); // still short of iron
    record.stock.iron = 150; // the remaining 150 of the 400 cost
    secureWaitingProjects(state, countryId, config);
    expect(started.project.secured.iron).toBe(400);
    expect(started.project.status).toBe('building');
    construction.projects.length = 0;
  });

  it('purchases respect the seller free stock and the buyer money (no negatives)', () => {
    const state = context.state;
    const buyerId = mapModel.countryOrder[0];
    const sellerId = mapModel.countryOrder[1];
    state.economy.resources[sellerId]!.stock.copper = 200;
    state.economy.resources[sellerId]!.consumption.copper = 0; // no reserve → 200 free
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

  it('a seller never offers the units its own consumption reserve needs (§11)', () => {
    const state = context.state;
    const buyerId = mapModel.countryOrder[0];
    const sellerId = mapModel.countryOrder[1];
    const sellerRecord = state.economy.resources[sellerId]!;
    sellerRecord.stock.copper = 500;
    sellerRecord.consumption.copper = 100; // reserve = 1 month = 100 units
    const sellers = sellersOf(state, buyerId, 'copper', config);
    const entry = sellers.find((candidate) => candidate.countryId === sellerId);
    expect(entry?.amount).toBe(400); // 500 − 100 reserve
  });
});
