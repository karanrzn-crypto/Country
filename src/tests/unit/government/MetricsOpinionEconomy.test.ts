import { describe, it, expect } from 'vitest';
import { createTestGame } from '../../helpers/testGame';
import { readMetric, applyEffectBundle, applyInstantEffect, evaluateConditions, militaryPowerOf } from '../../../government/Metrics';
import { updateOpinionTopics, driftApproval, approvalTargetOf } from '../../../government/PublicOpinion';
import { createMacroEconomy, processMonthEconomy } from '../../../economy/EconomySimulation';
import { deriveSpendingShares } from '../../../state/slices/governmentSlice';
import { Random } from '../../../utils/Random';

describe('Metrics + PublicOpinion + monthly economy (Phase 2 causality)', () => {
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
        { target: 'treasury', mode: 'add', value: -500 },
        { target: 'approval', mode: 'add', value: 0.02 },
        { target: 'sector.technology', mode: 'mul', value: 0.1, durationMonths: 6 }
      ],
      'test:bundle'
    );
    expect(modifiers.length).toBe(1);
    expect(state.economy.treasury[countryId]).toBeCloseTo(treasuryBefore - 500, 4);
    expect(state.government.countries[countryId].president.approval).toBeCloseTo(approvalBefore + 0.02, 9);
    const techBase = state.economy.macro[countryId].sectors.technology.output;
    expect(readMetric(state, countryId, 'sector.technology')).toBeCloseTo(techBase * 1.1, 6);
    game.dispose();
  });

  it('instant effects clamp into their domains', () => {
    const game = createTestGame({ seed: 92 });
    const countryId = game.strategicMap.countryOrder[0];
    const state = game.gameState;
    applyInstantEffect(state, countryId, { target: 'approval', mode: 'add', value: 5 });
    expect(state.government.countries[countryId].president.approval).toBe(1);
    applyInstantEffect(state, countryId, { target: 'corruption', mode: 'add', value: -5 });
    expect(state.government.countries[countryId].politics.corruption).toBe(0);
    game.dispose();
  });

  it('condition evaluation reads current metrics (gte/lte)', () => {
    const game = createTestGame({ seed: 93 });
    const countryId = game.strategicMap.countryOrder[0];
    const state = game.gameState;
    state.government.countries[countryId].president.approval = 0.4;
    expect(evaluateConditions(state, countryId, [{ metric: 'approval', op: 'lte', value: 0.5 }])).toBe(true);
    expect(evaluateConditions(state, countryId, [{ metric: 'approval', op: 'gte', value: 0.5 }])).toBe(false);
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

  it('opinion topics react to misery and approval drifts toward the blended target', () => {
    const game = createTestGame({ seed: 95 });
    const countryId = game.strategicMap.countryOrder[0];
    const state = game.gameState;
    const government = state.government.countries[countryId];
    // Disaster economy + MAX tax.
    state.economy.macro[countryId].unemployment = 0.25;
    state.economy.macro[countryId].inflation = 0.2;
    state.economy.macro[countryId].gdpGrowth = -0.05;
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

  it('macro economy: a higher tax level yields higher monthly revenue (same state)', () => {
    const lowTaxGame = createTestGame({ seed: 96 });
    const highTaxGame = createTestGame({ seed: 96 });
    const lowCountry = lowTaxGame.strategicMap.countryOrder[0];
    const highCountry = highTaxGame.strategicMap.countryOrder[0];
    lowTaxGame.gameState.government.countries[lowCountry].budget.tax = 'low';
    highTaxGame.gameState.government.countries[highCountry].budget.tax = 'max';

    processMonthEconomy(lowTaxGame.gameState, lowCountry, new Random(1));
    processMonthEconomy(highTaxGame.gameState, highCountry, new Random(1));

    const lowRevenue = lowTaxGame.gameState.economy.macro[lowCountry].lastRevenue;
    const highRevenue = highTaxGame.gameState.economy.macro[highCountry].lastRevenue;
    expect(highRevenue).toBeGreaterThan(lowRevenue);
    lowTaxGame.dispose();
    highTaxGame.dispose();
  });

  it('macro economy: deficit lands on the treasury first, then debt absorbs the rest', () => {
    const game = createTestGame({ seed: 97 });
    const countryId = game.strategicMap.countryOrder[0];
    const state = game.gameState;
    // Crush revenue to force a deep deficit: LOW tax, huge spending.
    const government = state.government.countries[countryId];
    government.budget.tax = 'low';
    government.budget.spendingShares = {
      military: 0.3, healthcare: 0.3, education: 0.3, infrastructure: 0.3, welfare: 0.3, government: 0.3, other: 0.3
    };
    state.economy.treasury[countryId] = 100;
    const ledger = processMonthEconomy(state, countryId, new Random(1));
    expect(ledger.balance).toBeLessThan(0);
    expect(state.economy.treasury[countryId]).toBe(0);
    expect(state.economy.macro[countryId].debt).toBeGreaterThan(0);
    game.dispose();
  });

  it('macro economy: surplus raises the treasury and pays down debt', () => {
    const game = createTestGame({ seed: 98 });
    const countryId = game.strategicMap.countryOrder[0];
    const state = game.gameState;
    state.economy.macro[countryId].debt = 5000;
    const government = state.government.countries[countryId];
    government.budget.tax = 'max';
    government.budget.spendingShares = {
      military: 0.001, healthcare: 0.001, education: 0.001, infrastructure: 0.001, welfare: 0.001, government: 0.001, other: 0.001
    };
    const treasuryBefore = state.economy.treasury[countryId];
    const ledger = processMonthEconomy(state, countryId, new Random(1));
    expect(ledger.balance).toBeGreaterThan(0);
    expect(state.economy.treasury[countryId]).toBeGreaterThan(treasuryBefore);
    expect(state.economy.macro[countryId].debt).toBeLessThan(5000);
    game.dispose();
  });

  it('a general strike idles industrial jobs until it ends', () => {
    const strikeGame = createTestGame({ seed: 99 });
    const calmGame = createTestGame({ seed: 99 });
    const strikeCountry = strikeGame.strategicMap.countryOrder[0];
    const calmCountry = calmGame.strategicMap.countryOrder[0];
    const government = strikeGame.gameState.government.countries[strikeCountry];
    government.politics.generalStrikeUntilMonth = government.lastSimMonth + 1;
    processMonthEconomy(strikeGame.gameState, strikeCountry, new Random(1));
    processMonthEconomy(calmGame.gameState, calmCountry, new Random(1));
    const strikeJobs = strikeGame.gameState.economy.macro[strikeCountry].sectors.industry.jobs;
    const calmJobs = calmGame.gameState.economy.macro[calmCountry].sectors.industry.jobs;
    expect(strikeJobs).toBeLessThan(calmJobs);
    strikeGame.dispose();
    calmGame.dispose();
  });

  it('createMacroEconomy starts with ≈ 7 % unemployment and consistent sectors', () => {
    const macro = createMacroEconomy(2_000_000);
    expect(macro.unemployment).toBeGreaterThan(0.05);
    expect(macro.unemployment).toBeLessThan(0.1);
    let gdp = 0;
    for (const sector of Object.values(macro.sectors)) {
      expect(sector.jobs).toBeGreaterThan(0);
      expect(sector.productivity).toBeGreaterThan(0);
      gdp += sector.output;
    }
    expect(macro.gdp).toBeCloseTo(gdp, 0);
  });
});
