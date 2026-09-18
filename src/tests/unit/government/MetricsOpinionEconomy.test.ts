import { describe, it, expect } from 'vitest';
import { createTestGame } from '../../helpers/testGame';
import { readMetric, applyEffectBundle, applyInstantEffect, evaluateConditions, militaryPowerOf } from '../../../government/Metrics';
import { updateOpinionTopics, driftApproval, approvalTargetOf } from '../../../government/PublicOpinion';
import { processMonthFinance, monthlyEconomyValueOf } from '../../../economy/EconomySimulation';
import { deriveSpendingShares } from '../../../state/slices/governmentSlice';

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
    state.economy.resources[countryId]!.unfilledShortage = { iron: 20, oil: 15 };
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
    // Disaster resources + MAX tax.
    state.economy.resources[countryId]!.unfilledShortage = { iron: 30, oil: 20, food: 40, coal: 10 };
    government.budget.tax = 'max';
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
    const lowTaxGame = createTestGame({ seed: 96 });
    const highTaxGame = createTestGame({ seed: 96 });
    const lowCountry = lowTaxGame.strategicMap.countryOrder[0];
    const highCountry = highTaxGame.strategicMap.countryOrder[0];
    lowTaxGame.gameState.government.countries[lowCountry].budget.tax = 'low';
    highTaxGame.gameState.government.countries[highCountry].budget.tax = 'max';

    processMonthFinance(lowTaxGame.gameState, lowCountry, lowTaxGame.gameContext.data.economyData.strategicResources);
    processMonthFinance(highTaxGame.gameState, highCountry, highTaxGame.gameContext.data.economyData.strategicResources);

    const lowRevenue = lowTaxGame.gameState.economy.finance[lowCountry]!.lastRevenue;
    const highRevenue = highTaxGame.gameState.economy.finance[highCountry]!.lastRevenue;
    expect(highRevenue).toBeGreaterThan(lowRevenue);
    lowTaxGame.dispose();
    highTaxGame.dispose();
  });

  it('finance: the ledger has exactly THREE revenue lines and light spending', () => {
    const game = createTestGame({ seed: 97 });
    const countryId = game.strategicMap.countryOrder[0];
    const state = game.gameState;
    const config = game.gameContext.data.economyData.strategicResources;
    const ledger = processMonthFinance(state, countryId, config);
    expect(ledger.tax).toBeGreaterThan(0);
    expect(ledger.customs).toBeGreaterThanOrEqual(0);
    expect(ledger.exports).toBeGreaterThanOrEqual(0);
    expect(ledger.revenue).toBeCloseTo(ledger.tax + ledger.customs + ledger.exports, 2);
    // Spending = the derived budget pot (share of the production value).
    const record = state.economy.resources[countryId]!;
    const value = monthlyEconomyValueOf(record, config);
    expect(ledger.spending).toBeCloseTo(value * 0.12 + record.importCost, 1);
    game.dispose();
  });

  it('finance: a deficit floors the treasury at ZERO — NO debt machinery', () => {
    const game = createTestGame({ seed: 98 });
    const countryId = game.strategicMap.countryOrder[0];
    const state = game.gameState;
    // MAX spending pressure through the economic value and LOW tax revenue.
    const government = state.government.countries[countryId];
    government.budget.tax = 'low';
    state.economy.resources[countryId]!.importCost = 5_000; // a crushing bill
    state.economy.treasury[countryId] = 10;
    const ledger = processMonthFinance(state, countryId, game.gameContext.data.economyData.strategicResources);
    expect(ledger.balance).toBeLessThan(0);
    expect(state.economy.treasury[countryId]).toBe(0);
    // No debt field exists anywhere in the finance record.
    expect(state.economy.finance[countryId]).not.toHaveProperty('debt');
    game.dispose();
  });

  it('finance: a surplus raises the treasury', () => {
    const game = createTestGame({ seed: 99 });
    const countryId = game.strategicMap.countryOrder[0];
    const state = game.gameState;
    const government = state.government.countries[countryId];
    government.budget.tax = 'max';
    const treasuryBefore = state.economy.treasury[countryId];
    const ledger = processMonthFinance(state, countryId, game.gameContext.data.economyData.strategicResources);
    expect(ledger.balance).toBeGreaterThan(0);
    expect(state.economy.treasury[countryId]).toBeGreaterThan(treasuryBefore);
    game.dispose();
  });

  it('a general strike cuts tax collection until it ends', () => {
    const strikeGame = createTestGame({ seed: 100 });
    const calmGame = createTestGame({ seed: 100 });
    const strikeCountry = strikeGame.strategicMap.countryOrder[0];
    const calmCountry = calmGame.strategicMap.countryOrder[0];
    const config = strikeGame.gameContext.data.economyData.strategicResources;
    const government = strikeGame.gameState.government.countries[strikeCountry];
    government.politics.generalStrikeUntilMonth = government.lastSimMonth + 1;
    const strikeLedger = processMonthFinance(strikeGame.gameState, strikeCountry, config);
    const calmLedger = processMonthFinance(calmGame.gameState, calmCountry, calmGame.gameContext.data.economyData.strategicResources);
    expect(strikeLedger.tax).toBeLessThan(calmLedger.tax);
    strikeGame.dispose();
    calmGame.dispose();
  });
});
