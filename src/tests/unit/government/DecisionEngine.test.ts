import { describe, it, expect } from 'vitest';
import { createTestGame } from '../../helpers/testGame';
import { decisionBlockReason, enactDecision, tickDecisionModifiers, decisionTreasuryPreview } from '../../../government/DecisionEngine';
import { readMetric, activeMulFactor } from '../../../government/Metrics';
import type { Game } from '../../../core/Game';

function preparedGame(seed: number): { game: Game; countryId: string } {
  const game = createTestGame({ seed });
  const countryId = game.strategicMap.countryOrder[0];
  game.gameState.economy.treasury[countryId] = 100_000;
  return { game, countryId };
}

describe('DecisionEngine (data-driven presidential decisions)', () => {
  it('a decision the registry knows is fully blocked only by real reasons', () => {
    const { game, countryId } = preparedGame(61);
    const decision = game.gameData.decision('industrial_subsidy');
    // Wealthy country: nothing blocks it.
    expect(decisionBlockReason(game.gameState, countryId, decision, 0)).toBeNull();
    // Poor country: the treasury PRECONDITION fails first (checked before cost).
    game.gameState.economy.treasury[countryId] = 100;
    expect(decisionBlockReason(game.gameState, countryId, decision, 0)).toBe('preconditions');
    game.dispose();
  });

  it('enacting charges the cost, applies effects, starts the cooldown and records history', () => {
    const { game, countryId } = preparedGame(62);
    const decision = game.gameData.decision('industrial_subsidy');
    const state = game.gameState;
    const treasuryBefore = state.economy.treasury[countryId];
    const approvalBefore = state.government.countries[countryId].president.approval;
    expect(decisionTreasuryPreview(state, countryId, decision)).toBe(-720);

    enactDecision(state, countryId, decision, 5);

    expect(state.economy.treasury[countryId]).toBeCloseTo(treasuryBefore - 720, 4);
    expect(state.government.countries[countryId].president.approval).toBeCloseTo(approvalBefore + 0.03, 6);
    // The 'add' effects applied instantly (protest relief) — no modifier.
    const active = state.government.countries[countryId].decisions.active;
    expect(active.some((modifier) => modifier.sourceId === 'industrial_subsidy')).toBe(false);
    // Cooldown + history bookkeeping.
    expect(state.government.countries[countryId].decisions.cooldowns['industrial_subsidy']).toBe(5 + 24);
    expect(state.government.countries[countryId].decisions.history[0]).toEqual({ decisionId: 'industrial_subsidy', month: 5 });
    game.dispose();
  });

  it('cooldown blocks re-enactment until it elapses', () => {
    const { game, countryId } = preparedGame(63);
    const decision = game.gameData.decision('industrial_subsidy');
    const state = game.gameState;
    enactDecision(state, countryId, decision, 0);
    expect(decisionBlockReason(state, countryId, decision, 1)).toBe('cooldown');
    expect(decisionBlockReason(state, countryId, decision, 23)).toBe('cooldown');
    expect(decisionBlockReason(state, countryId, decision, 24)).toBeNull();
    game.dispose();
  });

  it('readMetric applies mul modifiers (military +10 % really reads +10 %)', () => {
    const { game, countryId } = preparedGame(64);
    const decision = game.gameData.decision('increase_military_spending');
    const state = game.gameState;
    expect(activeMulFactor(state, countryId, 'militaryPower')).toBe(1);
    const basePower = readMetric(state, countryId, 'militaryPower');
    expect(basePower).toBeGreaterThan(0);

    enactDecision(state, countryId, decision, 0);
    expect(activeMulFactor(state, countryId, 'militaryPower')).toBeCloseTo(1.1, 10);
    expect(readMetric(state, countryId, 'militaryPower')).toBeCloseTo(basePower * 1.1, 6);
    game.dispose();
  });

  it('modifiers age monthly and expire exactly at zero months left', () => {
    const { game, countryId } = preparedGame(65);
    // The military decision carries a 'mul' modifier → a real 12-month life.
    const decision = game.gameData.decision('increase_military_spending');
    const state = game.gameState;
    enactDecision(state, countryId, decision, 0);
    const active = state.government.countries[countryId].decisions.active;
    for (let month = 0; month < 11; month += 1) {
      tickDecisionModifiers(state, countryId);
    }
    expect(active.some((modifier) => modifier.sourceId === 'increase_military_spending')).toBe(true);
    tickDecisionModifiers(state, countryId); // 12th decrement → expiry
    expect(active.some((modifier) => modifier.sourceId === 'increase_military_spending')).toBe(false);
    game.dispose();
  });

  it('precondition metrics gate decisions (state_of_emergency needs protest pressure)', () => {
    const { game, countryId } = preparedGame(66);
    const decision = game.gameData.decision('state_of_emergency');
    const state = game.gameState;
    expect(decisionBlockReason(state, countryId, decision, 0)).toBe('preconditions');
    state.government.countries[countryId].politics.protestPressure = 0.6;
    expect(decisionBlockReason(state, countryId, decision, 0)).toBeNull();
    game.dispose();
  });

  it('the food-stock decision feeds the REAL stockpile (resource economy)', () => {
    const { game, countryId } = preparedGame(67);
    const decision = game.gameData.decision('agriculture_modernization');
    const state = game.gameState;
    const foodBefore = state.economy.resources[countryId]?.stock.food ?? 0;
    enactDecision(state, countryId, decision, 0);
    expect(state.economy.resources[countryId]!.stock.food).toBe(foodBefore + 2000);
    game.dispose();
  });
});
