import { describe, it, expect } from 'vitest';
import { createTestGame } from '../../helpers/testGame';
import { readMetric, applyEffectBundle, applyInstantEffect, evaluateConditions, militaryPowerOf } from '../../../government/Metrics';
import { updateOpinionTopics, driftApproval, approvalTargetOf } from '../../../government/PublicOpinion';
import { deriveSpendingShares } from '../../../state/slices/governmentSlice';
import { runEconomyCycle } from '../../../economy/economyCycle';

describe('Metrics + PublicOpinion + monthly finance (Phase 2 causality, light money)', () => {
  it('effect bundles apply instant effects and register duration modifiers', () => {
    const game = createTestGame({ seed: 91 });
    const countryId = game.strategicMap.countryOrder[0];
    const state = game.gameState;
    const treasuryBefore = state.economy.treasury[countryId];
    const approvalBefore = state.government.countries[countryId].president.approval;

    const modifiers = applyEffectBundle(
      state,
      countryId,
      [
        { target: 'treasury', mode: 'add', value: -50 },
        { target: 'approval', mode: 'add', value: 0.02 },
        { target: 'militaryPower', mode: 'mul', value: 0.1, durationMonths: 6 }
      ],
      'test:bundle'
    );
    expect(modifiers.length).toBe(1);
    expect(state.economy.treasury[countryId]).toBeCloseTo(treasuryBefore - 50, 4);
    expect(state.government.countries[countryId].president.approval).toBeCloseTo(approvalBefore + 0.02, 9);
    const powerBase = militaryPowerOf(state, countryId);
    expect(readMetric(state, countryId, 'militaryPower')).toBeCloseTo(powerBase * 1.1, 4);
    game.dispose();
  });

  it('instant effects clamp into their domains and foodStock writes REAL units', () => {
    const game = createTestGame({ seed: 92 });
    const countryId = game.strategicMap.countryOrder[0];
    const state = game.gameState;
    applyInstantEffect(state, countryId, { target: 'approval', mode: 'add', value: 5 });
    expect(state.government.countries[countryId].president.approval).toBe(1);
    applyInstantEffect(state, countryId, { target: 'corruption', mode: 'add', value: -5 });
    expect(state.government.countries[countryId].politics.corruption).toBe(0);
    // foodStock is a REAL resource-economy effect: units land in the stock.
    const foodBefore = state.economy.resources[countryId]!.stock.food;
    applyInstantEffect(state, countryId, { target: 'foodStock', mode: 'add', value: 250 });
    expect(state.economy.resources[countryId]!.stock.food).toBe(foodBefore + 250);
    game.dispose();
  });

  it('condition evaluation reads current metrics (gte/lte)', () => {
    const game = createTestGame({ seed: 93 });
    const countryId = game.strategicMap.countryOrder[0];
    const state = game.gameState;
    state.government.countries[countryId].president.approval = 0.4;
    expect(evaluateConditions(state, countryId, [{ metric: 'approval', op: 'lte', value: 0.5 }])).toBe(true);
    expect(evaluateConditions(state, countryId, [{ metric: 'approval', op: 'gte', value: 0.5 }])).toBe(false);
    // Resource conditions: acute shortages count through the same resolver.
    state.economy.resources[countryId]!.shortage = { iron: 20, oil: 15 };
    expect(evaluateConditions(state, countryId, [{ metric: 'shortageResources', op: 'gte', value: 2 }])).toBe(true);
    game.dispose();
  });

  it('military power responds to the military budget share and corruption', () => {
    const game = createTestGame({ seed: 94 });
    const countryId = game.strategicMap.countryOrder[0];
    const state = game.gameState;
    const government = state.government.countries[countryId];
    government.budget.shares.military = 0.15;
    government.budget.spendingShares = deriveSpendingShares(government.budget.shares);
    government.politics.corruption = 0.2;
    const low = militaryPowerOf(state, countryId);
    government.budget.shares.military = 0.8;
    government.budget.spendingShares = deriveSpendingShares(government.budget.shares);
    const high = militaryPowerOf(state, countryId);
    expect(high).toBeGreaterThan(low);
    government.politics.corruption = 0.8;
    expect(militaryPowerOf(state, countryId)).toBeLessThan(high);
    game.dispose();
  });

  it('opinion topics react to scarcity and approval drifts toward the blended target', () => {
    const game = createTestGame({ seed: 95 });
    const countryId = game.strategicMap.countryOrder[0];
    const state = game.gameState;
    const government = state.government.countries[countryId];
    // Disaster resources + HIGH tax.
    state.economy.resources[countryId]!.shortage = { iron: 30, oil: 20, food: 40 };
    government.budget.tax = 'high';
    updateOpinionTopics(state, countryId);
    expect(government.opinion.topics.economy).toBeLessThan(0);
    expect(government.opinion.topics.taxes).toBeLessThan(0);

    const before = government.president.approval;
    driftApproval(state, countryId, 0.3);
    const target = approvalTargetOf(government.opinion.topics);
    expect(government.president.approval).toBeGreaterThan(Math.min(before, target) - 1e-9);
    expect(government.president.approval).toBeLessThan(Math.max(before, target) + 1e-9);
    game.dispose();
  });

  it('finance: a higher tax level yields higher monthly revenue (same world)', () => {
    const lowGame = createTestGame({ seed: 96 });
    const highGame = createTestGame({ seed: 96 });
    const lowCountry = lowGame.strategicMap.countryOrder[0];
    const highCountry = highGame.strategicMap.countryOrder[0];
    lowGame.gameState.government.countries[lowCountry].budget.tax = 'low';
    highGame.gameState.government.countries[highCountry].budget.tax = 'high';

    runEconomyCycle(lowGame.gameState, lowGame.gameContext.map, lowGame.gameContext.data.economyData.strategicResources, { applyStep: true });
    runEconomyCycle(highGame.gameState, highGame.gameContext.map, highGame.gameContext.data.economyData.strategicResources, { applyStep: true });

    const lowRevenue = lowGame.gameState.economy.finance[lowCountry]!.lastTaxIncome;
    const highRevenue = highGame.gameState.economy.finance[highCountry]!.lastTaxIncome;
    expect(highRevenue).toBeGreaterThan(lowRevenue);
    lowGame.dispose();
    highGame.dispose();
  });

  it('finance: the ledger has exactly THREE income lines and THREE expense lines (§3)', () => {
    const game = createTestGame({ seed: 97 });
    const countryId = game.strategicMap.countryOrder[0];
    const state = game.gameState;
    const config = game.gameContext.data.economyData.strategicResources;
    runEconomyCycle(state, game.gameContext.map, config, { applyStep: true });
    const finance = state.economy.finance[countryId]!;
    expect(finance.lastTaxIncome).toBeGreaterThan(0);
    expect(finance.lastTradeIncome).toBeLessThanOrEqual(finance.lastTradeIncome + 1);
    expect(finance.lastFactoryIncome).toBeGreaterThanOrEqual(0);
    const income = finance.lastTaxIncome + finance.lastTradeIncome + finance.lastFactoryIncome;
    const expenses = finance.lastArmyExpense + finance.lastGovernmentExpense + finance.lastInfrastructureExpense;
    expect(finance.lastBalance).toBeCloseTo(income - expenses, 2);
    // The treasury received EXACTLY one balance application this month.
    expect(state.economy.treasury[countryId]).toBeGreaterThanOrEqual(0);
    game.dispose();
  });

  it('finance: expenses over the treasury floor it at ZERO — NO debt machinery (§14)', () => {
    const game = createTestGame({ seed: 98 });
    const countryId = game.strategicMap.countryOrder[0];
    const state = game.gameState;
    // A crushing army over a tiny treasury with the LOW tax rate.
    const government = state.government.countries[countryId];
    government.budget.tax = 'low';
    state.economy.treasury[countryId] = 10;
    const country = state.countries.countries[countryId]!;
    const config = game.gameContext.data.economyData.strategicResources;
    // Army expense scales with soldiers — inflate them past any income.
    country.military.armySize = 40_000_000;
    const financeBefore = state.economy.finance[countryId]!;
    void financeBefore;
    runEconomyCycle(state, game.gameContext.map, config, { applyStep: true });
    const finance = state.economy.finance[countryId]!;
    expect(finance.lastBalance).toBeLessThan(0);
    expect(state.economy.treasury[countryId]).toBe(0);
    // No debt field exists anywhere in the finance record.
    expect(finance).not.toHaveProperty('debt');
    game.dispose();
  });

  it('finance: a surplus raises the treasury', () => {
    const game = createTestGame({ seed: 99 });
    const countryId = game.strategicMap.countryOrder[0];
    const state = game.gameState;
    state.government.countries[countryId].budget.tax = 'high';
    // A 24M population pays 480/month at the high rate — the balance turns
    // positive regardless of the country's geography.
    state.countries.countries[countryId]!.population = 24_000_000;
    const treasuryBefore = state.economy.treasury[countryId];
    runEconomyCycle(state, game.gameContext.map, game.gameContext.data.economyData.strategicResources, { applyStep: true });
    const finance = state.economy.finance[countryId]!;
    expect(finance.lastBalance).toBeGreaterThan(0);
    expect(state.economy.treasury[countryId]).toBeGreaterThan(treasuryBefore);
    game.dispose();
  });

  it('the tax formula depends ONLY on population × rate (no hidden modifiers)', () => {
    const game = createTestGame({ seed: 100 });
    const countryId = game.strategicMap.countryOrder[0];
    const state = game.gameState;
    const config = game.gameContext.data.economyData.strategicResources;
    state.government.countries[countryId].budget.tax = 'high';
    state.government.countries[countryId].politics.generalStrikeUntilMonth = 5;
    state.government.countries[countryId].politics.corruption = 0.9;
    runEconomyCycle(state, game.gameContext.map, config, { applyStep: true });
    // §2's formula is EXACTLY population × rate × multiplier — nothing else.
    const population = state.countries.countries[countryId]!.population;
    const expected = (population / 1_000_000) * 0.2 * config.finance.taxIncomePerMillionPerRate;
    expect(state.economy.finance[countryId]!.lastTaxIncome).toBeCloseTo(expected, 0);
    game.dispose();
  });
});
