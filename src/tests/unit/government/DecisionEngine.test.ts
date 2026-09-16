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
    expect(decisionTreasuryPreview(state, countryId, decision)).toBe(-2000);

    enactDecision(state, countryId, decision, 5);

    expect(state.economy.treasury[countryId]).toBeCloseTo(treasuryBefore - 2000, 4);
    expect(state.government.countries[countryId].president.approval).toBeCloseTo(approvalBefore + 0.03, 6);
    // The industry modifier is active for the decision's full duration.
    const active = state.government.countries[countryId].decisions.active;
    const industryModifier = active.find((modifier) => modifier.target === 'sector.industry' && modifier.mode === 'mul');
    expect(industryModifier).toBeDefined();
    expect(industryModifier?.monthsLeft).toBe(24);
    expect(industryModifier?.sourceId).toBe('industrial_subsidy');
    // Cooldown + history bookkeeping.
    expect(state.government.countries[countryId].decisions.cooldowns['industrial_subsidy']).toBe(5 + 36);
    expect(state.government.countries[countryId].decisions.history[0]).toEqual({ decisionId: 'industrial_subsidy', month: 5 });
    game.dispose();
  });

  it('cooldown blocks re-enactment until it elapses', () => {
    const { game, countryId } = preparedGame(63);
    const decision = game.gameData.decision('industrial_subsidy');
    const state = game.gameState;
    enactDecision(state, countryId, decision, 0);
    expect(decisionBlockReason(state, countryId, decision, 1)).toBe('cooldown');
    expect(decisionBlockReason(state, countryId, decision, 35)).toBe('cooldown');
    expect(decisionBlockReason(state, countryId, decision, 36)).toBeNull();
    game.dispose();
  });

  it('readMetric applies mul modifiers (industry +5 % really reads +5 %)', () => {
    const { game, countryId } = preparedGame(64);
    const decision = game.gameData.decision('industrial_subsidy');
    const state = game.gameState;
    const baseOutput = state.economy.macro[countryId].sectors.industry.output;
    expect(activeMulFactor(state, countryId, 'sector.industry')).toBe(1);
    expect(readMetric(state, countryId, 'sector.industry')).toBeCloseTo(baseOutput, 6);

    enactDecision(state, countryId, decision, 0);
    expect(activeMulFactor(state, countryId, 'sector.industry')).toBeCloseTo(1.05, 10);
    expect(readMetric(state, countryId, 'sector.industry')).toBeCloseTo(baseOutput * 1.05, 6);
    game.dispose();
  });

  it('modifiers age monthly and expire exactly at zero months left', () => {
    const { game, countryId } = preparedGame(65);
    const decision = game.gameData.decision('industrial_subsidy');
    const state = game.gameState;
    enactDecision(state, countryId, decision, 0);
    const active = state.government.countries[countryId].decisions.active;
    for (let month = 0; month < 23; month += 1) {
      tickDecisionModifiers(state, countryId);
    }
    expect(active.some((modifier) => modifier.sourceId === 'industrial_subsidy')).toBe(true);
    tickDecisionModifiers(state, countryId); // 24th decrement → expiry
    expect(active.some((modifier) => modifier.sourceId === 'industrial_subsidy')).toBe(false);
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
});
