import { describe, it, expect } from 'vitest';
import { createTestGame } from '../helpers/testGame';
import { Game } from '../../core/Game';
import { MemorySaveStorage } from '../../save/SaveStorage';
import { validateGameState } from '../../state/validate';
import { hashValue } from '../../utils/hash';
import { absoluteMonthIndex } from '../../time/Calendar';

describe('Phase 2 — governance integration (headless, renderer-free)', () => {
  it('state creation is schema-valid with the new government + cityAreas slices', () => {
    const game = createTestGame({ seed: 200 });
    const result = validateGameState(game.gameState);
    expect(result.valid).toBe(true);
    expect(Object.keys(game.gameState.government.countries).length).toBe(game.strategicMap.stats.countries);
    game.dispose();
  });

  it('confirming a country registers the president the player controls', () => {
    const game = createTestGame({ seed: 201 });
    const countryId = game.strategicMap.countryOrder[0];
    game.commandBus.send({ type: 'player.confirmCountry', countryId });
    game.commandBus.flush();
    expect(game.gameState.player.countryConfirmed).toBe(true);
    expect(game.gameState.player.countryId).toBe(countryId);
    const government = game.gameState.government.countries[countryId];
    expect(government).toBeDefined();
    expect(government.president.name.length).toBeGreaterThan(0);
    game.dispose();
  });

  it('months are processed exactly once each (catch-up across time modes)', () => {
    const game = createTestGame({ seed: 202 });
    const countryId = game.strategicMap.countryOrder[0];
    game.commandBus.send({ type: 'player.confirmCountry', countryId });
    // Month mode: one calendar month per 15 sim ticks.
    game.setTimeMode('month');
    game.runTicks(45); // → 3 months
    const government = game.gameState.government.countries[countryId];
    const currentMonth = absoluteMonthIndex(game.gameTime.date, game.gameTime.startDate);
    expect(government.lastSimMonth).toBe(Math.min(3, currentMonth));
    expect(government.lastSimMonth).toBeGreaterThanOrEqual(2);
    game.dispose();
  });

  it('the monthly economy moves the treasury and stays inside all domains', () => {
    const game = createTestGame({ seed: 203 });
    const countryId = game.strategicMap.countryOrder[0];
    game.commandBus.send({ type: 'player.confirmCountry', countryId });
    game.setTimeMode('month');
    game.runTicks(150); // ≈ 10 months
    const government = game.gameState.government.countries[countryId];
    const macro = game.gameState.economy.macro[countryId];
    expect(government.lastSimMonth).toBeGreaterThanOrEqual(9);
    expect(macro.gdp).toBeGreaterThan(0);
    expect(macro.unemployment).toBeGreaterThanOrEqual(0);
    expect(macro.unemployment).toBeLessThanOrEqual(1);
    expect(macro.inflation).toBeGreaterThanOrEqual(-0.2);
    expect(macro.gdpGrowth).toBeGreaterThanOrEqual(-0.5);
    expect(macro.gdpGrowth).toBeLessThanOrEqual(0.5);
    expect(macro.lastRevenue).toBeGreaterThan(0);
    expect(macro.lastSpending).toBeGreaterThan(0);
    expect(macro.lastBalance).toBeCloseTo(macro.lastRevenue - macro.lastSpending, 3);
    expect(government.president.approval).toBeGreaterThanOrEqual(0);
    expect(government.president.approval).toBeLessThanOrEqual(1);
    expect(government.president.termEndMonth).toBeGreaterThanOrEqual(government.lastSimMonth);
    // Political state evolves but stays clamped.
    expect(government.politics.corruption).toBeGreaterThanOrEqual(0);
    expect(government.politics.corruption).toBeLessThanOrEqual(1);
    expect(government.politics.publicTrust).toBeGreaterThanOrEqual(0);
    expect(validateGameState(game.gameState).valid).toBe(true);
    game.dispose();
  });

  it('presidential decisions flow through the command bus (enact, cooldown block, treasury effect)', () => {
    const game = createTestGame({ seed: 204 });
    const countryId = game.strategicMap.countryOrder[0];
    game.commandBus.send({ type: 'player.confirmCountry', countryId });
    game.setTimeMode('month');
    game.runTicks(30); // 2 months
    const state = game.gameState;
    state.economy.treasury[countryId] = 100_000;
    const treasuryBefore = state.economy.treasury[countryId];

    game.commandBus.send({ type: 'government.enactDecision', countryId, decisionId: 'industrial_subsidy' });
    game.commandBus.flush();
    expect(state.economy.treasury[countryId]).toBeCloseTo(treasuryBefore - 2000, 3);
    expect(state.government.countries[countryId].decisions.history[0]?.decisionId).toBe('industrial_subsidy');
    // Cooldown blocks the second attempt in the same month.
    game.commandBus.send({ type: 'government.enactDecision', countryId, decisionId: 'industrial_subsidy' });
    game.commandBus.flush();
    expect(state.economy.treasury[countryId]).toBeCloseTo(treasuryBefore - 2000, 3);
    expect(state.government.countries[countryId].decisions.history.length).toBe(1);
    // Unknown decision is a no-op.
    expect(game.governmentEnactDecision(countryId, 'not_a_decision')).toBe(false);
    game.dispose();
  });

  it('pending events resolve through the command bus with the chosen effects', () => {
    const game = createTestGame({ seed: 205 });
    const countryId = game.strategicMap.countryOrder[0];
    game.commandBus.send({ type: 'player.confirmCountry', countryId });
    const state = game.gameState;
    // Force a pending event (the data-driven definition comes from the registry).
    const event = game.gameData.event('worker_strike');
    state.government.countries[countryId].events.pending.push({
      instanceId: 'gevent-000001',
      eventId: event.id,
      firedMonth: 0,
      expiresMonth: state.government.countries[countryId].lastSimMonth + event.expireMonths
    });
    const treasuryBefore = state.economy.treasury[countryId];
    game.commandBus.send({ type: 'government.resolveEvent', countryId, instanceId: 'gevent-000001', choiceId: 'negotiate' });
    game.commandBus.flush();
    expect(state.government.countries[countryId].events.pending.length).toBe(0);
    expect(state.economy.treasury[countryId]).toBeCloseTo(treasuryBefore - 800, 3);
    game.dispose();
  });

  it('budget commands change policy through the clamped slice mutators', () => {
    const game = createTestGame({ seed: 206 });
    const countryId = game.strategicMap.countryOrder[0];
    game.commandBus.send({ type: 'player.confirmCountry', countryId });
    game.commandBus.send({ type: 'government.setBudgetShare', countryId, pool: 'economic', value: 0.6 });
    game.commandBus.send({ type: 'government.setTaxLevel', countryId, level: 'high' });
    game.commandBus.send({ type: 'government.setMinistryFunding', countryId, ministryId: 'defense', value: 0.8 });
    game.commandBus.flush();
    const government = game.gameState.government.countries[countryId];
    expect(government.budget.shares.economic).toBeCloseTo(0.6, 9);
    expect(government.budget.shares.military).toBeCloseTo(0.4, 9);
    expect(government.budget.tax).toBe('high');
    expect(government.ministries.defense.funding).toBeCloseTo(0.8, 9);
    // Out-of-range values clamp instead of corrupting state (pool sum stays 1).
    game.commandBus.send({ type: 'government.setBudgetShare', countryId, pool: 'economic', value: 9 });
    game.commandBus.flush();
    expect(government.budget.shares.economic).toBe(1);
    expect(government.budget.shares.military).toBe(0);
    game.dispose();
  });

  it('the full Phase 2 state survives the save/load roundtrip', () => {
    const seed = 207;
    const storage = new MemorySaveStorage();
    const game = new Game({ seed, saveStorage: storage });
    game.init();
    const countryId = game.strategicMap.countryOrder[0];
    game.commandBus.send({ type: 'player.confirmCountry', countryId });
    game.commandBus.flush();
    game.setTimeMode('month');
    game.runTicks(30);
    // Make distinctive runtime changes, then save. (Treasury must cover the
    // decision cost BEFORE enacting; the final value is set after so the
    // roundtrip expectation is unambiguous.)
    game.gameState.economy.treasury[countryId] = 50_000;
    expect(game.governmentEnactDecision(countryId, 'industrial_subsidy')).toBe(true);
    game.gameState.economy.treasury[countryId] = 55_555;
    const areaId = Object.keys(game.gameState.cityAreas.network.areas)[0];
    game.gameState.cityAreas.network.areas[areaId].development = 0.87;
    game.saveToSlot('phase2-slot');
    const game2 = new Game({ seed, saveStorage: storage });
    game2.init();
    game2.loadFromSlot('phase2-slot');
    const loadedGovernment = game2.gameState.government.countries[countryId];
    const loadedMacro = game2.gameState.economy.macro[countryId];
    expect(loadedGovernment).toBeDefined();
    expect(loadedMacro).toBeDefined();
    expect(game2.gameState.economy.treasury[countryId]).toBe(55_555);
    expect(loadedGovernment.decisions.history[0]?.decisionId).toBe('industrial_subsidy');
    expect(game2.gameState.cityAreas.network.areas[areaId].development).toBeCloseTo(0.87, 9);
    expect(game2.gameState.player.countryId).toBe(countryId);
    expect(validateGameState(game2.gameState).valid).toBe(true);
    game.dispose();
    game2.dispose();
  });

  it('same seed + same ticks → identical state hash (deterministic Phase 2 sim)', () => {
    const run = (seed: number): string => {
      const game = createTestGame({ seed });
      game.commandBus.send({ type: 'player.confirmCountry', countryId: game.strategicMap.countryOrder[0] });
      game.setTimeMode('month');
      game.runTicks(45);
      const hash = hashValue(game.gameState);
      game.dispose();
      return hash.toString(16);
    };
    expect(run(210)).toBe(run(210));
    expect(run(210)).not.toBe(run(211));
  });
});
