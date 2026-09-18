/**
 * Central metric vocabulary + effect application (Phase 2).
 *
 * Every data-driven effect (decision effect, event-choice effect) names a
 * METRIC from the vocabulary below; nothing in the simulation hard-codes a
 * decision or an event. Adding content = adding JSON — the resolver applies
 * it identically everywhere (economy, politics, opinion, military).
 *
 * TWO effect modes:
 *  - instant 'add'  : one-shot delta written into state at apply time.
 *  - modifier       : registered for N months; 'mul' scales the metric on
 *                     READ (e.g. "military power +10 %" while active).
 *
 * The vocabulary is exported for DataRegistry validation: unknown metric ids
 * or mode/target mismatches fail at BOOT, never mid-campaign.
 *
 * The financial vocabulary is the LIGHT one (spec §10): treasury and the
 * monthly balance exist; GDP, debt, inflation, unemployment and sectors do
 * NOT. Resource conditions (shortageResources / foodStock) let the
 * data-driven content react to the REAL resource economy.
 */

import type { GameState } from '../state/GameState';
import type { ActiveModifier, EffectConditionDef, EffectDef } from './types';
import { clamp01 } from './types';

// —————————————————————————————————————————————————————————— vocabulary ——

/** Instant-writable state metrics ('add' mode). */
export const ADD_METRICS: ReadonlySet<string> = new Set([
  'treasury',
  'approval',
  'politicalSupport',
  'executiveAuthority',
  'publicTrust',
  'corruption',
  'protestPressure',
  'strikePressure',
  'stability',
  'legitimacy',
  'warExhaustion',
  'militaryPower',
  'foodStock' // instant food units into the country's stockpile
]);

/** Read-time multiplicative metrics ('mul' mode modifiers). */
export const MUL_METRICS: ReadonlySet<string> = new Set([
  'militaryPower'
]);

/** Every metric an effect may target (DataRegistry boot validation). */
export const KNOWN_GOV_METRICS: ReadonlySet<string> = new Set([
  ...ADD_METRICS,
  ...MUL_METRICS,
  // Read-only condition metrics (preconditions/event conditions).
  'population',
  'shortageResources',
  'monthlyBalance'
]);

// ————————————————————————————————————————————————————————————— reading ——

/** Sum of active 'add' modifiers for one metric. */
function activeAdd(active: readonly ActiveModifier[], metric: string): number {
  let sum = 0;
  for (const modifier of active) {
    if (modifier.target === metric && modifier.mode === 'add') sum += modifier.value;
  }
  return sum;
}

/** Product of (1 + value) over active 'mul' modifiers for one metric. */
function activeMul(active: readonly ActiveModifier[], metric: string): number {
  let product = 1;
  for (const modifier of active) {
    if (modifier.target === metric && modifier.mode === 'mul') product *= 1 + modifier.value;
  }
  return product;
}

/** Exported read-time multiplier for metrics other systems compose manually. */
export function activeMulFactor(state: GameState, countryId: string, metric: string): number {
  const government = state.government.countries[countryId];
  return activeMul(government?.decisions.active ?? [], metric);
}

/**
 * How many resources are ACUTELY short for this country right now (spec §5):
 * a resource counts when the last cycle pass recorded an uncovered deficit
 * (the stockpile ran dry — record.shortage). ONE number, ONE source: the
 * same record the economy UI, the development penalty and the purchase
 * flow all read. Drives data-driven conditions and opinion.
 */
export function acuteShortageCountOf(state: GameState, countryId: string): number {
  const record = state.economy.resources[countryId];
  if (record === undefined) return 0;
  let count = 0;
  for (const value of Object.values(record.shortage)) {
    if (value > 0) count += 1;
  }
  return count;
}

/**
 * Reads the CURRENT value of a metric for a country, with active modifiers
 * applied. Pure — never mutates. Unknown metrics return 0 (registry
 * validation makes this unreachable for vetted content).
 */
export function readMetric(state: GameState, countryId: string, metric: string): number {
  const government = state.government.countries[countryId];
  const active = government?.decisions.active ?? [];
  const mul = activeMul(active, metric);

  switch (metric) {
    case 'treasury':
      return state.economy.treasury[countryId] ?? 0;
    case 'monthlyBalance':
      return state.economy.finance[countryId]?.lastBalance ?? 0;
    case 'shortageResources':
      return acuteShortageCountOf(state, countryId);
    case 'foodStock':
      return (state.economy.resources[countryId]?.stock.food ?? 0) + activeAdd(active, metric);
    case 'population':
      return state.countries.countries[countryId]?.population ?? 0;
    case 'militaryPower':
      return militaryPowerOf(state, countryId) * mul + activeAdd(active, metric);
    case 'approval':
      return government?.president.approval ?? 0;
    case 'politicalSupport':
      return government?.president.politicalSupport ?? 0;
    case 'executiveAuthority':
      return government?.president.executiveAuthority ?? 0;
    case 'publicTrust':
      return government?.politics.publicTrust ?? 0;
    case 'corruption':
      return government?.politics.corruption ?? 0;
    case 'protestPressure':
      return government?.politics.protestPressure ?? 0;
    case 'strikePressure':
      return government?.politics.strikePressure ?? 0;
    case 'stability':
      return state.political.countries[countryId]?.stability ?? 0;
    case 'legitimacy':
      return state.political.countries[countryId]?.legitimacy ?? 0;
    case 'warExhaustion':
      return state.political.countries[countryId]?.warExhaustion ?? 0;
    default:
      return 0;
  }
}

