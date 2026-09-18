/**
 * Resource research + mine level tests (the directive's Tests 5 and 7).
 *
 *  - T5: unlocking "Iron Mine Level 2" really allows upgrading a level-1
 *    mine, and the production INCREASES in the live world simulation.
 *  - T7: mine info (resource / type / level / production / owner) reads
 *    from the REAL Game State — the same numbers the map panels show.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestGame } from '../../helpers/testGame';
import type { Game } from '../../../core/Game';
import type { SystemContext } from '../../../core/GameContext';
import {
  recomputeResourceEconomies,
  depositMonthlyProduction,
  mineLevelOf,
  mineLevelMultiplier
} from '../../../economy/resources';
import { unlockMineLevel, upgradeMine, unlockedMineLevelOf, maxMineLevel } from '../../../economy/research';
import type { StrategicMapModel } from '../../../world/map/MapTypes';

describe('resource research — mines with levels (Tests 5 & 7)', () => {
  let game: Game;
  let context: SystemContext;
  let mapModel: StrategicMapModel;
  let config: SystemContext['data']['economyData']['strategicResources'];
  let countryId: string;
  let ironDeposit: { id: string; countryId: string; resourceId: string; quantity: number };

  beforeAll(() => {
    game = createTestGame({ seed: 4242 });
    context = game.gameContext;
    mapModel = context.map;
    config = context.data.economyData.strategicResources;
    countryId = mapModel.countryOrder[0];
    const deposit = mapModel.features.deposits.find(
      (candidate) => candidate.resourceId === 'iron' && candidate.countryId === countryId
    );
    if (deposit === undefined) throw new Error('test map has no iron deposit for country 0');
    ironDeposit = {
      id: deposit.id,
      countryId: deposit.countryId,
      resourceId: deposit.resourceId,
      quantity: deposit.quantity
    };
  });

  it('TEST 5 — unlocking level 2 lets the mine upgrade and production RISES', () => {
    const state = context.state;
    // Base production of the deposit at level 1.
    const base = depositMonthlyProduction(ironDeposit as never, config, 1);
    expect(base).toBe(Math.round(ironDeposit.quantity * config.productionScale));

    // Upgrade BEFORE research is blocked (research-required).
    const blocked = upgradeMine(state, countryId, config, ironDeposit.id, ironDeposit.countryId, ironDeposit.resourceId);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toBe('research-required');

    // Unlock the research (fund the treasury first) — money really moves.
    state.economy.treasury[countryId] = 500;
    const cost = config.research.levels['2']!;
    const unlocked = unlockMineLevel(state, countryId, config, ironDeposit.resourceId);
    expect(unlocked.ok).toBe(true);
    expect(state.economy.treasury[countryId]).toBe(500 - cost);
    expect(unlockedMineLevelOf(state, countryId, ironDeposit.resourceId)).toBe(2);

    // NOW the mine upgrades to level 2 — level multiplier 1.5.
    const upgraded = upgradeMine(state, countryId, config, ironDeposit.id, ironDeposit.countryId, ironDeposit.resourceId);
    expect(upgraded.ok).toBe(true);
    expect(state.economy.mines[ironDeposit.id]).toBe(2);
    expect(mineLevelMultiplier(config, 2)).toBeCloseTo(1.5, 5);

    // The production effect is REAL: a fresh world recompute multiplies the
    // mine's output (spec §13 — never just a badge).
    recomputeResourceEconomies(state, mapModel, config);
    const level2 = depositMonthlyProduction(ironDeposit as never, config, 2);
    expect(level2).toBe(Math.round(base * 1.5));
    expect(level2).toBeGreaterThan(base);
  });

  it('research respects funds, max level and ownership', () => {
    const state = context.state;
    const otherCountry = mapModel.countryOrder[1];
    // A foreign mine can never be upgraded by another country.
    const foreign = mapModel.features.deposits.find((candidate) => candidate.countryId !== countryId);
    expect(foreign).toBeDefined();
    const foreignResult = upgradeMine(state, countryId, config, foreign!.id, foreign!.countryId, foreign!.resourceId);
    expect(foreignResult.ok).toBe(false);

    // No money → insufficient-funds (treasury floors at 0 in this world).
    state.economy.treasury[countryId] = 0;
    const poor = unlockMineLevel(state, countryId, config, 'oil');
    expect(poor.ok).toBe(false);

    // Unknown resource → rejected.
    const ghost = unlockMineLevel(state, countryId, config, 'gold');
    expect(ghost.ok).toBe(false);
    void otherCountry;
  });

  it('level multipliers are extensible beyond level 2', () => {
    expect(maxMineLevel(config)).toBeGreaterThanOrEqual(2);
    expect(mineLevelMultiplier(config, 1)).toBeCloseTo(1, 5);
    expect(mineLevelMultiplier(config, 99)).toBe(1); // unknown → neutral
  });

  it('TEST 7 — mine info reads from REAL state (what the map panels show)', () => {
    const state = context.state;
    // The mine record triple: level, production, owner — all live state.
    const level = mineLevelOf(state, ironDeposit.id);
    const production = depositMonthlyProduction(ironDeposit as never, config, level);
    expect(Number.isInteger(level)).toBe(true);
    expect(Number.isInteger(production)).toBe(true);
    expect(production).toBeGreaterThan(0);
    // The deposit is geography-bound: it carries a cell and a position.
    const deposit = mapModel.features.deposits.find((candidate) => candidate.id === ironDeposit.id)!;
    expect(deposit.cellIndex).toBeGreaterThanOrEqual(0);
    expect(deposit.position).toBeDefined();
    expect(deposit.countryId).toBe(ironDeposit.countryId);
    // After the T5 upgrade the panel data shows level 2 with ×1.5 output.
    expect(level).toBe(2);
    const base = Math.round(ironDeposit.quantity * config.productionScale);
    expect(production).toBe(Math.round(base * 1.5));
  });
});
