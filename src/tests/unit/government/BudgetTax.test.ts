import { describe, it, expect } from 'vitest';
import { createTestGame } from '../../helpers/testGame';
import { Game } from '../../../core/Game';
import { MemorySaveStorage } from '../../../save/SaveStorage';
import { validateGameState } from '../../../state/validate';
import { updateOpinionTopics, driftApproval, approvalTargetOf } from '../../../government/PublicOpinion';
import { produceMilitary } from '../../../government/budgetEffects';
import { taxIncomeOf } from '../../../economy/economyCycle';
import type { TaxLevel } from '../../../government/types';
import type { InMemoryUIElement } from '../../helpers/InMemoryDomAdapter';
import { InMemoryDomAdapter } from '../../helpers/InMemoryDomAdapter';
import { ScreenManager } from '../../../ui/ScreenManager';
import { PresidentDashboard } from '../../../ui/PresidentDashboard';
import type { Game as GameType } from '../../../core/Game';

/**
 * The Budget & Tax redesign (spec §1–§11):
 *  - ONE 100% pool split between Economic and Military (zero-sum invariant).
 *  - REAL effects: economic share → construction/development speed +
 *    satisfaction; military share → weapon/equipment production.
 *  - ONE tax level (LOW/MEDIUM/HIGH/MAX) with real buffs in GameState.
 *  - NO legacy tax categories or budget categories anywhere.
 */

function meanDevelopment(game: GameType, countryId: string): number {
  const areas = Object.values(game.gameState.cityAreas.network.areas).filter(
    (area) => area.countryId === countryId
  );
  if (areas.length === 0) return 0;
  return areas.reduce((sum, area) => sum + area.development, 0) / areas.length;
}

