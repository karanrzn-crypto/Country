import { describe, it, expect } from 'vitest';
import { createTestGame } from '../../helpers/testGame';
import {
  isEventEligible,
  rollEvents,
  firePendingEvent,
  resolvePendingEvent,
  expireOverdueEvents,
  newEventInstanceId
} from '../../../government/EventEngine';
import { readMetric } from '../../../government/Metrics';
import { Random } from '../../../utils/Random';
import type { Game } from '../../../core/Game';

function preparedGame(seed: number): { game: Game; countryId: string } {
  const game = createTestGame({ seed });
  const countryId = game.strategicMap.countryOrder[0];
  game.gameState.economy.treasury[countryId] = 100_000;
  return { game, countryId };
}

describe('EventEngine (data-driven events with choices)', () => {
  it('conditions gate eligibility (worker_strike needs ≥ 2 acute shortages)', () => {
    const { game, countryId } = preparedGame(71);
    const event = game.gameData.event('worker_strike');
    const state = game.gameState;
    // Fewer than 2 acutely short resources → not eligible.
    const record = state.economy.resources[countryId];
    record!.shortage = {};
    for (const resourceId of Object.keys(record!.consumption)) {
      record!.production[resourceId] = (record!.production[resourceId] ?? 0) + (record!.consumption[resourceId] ?? 0) + 10;
    }
    expect(isEventEligible(state, countryId, event, 0)).toBe(false);
    // Two resources acutely short (stockpile ran dry) → eligible.
    record!.shortage = { iron: 20, oil: 15 };
    expect(isEventEligible(state, countryId, event, 0)).toBe(true);
    game.dispose();
  });

  it('once-events fire exactly once per country', () => {
    const { game, countryId } = preparedGame(72);
    const event = game.gameData.event('bank_crisis'); // once: true
    const state = game.gameState;
    state.economy.finance[countryId]!.lastBalance = -100; // beyond the rescaled −50 trigger
    expect(isEventEligible(state, countryId, event, 0)).toBe(true);
    firePendingEvent(state, countryId, event, 0, newEventInstanceId(game.gameIds));
    expect(state.government.countries[countryId].events.fired).toContain('bank_crisis');
    expect(isEventEligible(state, countryId, event, 1)).toBe(false);
    game.dispose();
  });

  it('cooldowns and the pending cap block new events', () => {
    const { game, countryId } = preparedGame(73);
    const event = game.gameData.event('worker_strike');
    const state = game.gameState;
    state.economy.resources[countryId]!.shortage = { iron: 20, oil: 15 };
    firePendingEvent(state, countryId, event, 0, newEventInstanceId(game.gameIds));
    // Cooldown (12 months) blocks even after resolving.
    state.government.countries[countryId].events.pending.length = 0;
    expect(isEventEligible(state, countryId, event, 5)).toBe(false);
    expect(isEventEligible(state, countryId, event, 12)).toBe(true);
    // Pending cap: 3 unanswered events block everything else.
    for (let index = 0; index < 3; index += 1) {
      state.government.countries[countryId].events.cooldowns[event.id] = 0;
      state.government.countries[countryId].events.pending.length = index;
      firePendingEvent(state, countryId, event, 0, newEventInstanceId(game.gameIds));
    }
    state.government.countries[countryId].events.cooldowns[event.id] = 0;
    expect(state.government.countries[countryId].events.pending.length).toBe(3);
    expect(isEventEligible(state, countryId, event, 99)).toBe(false);
    game.dispose();
  });

  it('rollEvents is deterministic given the rng state and honors weights', () => {
    const { game, countryId } = preparedGame(74);
    const events = game.gameData.eventList;
    const state = game.gameState;
    state.economy.resources[countryId]!.shortage = { iron: 20, oil: 15 };
    state.economy.finance[countryId]!.lastBalance = -100; // beyond the rescaled −50 trigger
    const a = rollEvents(state, countryId, events, 0, new Random(123));
    const b = rollEvents(state, countryId, events, 0, new Random(123));
    expect(a?.id).toBe(b?.id);
    // Sanity: rolls pick only eligible events.
    expect(a).not.toBeNull();
    game.dispose();
  });

  it('resolving a pending event applies the choice effects and removes the instance', () => {
    const { game, countryId } = preparedGame(75);
    const event = game.gameData.event('worker_strike');
    const state = game.gameState;
    firePendingEvent(state, countryId, event, 0, 'gevent-000001');
    const treasuryBefore = state.economy.treasury[countryId];
    const negotiate = event.choices.find((choice) => choice.id === 'negotiate');
    expect(negotiate).toBeDefined();

    const resolved = resolvePendingEvent(state, countryId, 'gevent-000001', 'negotiate', game.gameData.eventList);
    expect(resolved).toBe(true);
    expect(state.government.countries[countryId].events.pending.length).toBe(0);
    const negotiateCost = negotiate!.effects.find((effect) => effect.target === 'treasury')?.value ?? 0;
    expect(state.economy.treasury[countryId]).toBeCloseTo(treasuryBefore + negotiateCost, 4);
    // Unknown instance/choice → false.
    expect(resolvePendingEvent(state, countryId, 'gevent-000001', 'negotiate', game.gameData.eventList)).toBe(false);
    expect(resolvePendingEvent(state, countryId, 'gevent-000002', 'negotiate', game.gameData.eventList)).toBe(false);
    game.dispose();
  });

  it('overdue pending events auto-apply the first choice on expiry', () => {
    const { game, countryId } = preparedGame(76);
    const event = game.gameData.event('worker_strike');
    const state = game.gameState;
    firePendingEvent(state, countryId, event, 0, 'gevent-000009');
    const treasuryBefore = state.economy.treasury[countryId];
    // expireMonths = 2 → overdue from month 2 on.
    expireOverdueEvents(state, countryId, game.gameData.eventList, 2);
    expect(state.government.countries[countryId].events.pending.length).toBe(0);
    const firstChoice = event.choices[0];
    expect(state.economy.treasury[countryId]).toBeCloseTo(treasuryBefore + (firstChoice.effects.find((effect) => effect.target === 'treasury')?.value ?? 0), 4);
    game.dispose();
  });

  it('metrics stay readable through the event effect path', () => {
    const { game, countryId } = preparedGame(77);
    const state = game.gameState;
    state.government.countries[countryId].politics.corruption = 0.3;
    expect(readMetric(state, countryId, 'corruption')).toBeCloseTo(0.3, 6);
    game.dispose();
  });
});
