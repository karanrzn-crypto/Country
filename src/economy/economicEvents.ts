/**
 * THE ECONOMIC EVENTS (the events directive §5/§6) — simple, TEMPORARY,
 * config-driven production shocks:
 *
 *   - a broken refinery cuts the country's OIL output for a few months;
 *   - a famine cuts the FOOD output — the distributable food shrinks, the
 *     warehouse and the imports have to cover the gap, and a country that
 *     cannot import records a REAL shortage (the directive §6: the event
 *     must be visible in the real economy, not just in a message).
 *
 * Rules (§5):
 *   - events fire with a small monthly chance (config `checkChance`);
 *   - each event lasts `durationMonths` months and then the economy
 *     returns to normal BY ITSELF — nothing is permanently damaged;
 *   - a country never runs more than `maxConcurrent` events at once and
 *     never the same event twice in parallel (no event storms).
 *
 * OWNERSHIP (§13 — one writer per record family): THIS module owns the
 * event lifecycle (roll / tick / expire) and the CYCLE only READS the
 * active factor when it computes production (`economicEventFactorOf`) —
 * no parallel production path, no double application. The cycle itself
 * stays pure (no rng inside): the caller (GovernmentSystem) passes the
 * campaign rng, so replays stay deterministic.
 *
 * Leaf module: state types + config + utils only. Unit-testable without a
 * system harness.
 */

import type { GameState } from '../state/GameState';
import type { StrategicResourcesConfig } from './types';
import type { ActiveEconomicEvent } from './resourceTypes';
import type { Random } from '../utils/Random';

/** The active events of ONE country (live list, [] when none). */
export function activeEventsOf(state: GameState, countryId: string): ActiveEconomicEvent[] {
  return state.economy.events[countryId] ?? [];
}

/**
 * The TOTAL production factor of ONE country for ONE good THIS month —
 * the product of every active event's factor hitting that good (1 when
 * no event touches it). The ONE number the cycle's production paths
 * (deposits, baseline, buildings, extraction) multiply by.
 */
export function economicEventFactorOf(
  state: GameState,
  countryId: string,
  resourceId: string
): number {
  let factor = 1;
  for (const event of activeEventsOf(state, countryId)) {
    if (event.resourceId === resourceId && event.factor < factor) {
      factor = event.factor; // stacked events on ONE good take the STRONGEST cut
    }
  }
  return factor;
}

export interface EconomicEventStepOutcome {
  /** Events that STARTED this month (the caller notifies the president). */
  readonly started: readonly ActiveEconomicEvent[];
  /** Events that ENDED this month (the economy auto-recovered). */
  readonly ended: readonly ActiveEconomicEvent[];
}

/**
 * The MONTHLY EVENT STEP for ONE country (called once per campaign month
 * by the GovernmentSystem, before nothing else reads the factor — the
 * next cycle pass applies it):
 *
 *  ۱. AGE — every active event loses one month; those at zero are removed
 *     (the auto-recovery, §5) and reported as `ended`;
 *  ۲. ROLL — with `checkChance`, one weighted event from the config pool
 *     starts (respecting `maxConcurrent` and no-duplicate-per-type) and is
 *     reported as `started`.
 *
 * Deterministic: all randomness flows through the passed campaign rng.
 */
export function stepEconomicEvents(
  state: GameState,
  countryId: string,
  config: StrategicResourcesConfig,
  month: number,
  rng: Random,
  newId: (kind: string) => string
): EconomicEventStepOutcome {
  const eventsConfig = config.economicEvents;
  const active = state.economy.events[countryId] ?? [];
  const started: ActiveEconomicEvent[] = [];
  const ended: ActiveEconomicEvent[] = [];

  // —— ۱. age the active events (the auto-recovery) ——
  const survivors: ActiveEconomicEvent[] = [];
  for (const event of active) {
    event.monthsRemaining = Math.max(0, Math.round(event.monthsRemaining) - 1);
    if (event.monthsRemaining <= 0) ended.push(event);
    else survivors.push(event);
  }

  // —— ۲. maybe start ONE new event ——
  if (
    eventsConfig !== undefined &&
    eventsConfig.events.length > 0 &&
    survivors.length < Math.max(0, eventsConfig.maxConcurrent) &&
    rng.chance(Math.min(1, Math.max(0, eventsConfig.checkChance)))
  ) {
    const def = pickWeightedEvent(eventsConfig, survivors, rng);
    if (def !== null) {
      const instance: ActiveEconomicEvent = {
        id: newId('event'),
        typeId: def.id,
        resourceId: def.resource,
        factor: Math.max(0, Math.min(1, def.factor)),
        monthsRemaining: Math.max(1, Math.round(def.durationMonths)),
        startedMonth: month
      };
      survivors.push(instance);
      started.push(instance);
    }
  }

  state.economy.events[countryId] = survivors;
  return { started, ended };
}

/**
 * Weighted pick of ONE event definition that is not already active on the
 * country. Deterministic: the candidates are scanned in config order, the
 * wheel lands on a cumulative weight through the campaign rng.
 */
function pickWeightedEvent(
  eventsConfig: NonNullable<StrategicResourcesConfig['economicEvents']>,
  active: readonly ActiveEconomicEvent[],
  rng: Random
): (typeof eventsConfig.events)[number] | null {
  const activeTypes = new Set(active.map((event) => event.typeId));
  const candidates = eventsConfig.events.filter((def) => !activeTypes.has(def.id));
  if (candidates.length === 0) return null;
  const weights = candidates.map((def) => Math.max(0, def.weight ?? 1));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return candidates[rng.int(candidates.length)] ?? null;
  let wheel = rng.next() * total;
  for (let index = 0; index < candidates.length; index += 1) {
    wheel -= weights[index]!;
    if (wheel <= 0) return candidates[index]!;
  }
  return candidates[candidates.length - 1]!;
}
