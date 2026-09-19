/**
 * THE ECONOMIC EVENTS (the events directive §5/§6) — simple, TEMPORARY,
 * config-driven production shocks that the real economy FEELS:
 *
 *  E1  an active event cuts the country's REAL production of its good by
 *      the config factor (broken refinery → oil ×0.5) — the cycle's one
 *      production pass applies it, nothing else;
 *  E2  the event EXPIRES after its duration — production returns to
 *      normal BY ITSELF (nothing is permanent, «اقتصاد به حالت عادی
 *      برگردد»);
 *  E3  no event storms: the same event never runs twice in parallel and a
 *      country never exceeds maxConcurrent;
 *  E4  THE FAMINE IS REAL (§6 — توزیع واقعی): with the food production cut
 *      and a dry warehouse the country records an honest SHORTAGE — the
 *      distributable food really fell and imports are the way out.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestGame } from '../../helpers/testGame';
import type { SystemContext } from '../../../core/GameContext';
import type { StrategicResourcesConfig } from '../../../economy/types';
import { runEconomyCycle } from '../../../economy/economyCycle';
import { activeEventsOf, economicEventFactorOf, stepEconomicEvents } from '../../../economy/economicEvents';
import type { Random } from '../../../utils/Random';

/** A fully-cooperative rng stub (every chance fires, deterministic picks). */
const yesRng = {
  chance: () => true,
  next: () => 0,
  int: () => 0
} as unknown as Random;

/** A never-firing rng stub (no event ever starts). */
const noRng = {
  chance: () => false,
  next: () => 0,
  int: () => 0
} as unknown as Random;

describe('the economic events (events directive §5/§6)', () => {
  let context: SystemContext;
  let config: StrategicResourcesConfig;

  beforeAll(() => {
    const game = createTestGame({ seed: 1010 });
    context = game.gameContext;
    config = context.data.economyData.strategicResources;
  });

  const ids = (): string[] =>
    context.map.countryOrder.filter((id) => context.state.economy.finance[id] !== undefined);

  it('E1 an active event cuts the REAL production of its good by the factor', () => {
    const state = context.state;
    const countryId = ids()[0];
    const record = state.economy.resources[countryId]!;
    // The baseline month (no events, no month step — just the pass):
    runEconomyCycle(state, context.map, config, { applyStep: true, month: 1 });
    const normalProduction = record.production.oil ?? 0;
    expect(normalProduction).toBeGreaterThan(0);
    expect(economicEventFactorOf(state, countryId, 'oil')).toBe(1);
    // The refinery breaks (×0.5 for 4 months):
    state.economy.events[countryId] = [
      {
        id: 'evt-e1',
        typeId: 'refinery_breakdown',
        resourceId: 'oil',
        factor: 0.5,
        monthsRemaining: 4,
        startedMonth: 1
      }
    ];
    expect(economicEventFactorOf(state, countryId, 'oil')).toBe(0.5);
    // The OTHER goods are untouched by the oil event (factor 1 → identical
    // per-path output).
    const foodBefore = record.production.food ?? 0;
    runEconomyCycle(state, context.map, config, { applyStep: true, month: 2 });
    // Per production path the factor rounds separately — the total sits
    // within 2 units of exactly half, and FAR below the normal output.
    expect(Math.abs(record.production.oil - normalProduction * 0.5)).toBeLessThanOrEqual(2);
    expect(record.production.oil).toBeLessThan(normalProduction);
    expect(record.production.food ?? 0).toBe(foodBefore);
  });

  it('E2 the event expires after its duration — the economy auto-recovers', () => {
    const state = context.state;
    const countryId = ids()[1];
    const record = state.economy.resources[countryId]!;
    state.economy.events[countryId] = [
      {
        id: 'evt-e2',
        typeId: 'refinery_breakdown',
        resourceId: 'oil',
        factor: 0.5,
        monthsRemaining: 2,
        startedMonth: 5
      }
    ];
    runEconomyCycle(state, context.map, config, { applyStep: true, month: 6 });
    const cut = record.production.oil ?? 0;
    // Age the event month by month (no new events — noRng): after two steps
    // it is gone and the very next pass produces at the NORMAL rate again.
    stepEconomicEvents(state, countryId, config, 7, noRng, () => 'x');
    stepEconomicEvents(state, countryId, config, 8, noRng, () => 'x');
    expect(activeEventsOf(state, countryId)).toHaveLength(0);
    runEconomyCycle(state, context.map, config, { applyStep: true, month: 9 });
    expect(record.production.oil).toBe(cut * 2); // back to ×1
  });

  it('E3 no storms: no duplicate type, maxConcurrent respected', () => {
    const state = context.state;
    const countryId = ids()[2];
    state.economy.events[countryId] = [
      {
        id: 'evt-e3',
        typeId: 'famine',
        resourceId: 'food',
        factor: 0.6,
        monthsRemaining: 5,
        startedMonth: 1
      }
    ];
    // The roll fires every month, but famine is ALREADY active and the
    // country sits AT maxConcurrent (1) — nothing new can start while the
    // famine lives.
    for (let month = 2; month <= 4; month += 1) {
      const outcome = stepEconomicEvents(state, countryId, config, month, yesRng, () => 'y');
      expect(outcome.started).toHaveLength(0);
      expect(activeEventsOf(state, countryId).map((event) => event.typeId)).toEqual(['famine']);
    }
    // Month 5: the famine still holds its last month (no room for a second).
    const fifth = stepEconomicEvents(state, countryId, config, 5, yesRng, () => 'y');
    expect(fifth.started).toHaveLength(0);
    expect(activeEventsOf(state, countryId)).toHaveLength(1);
    // Month 6: the famine AGES OUT (auto-recovery, §5) — and only NOW can a
    // DIFFERENT event start (the rng stub picks the config's first: the
    // refinery breakdown, 4 months).
    const sixth = stepEconomicEvents(state, countryId, config, 6, yesRng, () => 'y');
    expect(sixth.ended.map((event) => event.typeId)).toContain('famine');
    expect(sixth.started.map((event) => event.typeId)).toEqual(['refinery_breakdown']);
    expect(activeEventsOf(state, countryId)).toHaveLength(1);
    expect(activeEventsOf(state, countryId)[0]!.monthsRemaining).toBe(4);
  });

  it('E4 the famine is REAL: less food distributed → an honest shortage to import away', () => {
    const state = context.state;
    state.economy.contracts = [];
    const countryId = ids()[3];
    const record = state.economy.resources[countryId]!;
    // A dry warehouse — the cut cannot be absorbed by stock.
    record.stock = { food: 0, iron: 0, oil: 0, industrial: 0 };
    record.shortage = {};
    record.imports = {};
    state.economy.events[countryId] = [
      {
        id: 'evt-e4',
        typeId: 'famine',
        resourceId: 'food',
        factor: 0.6,
        monthsRemaining: 5,
        startedMonth: 10
      }
    ];
    runEconomyCycle(state, context.map, config, { applyStep: true, month: 11 });
    // The distribution really fell: the recorded shortage is exactly the
    // uncovered share of the need (consumption − event-scaled supply).
    const expected = Math.max(
      0,
      Math.round(
        (record.consumption.food ?? 0) -
          (record.production.food ?? 0) -
          (record.imports.food ?? 0)
      )
    );
    expect(record.shortage.food ?? 0).toBe(expected);
    expect(record.shortage.food ?? 0).toBeGreaterThan(0);
    // And the factor is gone the moment the event list is empty again.
    state.economy.events[countryId] = [];
    expect(economicEventFactorOf(state, countryId, 'food')).toBe(1);
  });
});
