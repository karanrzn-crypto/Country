/**
 * Decision engine (Phase 2) — enacts data-driven presidential decisions.
 *
 * A decision is pure JSON (decisions.json): preconditions, cost, effects,
 * duration, cooldown. This module is the ONLY code that touches state on
 * behalf of any decision, so new content never needs new logic.
 */

import type { GameState } from '../state/GameState';
import type { DecisionDef } from './types';
import { DECISION_HISTORY_LIMIT } from './types';
import { applyEffectBundle, evaluateConditions, readMetric } from './Metrics';

export type DecisionBlockReason =
  | 'unknown-decision'
  | 'preconditions'
  | 'treasury'
  | 'cooldown'
  | 'no-country';

/**
 * Why a decision cannot be enacted right now (null = it CAN).
 * Pure — the UI shows the reason, the command handler blocks on it.
 */
export function decisionBlockReason(
  state: GameState,
  countryId: string,
  decision: DecisionDef,
  month: number
): DecisionBlockReason | null {
  const government = state.government.countries[countryId];
  if (government === undefined) return 'no-country';
  const cooldownUntil = government.decisions.cooldowns[decision.id];
  if (cooldownUntil !== undefined && month < cooldownUntil) return 'cooldown';
  if (!evaluateConditions(state, countryId, decision.preconditions)) return 'preconditions';
  const cost = decision.cost.treasury ?? 0;
  if (cost > 0 && (state.economy.treasury[countryId] ?? 0) < cost) return 'treasury';
  return null;
}

/**
 * Enacts a decision: charges the cost, applies instant effects, registers
 * duration modifiers, starts the cooldown and records history. Caller MUST
 * check decisionBlockReason first (the command handler does).
 */
export function enactDecision(state: GameState, countryId: string, decision: DecisionDef, month: number): void {
  const government = state.government.countries[countryId];
  if (government === undefined) return;

  const cost = decision.cost.treasury ?? 0;
  if (cost !== 0) {
    state.economy.treasury[countryId] = (state.economy.treasury[countryId] ?? 0) - cost;
  }

  applyEffectBundle(state, countryId, decision.effects, decision.id, decision.durationMonths);

  government.decisions.cooldowns[decision.id] = month + decision.cooldownMonths;
  government.decisions.history.unshift({ decisionId: decision.id, month });
  if (government.decisions.history.length > DECISION_HISTORY_LIMIT) {
    government.decisions.history.length = DECISION_HISTORY_LIMIT;
  }
}

/** Monthly: decrements modifiers and drops expired ones. */
export function tickDecisionModifiers(state: GameState, countryId: string): void {
  const government = state.government.countries[countryId];
  if (government !== undefined) tickActiveList(government.decisions.active);
}

function tickActiveList(active: import('./types').ActiveModifier[]): void {
  let write = 0;
  for (let read = 0; read < active.length; read += 1) {
    const modifier = active[read];
    modifier.monthsLeft -= 1;
    if (modifier.monthsLeft > 0) {
      active[write] = modifier;
      write += 1;
    }
  }
  active.length = write;
}

/** Read-helper for UI: net treasury effect preview of a decision. */
export function decisionTreasuryPreview(state: GameState, countryId: string, decision: DecisionDef): number {
  void state;
  void countryId;
  return -(decision.cost.treasury ?? 0);
}

/** Read-helper for UI: current value of a decision's first precondition. */
export function preconditionCurrentValue(
  state: GameState,
  countryId: string,
  decision: DecisionDef
): number | null {
  const first = decision.preconditions[0];
  return first !== undefined ? readMetric(state, countryId, first.metric) : null;
}
