/**
 * Event engine (Phase 2) — data-driven political/economic events with
 * presidential choices.
 *
 * Events are pure JSON (events.json): conditions, weight, cooldown, choices
 * with their own effect bundles. Each month the GovernmentSystem rolls
 * against eligible events; the pending instances wait in state for the
 * player's choice (or expire). AI/countries without a player simply let the
 * first choice auto-apply on expiry — the world never stalls.
 */

import type { GameState } from '../state/GameState';
import type { EventDef, PendingEvent } from './types';
import { MAX_PENDING_EVENTS } from './types';
import { applyEffectBundle, evaluateConditions } from './Metrics';
import type { Random } from '../utils/Random';
import type { IdGenerator } from '../core/IdGenerator';

/** True when an event may fire for a country this month (conditions+cooldown+once). */
export function isEventEligible(
  state: GameState,
  countryId: string,
  event: EventDef,
  month: number
): boolean {
  const government = state.government.countries[countryId];
  if (government === undefined) return false;
  if (event.once && government.events.fired.includes(event.id)) return false;
  const cooldownUntil = government.events.cooldowns[event.id];
  if (cooldownUntil !== undefined && month < cooldownUntil) return false;
  if (government.events.pending.length >= MAX_PENDING_EVENTS) return false;
  return evaluateConditions(state, countryId, event.conditions);
}

/**
 * Weighted pick among eligible events (deterministic given the rng state).
 * Returns null when nothing is eligible.
 */
export function rollEvents(
  state: GameState,
  countryId: string,
  events: readonly EventDef[],
  month: number,
  rng: Random
): EventDef | null {
  const eligible = events.filter((event) => isEventEligible(state, countryId, event, month));
  if (eligible.length === 0) return null;
  const totalWeight = eligible.reduce((sum, event) => sum + Math.max(0, event.weight), 0);
  if (totalWeight <= 0) return null;
  let roll = rng.next() * totalWeight;
  for (const event of eligible) {
    roll -= Math.max(0, event.weight);
    if (roll <= 0) return event;
  }
  return eligible[eligible.length - 1];
}

/**
 * Creates a pending event instance in state and starts the event cooldown.
 * Emits nothing here — the SYSTEM emits (engines stay event-silent).
 */
export function firePendingEvent(state: GameState, countryId: string, event: EventDef, month: number, instanceId: string): PendingEvent {
  const government = state.government.countries[countryId];
  const pending: PendingEvent = {
    instanceId,
    eventId: event.id,
    firedMonth: month,
    expiresMonth: month + event.expireMonths
  };
  government.events.pending.push(pending);
  government.events.cooldowns[event.id] = month + event.cooldownMonths;
  if (event.once) government.events.fired.push(event.id);
  return pending;
}

/**
 * Resolves a pending event with a choice: applies the choice's effects and
 * removes the instance. Returns false when instance/choice is unknown.
 */
export function resolvePendingEvent(
  state: GameState,
  countryId: string,
  instanceId: string,
  choiceId: string,
  eventDefs: readonly EventDef[]
): boolean {
  const government = state.government.countries[countryId];
  if (government === undefined) return false;
  const index = government.events.pending.findIndex((pending) => pending.instanceId === instanceId);
  if (index === -1) return false;
  const pending = government.events.pending[index];
  const event = eventDefs.find((candidate) => candidate.id === pending.eventId);
  if (event === undefined) return false;
  const choice = event.choices.find((candidate) => candidate.id === choiceId);
  if (choice === undefined) return false;

  applyEffectBundle(state, countryId, choice.effects, `${event.id}:${choiceId}`);
  government.events.pending.splice(index, 1);
  return true;
}

/** Monthly maintenance: expires overdue pending events (first choice auto-applied — the "do nothing" default). */
export function expireOverdueEvents(state: GameState, countryId: string, eventDefs: readonly EventDef[], month: number): void {
  const government = state.government.countries[countryId];
  if (government === undefined) return;
  const overdue = government.events.pending.filter((pending) => month >= pending.expiresMonth);
  for (const pending of overdue) {
    const event = eventDefs.find((candidate) => candidate.id === pending.eventId);
    if (event === undefined) {
      const index = government.events.pending.indexOf(pending);
      if (index !== -1) government.events.pending.splice(index, 1);
      continue;
    }
    const fallbackChoice = event.choices[0];
    if (fallbackChoice !== undefined) {
      applyEffectBundle(state, countryId, fallbackChoice.effects, `${event.id}:${fallbackChoice.id}:expired`);
    }
    const index = government.events.pending.indexOf(pending);
    if (index !== -1) government.events.pending.splice(index, 1);
  }
}

/** Instance id generator (stable, unique per campaign via the id generator). */
export function newEventInstanceId(ids: IdGenerator): string {
  return ids.next('gevent');
}