describe('Budget & Tax redesign — the required contract (spec §11)', () => {
  it('1·2·3. Economic + Military ALWAYS sum to 100%; moving one pool moves the other by the SAME amount (both directions)', () => {
    const game = createTestGame({ seed: 301 });
    const countryId = game.strategicMap.countryOrder[0];
    const budget = game.gameState.government.countries[countryId].budget;
    // Every country starts at the documented default: 50% + 50%.
    for (const record of Object.values(game.gameState.government.countries)) {
      expect(record.budget.shares.economic + record.budget.shares.military).toBeCloseTo(1, 12);
      expect(record.budget.shares.economic).toBeCloseTo(0.5, 12);
    }

    // Raise Economic by +10 points → Military drops by exactly 10 points.
    const ecoBefore = budget.shares.economic;
    const milBefore = budget.shares.military;
    game.governmentSetBudgetShare(countryId, 'economic', 0.6);
    game.commandBus.flush();
    expect(budget.shares.economic - ecoBefore).toBeCloseTo(0.1, 9);
    expect(milBefore - budget.shares.military).toBeCloseTo(0.1, 9);
    expect(budget.shares.economic + budget.shares.military).toBeCloseTo(1, 12);

    // Raise Military by +40 points → Economic drops by exactly 40 points.
    game.governmentSetBudgetShare(countryId, 'military', 0.7);
    game.commandBus.flush();
    expect(budget.shares.military).toBeCloseTo(0.7, 9);
    expect(budget.shares.economic).toBeCloseTo(0.3, 9);
    expect(budget.shares.economic + budget.shares.military).toBeCloseTo(1, 12);

    // Clamped extremes keep the invariant too.
    game.governmentSetBudgetShare(countryId, 'economic', 5);
    game.commandBus.flush();
    expect(budget.shares.economic).toBe(1);
    expect(budget.shares.military).toBe(0);
    game.dispose();
  });

  it('4. the Economic Budget REALLY changes construction/development speed (same seed, 12 months)', () => {
    const run = (pool: 'economic' | 'military', value: number): { start: number; end: number } => {
      const game = createTestGame({ seed: 302 });
      const countryId = game.strategicMap.countryOrder[0];
      game.commandBus.send({ type: 'player.confirmCountry', countryId });
      game.commandBus.send({ type: 'government.setBudgetShare', countryId, pool, value });
      game.commandBus.flush();
      const start = meanDevelopment(game, countryId);
      game.setTimeMode('month');
      game.runTicks(180); // 12 months through the REAL GovernmentSystem
      const end = meanDevelopment(game, countryId);
      game.dispose();
      return { start, end };
    };
    const economyFirst = run('economic', 0.95);
    const gunsFirst = run('military', 0.95);
    // The CONSTRUCTION SPEED is the real state difference: economy-heavy
    // grows toward its high target much faster than guns-heavy toward its
    // low one — both the 12-month gain and the final level are strictly
    // higher on the economy-first posture.
    expect(economyFirst.end - economyFirst.start).toBeGreaterThan(gunsFirst.end - gunsFirst.start);
    expect(economyFirst.end).toBeGreaterThan(gunsFirst.end);
  });

  it('5. the Economic Budget REALLY changes population satisfaction (services sentiment → approval)', () => {
    const run = (economic: number): { approval: number; services: number; target: number } => {
      const game = createTestGame({ seed: 303 });
      const countryId = game.strategicMap.countryOrder[0];
      game.commandBus.send({ type: 'player.confirmCountry', countryId });
      game.commandBus.send({ type: 'government.setBudgetShare', countryId, pool: 'economic', value: economic });
      game.commandBus.flush();
      const government = game.gameState.government.countries[countryId];
      government.president.approval = 0.5; // identical start for both runs
      for (let month = 0; month < 6; month += 1) {
        updateOpinionTopics(game.gameState, countryId);
        driftApproval(game.gameState, countryId, 0.25);
      }
      const result = {
        approval: government.president.approval,
        services: government.opinion.topics.services,
        target: approvalTargetOf(government.opinion.topics)
      };
      game.dispose();
      return result;
    };
    const rich = run(0.9);
    const poor = run(0.1);
    // The satisfaction system itself (opinion topics ARE GameState)…
    expect(rich.services).toBeGreaterThan(poor.services);
    expect(rich.target).toBeGreaterThan(poor.target);
    // …and the president's approval really follows over the months.
    expect(rich.approval).toBeGreaterThan(poor.approval);
  });

  it('6. the Military Budget REALLY changes military production speed (equipment + army, 12 months)', () => {
    const run = (militaryShare: number): { equipment: number; army: number } => {
      const game = createTestGame({ seed: 304 });
      const countryId = game.strategicMap.countryOrder[0];
      const government = game.gameState.government.countries[countryId];
      government.budget.shares = { economic: 1 - militaryShare, military: militaryShare };
      const country = game.gameState.countries.countries[countryId];
      const equipmentStart = country.military.equipment;
      const armyStart = country.military.armySize;
      const config = game.gameContext.data.economyData.strategicResources;
      for (let month = 0; month < 12; month += 1) {
        produceMilitary(game.gameState, countryId, config.militaryMaterials);
      }
      const result = {
        equipment: country.military.equipment - equipmentStart,
        army: country.military.armySize - armyStart
      };
      game.dispose();
      return result;
    };
    const wellFunded = run(0.9);
    const starved = run(0.1);
    expect(wellFunded.equipment).toBeGreaterThan(starved.equipment);
    expect(wellFunded.army).toBeGreaterThan(starved.army);
    // Production is genuinely budget-scaled (not a token difference).
    expect(wellFunded.equipment).toBeGreaterThan(starved.equipment * 3);
  });

  it('7·8·9. کم positive buff, متوسط neutral, زیاد negative (spec §9)', () => {
    const game = createTestGame({ seed: 305 });
    const countryId = game.strategicMap.countryOrder[0];
    const state = game.gameState;
    const government = state.government.countries[countryId];

    const sentimentAt = (level: TaxLevel): number => {
      government.budget.tax = level;
      updateOpinionTopics(state, countryId);
      return government.opinion.topics.taxes;
    };
    const low = sentimentAt('low');
    const medium = sentimentAt('medium');
    const high = sentimentAt('high');

    // کم carries a POSITIVE buff; متوسط is exactly neutral; زیاد is negative.
    expect(low).toBeGreaterThan(0);
    expect(medium).toBe(0);
    expect(high).toBeLessThan(0);
    // متوسط keeps the approval target at the calm baseline; کم raises it and
    // زیاد lowers it (the §9 stability side through the REAL opinion topics).
    government.budget.tax = 'medium';
    updateOpinionTopics(state, countryId);
    const mediumTarget = approvalTargetOf(government.opinion.topics);
    government.budget.tax = 'low';
    updateOpinionTopics(state, countryId);
    expect(approvalTargetOf(government.opinion.topics)).toBeGreaterThan(mediumTarget);
    government.budget.tax = 'high';
    updateOpinionTopics(state, countryId);
    expect(approvalTargetOf(government.opinion.topics)).toBeLessThan(mediumTarget);
    game.dispose();

    // The MONEY side is ordered too (§2): زیاد collects more than کم —
    // the simple formula through the REAL config.
    const config = game.gameContext.data.economyData.strategicResources;
    const population = 24_000_000;
    const lowRevenue = taxIncomeOf(population, 'low', config);
    const highRevenue = taxIncomeOf(population, 'high', config);
    expect(highRevenue).toBeGreaterThan(lowRevenue);
  });

  it('11. changing the tax level REALLY changes GameState through the live month cadence (revenue + opinion)', () => {
    const run = (level: TaxLevel): { revenue: number; taxes: number } => {
      const game = createTestGame({ seed: 307 });
      const countryId = game.strategicMap.countryOrder[0];
      game.commandBus.send({ type: 'player.confirmCountry', countryId });
      game.commandBus.send({ type: 'government.setTaxLevel', countryId, level });
      game.commandBus.flush();
      game.setTimeMode('month');
      game.runTicks(30); // 2 months through the REAL GovernmentSystem
      const result = {
        revenue: game.gameState.economy.finance[countryId]!.lastTaxIncome,
        taxes: game.gameState.government.countries[countryId].opinion.topics.taxes
      };
      game.dispose();
      return result;
    };
    const lowRun = run('low');
    const highRun = run('high');
    expect(highRun.revenue).toBeGreaterThan(lowRun.revenue);
    expect(highRun.taxes).toBeLessThan(lowRun.taxes);
  });

  it('12. NO legacy tax category survives in state or schema', () => {
    const game = createTestGame({ seed: 309 });
    for (const record of Object.values(game.gameState.government.countries)) {
      const budget = record.budget as unknown as Record<string, unknown>;
      expect('taxRates' in budget).toBe(false);
      expect(budget['income']).toBeUndefined();
      expect(budget['corporate']).toBeUndefined();
      expect(budget['trade']).toBeUndefined();
      expect(['low', 'medium', 'high', 'max']).toContain(record.budget.tax);
    }
    // The state (with the NEW budget shape) is schema-valid.
    expect(validateGameState(game.gameState).valid).toBe(true);
    game.dispose();
  });

  it('13. NO legacy budget category survives in the UI — two pool rows + four tax levels only', () => {
    const game = createTestGame({ seed: 310 });
    const context = game.gameContext;
    const countryId = game.strategicMap.countryOrder[0];
    game.commandBus.send({ type: 'player.confirmCountry', countryId });
    game.commandBus.flush();
    const adapter = new InMemoryDomAdapter();
    const screens = new ScreenManager(adapter, game.gameEvents);
    const dashboard = new PresidentDashboard(screens, game.commandBus, (tag, className) => adapter.create(tag, className));
    dashboard.register(context);
    dashboard.openAt('budget');
    // ScreenManager runs the builder BEFORE marking the screen open, so the
    // build-time refresh bails — refresh once now that the screen is open.
    dashboard.refresh();

    let budgetSection: InMemoryUIElement | undefined;
    const find = (root: InMemoryUIElement): void => {
      if (root.className.includes('pd-budget') && root.className.includes('on')) budgetSection = root;
      for (const child of root.children) find(child);
    };
    find(adapter.rootElement);
    expect(budgetSection).toBeDefined();

    const textOf = (element: InMemoryUIElement): string =>
      element.text + element.children.map((child) => textOf(child)).join(' ');
    const text = textOf(budgetSection as InMemoryUIElement);

    // Legacy tax categories are GONE.
    expect(text).not.toContain('مالیات بر درآمد');
    expect(text).not.toContain('مالیات شرکتی');
    expect(text).not.toContain('عوارض تجاری');
    // No GDP-share wording, no independent spending categories.
    expect(text).not.toContain('تولید ناخالص');
    expect(text).not.toContain('بهداشت');
    expect(text).not.toContain('آموزش');
    expect(text).not.toContain('رفاه');

    // The NEW structure is present: the two pool rows + the three levels.
    expect(text).toContain('بودجهٔ اقتصادی');
    expect(text).toContain('بودجهٔ نظامی');
    for (const label of ['کم', 'متوسط', 'زیاد']) {
      expect(text).toContain(label);
    }
    expect(text).not.toContain('حداکثر');

    // Exactly ONE level is marked selected, and it matches the state (default MEDIUM).
    const collect = (): InMemoryUIElement[] => {
      const levels: InMemoryUIElement[] = [];
      const walk = (root: InMemoryUIElement): void => {
        // Word-boundary match: 'pd-tax-levels' (the container) must NOT count.
        if (/(^| )pd-tax-level( |$)/.test(root.className)) levels.push(root);
        for (const child of root.children) walk(child);
      };
      walk(adapter.rootElement);
      return levels;
    };
    const levelsBefore = collect();
    expect(levelsBefore.length).toBe(3);
    const selectedBefore = levelsBefore.filter((level) => level.className.includes('on'));
    expect(selectedBefore.length).toBe(1);
    expect(textOf(selectedBefore[0])).toContain('متوسط');

    // Selecting زیاد through the command moves the mark (state-driven UI).
    game.commandBus.send({ type: 'government.setTaxLevel', countryId, level: 'high' });
    game.commandBus.flush();
    dashboard.refresh();
    const selectedAfter = collect().filter((level) => level.className.includes('on'));
    expect(selectedAfter.length).toBe(1);
    expect(textOf(selectedAfter[0])).toContain('زیاد');
    screens.close('president');
    game.dispose();
  });

  it('the pool split and tax level survive the save/load roundtrip (still 100%)', () => {
    const seed = 311;
    const storage = new MemorySaveStorage();
    const game = new Game({ seed, saveStorage: storage });
    game.init();
    const countryId = game.strategicMap.countryOrder[0];
    game.commandBus.send({ type: 'player.confirmCountry', countryId });
    game.commandBus.send({ type: 'government.setBudgetShare', countryId, pool: 'economic', value: 0.65 });
    game.commandBus.send({ type: 'government.setTaxLevel', countryId, level: 'high' });
    game.commandBus.flush();
    game.saveToSlot('budget-slot');

    const game2 = new Game({ seed, saveStorage: storage });
    game2.init();
    game2.loadFromSlot('budget-slot');
    const loaded = game2.gameState.government.countries[countryId].budget;
    expect(loaded.shares.economic).toBeCloseTo(0.65, 9);
    expect(loaded.shares.military).toBeCloseTo(0.35, 9);
    expect(loaded.tax).toBe('high');
    expect(validateGameState(game2.gameState).valid).toBe(true);
    game.dispose();
    game2.dispose();
  });
});