/**
 * Military power read-model: profile manpower/equipment scaled by the
 * military spending share and smoothed by corruption. A future military
 * phase replaces the body of this function — the metric contract stays.
 */
export function militaryPowerOf(state: GameState, countryId: string): number {
  const country = state.countries.countries[countryId];
  const government = state.government.countries[countryId];
  if (country === undefined || government === undefined) return 0;
  const militaryShare = government.budget.spendingShares.military;
  const base = country.military.armySize / 1000 + country.military.equipment * 2;
  return base * (0.5 + militaryShare * 2.5) * (1 - government.politics.corruption * 0.3);
}

// ————————————————————————————————————————————————————————————— writing ——

/** Clamps a metric's new value into its domain (rates → 0..1, etc.). */
function clampMetric(metric: string, value: number): number {
  switch (metric) {
    case 'treasury':
    case 'population':
    case 'warExhaustion':
      return Math.max(0, value);
    case 'approval':
    case 'politicalSupport':
    case 'executiveAuthority':
    case 'publicTrust':
    case 'corruption':
    case 'protestPressure':
    case 'strikePressure':
    case 'stability':
    case 'legitimacy':
      return clamp01(value);
    default:
      return value;
  }
}

/**
 * Applies ONE instant effect (no duration) to a country. 'foodStock' adds
 * real units to the country's food stockpile (harvest aid / purchases);
 * the other effects write their existing state records.
 */
export function applyInstantEffect(state: GameState, countryId: string, effect: EffectDef): void {
  const government = state.government.countries[countryId];

  if (effect.target === 'foodStock') {
    const record = state.economy.resources[countryId];
    if (record !== undefined) {
      record.stock.food = Math.max(0, Math.round((record.stock.food ?? 0) + effect.value));
    }
    return;
  }

  const current = readMetric(state, countryId, effect.target);
  const next = clampMetric(effect.target, current + effect.value);
  switch (effect.target) {
    case 'treasury':
      state.economy.treasury[countryId] = next;
      break;
    case 'militaryPower':
      // Derived metric — instant deltas land as a spending-share-neutral
      // readiness bonus carried by an 'add' modifier for one year.
      if (government !== undefined) {
        government.decisions.active.push({
          sourceId: 'metric.militaryPowerBonus',
          target: 'militaryPower',
          mode: 'add',
          value: effect.value,
          monthsLeft: 12
        });
      }
      break;
    case 'stability':
    case 'legitimacy':
    case 'warExhaustion': {
      const political = state.political.countries[countryId];
      if (political !== undefined) {
        if (effect.target === 'stability') political.stability = next;
        if (effect.target === 'legitimacy') political.legitimacy = next;
        if (effect.target === 'warExhaustion') political.warExhaustion = next;
      }
      break;
    }
    default: {
      if (government === undefined) break;
      if (effect.target === 'approval') government.president.approval = next;
      else if (effect.target === 'politicalSupport') government.president.politicalSupport = next;
      else if (effect.target === 'executiveAuthority') government.president.executiveAuthority = next;
      else if (effect.target === 'publicTrust') government.politics.publicTrust = next;
      else if (effect.target === 'corruption') government.politics.corruption = next;
      else if (effect.target === 'protestPressure') government.politics.protestPressure = next;
      else if (effect.target === 'strikePressure') government.politics.strikePressure = next;
    }
  }
}

/**
 * Applies an effect bundle: effects with durationMonths > 0 become active
 * modifiers (inheriting `defaultDuration` when the effect doesn't specify
 * its own — decisions pass their duration, event choices pass 0); the rest
 * are applied instantly. Returns the modifiers added.
 */
export function applyEffectBundle(
  state: GameState,
  countryId: string,
  effects: readonly EffectDef[],
  sourceId: string,
  defaultDuration = 0
): ActiveModifier[] {
  const added: ActiveModifier[] = [];
  const government = state.government.countries[countryId];
  for (const effect of effects) {
    // Duration inheritance: 'mul' effects are read-time modifiers and
    // inherit the decision's duration; 'add' effects are instant one-shot
    // deltas unless they explicitly opt into a per-month duration.
    const duration = effect.durationMonths ?? (effect.mode === 'mul' ? defaultDuration : 0);
    if (duration > 0) {
      const modifier: ActiveModifier = {
        sourceId,
        target: effect.target,
        mode: effect.mode,
        value: effect.value,
        monthsLeft: duration
      };
      added.push(modifier);
      government?.decisions.active.push(modifier);
    } else {
      applyInstantEffect(state, countryId, effect);
    }
  }
  return added;
}

/** Decrements every active modifier; drops expired ones. Mutates in place. */
export function tickModifiers(active: ActiveModifier[]): void {
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

// —————————————————————————————————————————————————————————— conditions ——

/** Evaluates a data-driven condition against the current metric value. */
export function evaluateCondition(state: GameState, countryId: string, condition: EffectConditionDef): boolean {
  const value = readMetric(state, countryId, condition.metric);
  switch (condition.op) {
    case 'gte':
      return value >= condition.value;
    case 'lte':
      return value <= condition.value;
    case 'gt':
      return value > condition.value;
    case 'lt':
      return value < condition.value;
  }
}

/** True when ALL conditions hold. */
export function evaluateConditions(
  state: GameState,
  countryId: string,
  conditions: readonly EffectConditionDef[]
): boolean {
  return conditions.every((condition) => evaluateCondition(state, countryId, condition));
}
