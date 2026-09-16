/**
 * Phase 2 — Government & Presidency domain types (leaf module).
 *
 * Everything the president-facing systems (government simulation, decisions,
 * events, elections, ministries, public opinion) and the dashboard UI share.
 * All records are JSON-safe: they live inside GameState slices and are
 * serialized by the save system verbatim.
 *
 * UNITS CONTRACT (fixed for the whole phase):
 *  - money     : $ millions per unit ("M$") — treasury, GDP (annual), debt.
 *  - people    : persons — population, sector jobs, workforce.
 *  - rates     : fractions 0..1 (approval, unemployment, tax rates).
 *  - inflation : annual fraction (0.03 = 3 %/year), may go slightly negative.
 *  - months    : ABSOLUTE month index since campaign start
 *                (see Calendar.absoluteMonthIndex) — the only date form used
 *                inside the simulation, so month math is plain integers.
 *
 * DATA-DRIVEN RULE: party templates, decision definitions, event definitions
 * and ministry definitions live in src/data/government/*.json and are
 * schema-validated at boot (DataRegistry). This module holds RUNTIME state
 * only — adding a hundred new decisions/events requires zero code changes.
 */

import type { CountryId } from '../world/types';

// ———————————————————————————————————————————————————————————— president ———

export interface PresidentState {
  /** Display name (deterministic per country at campaign start). */
  name: string;
  /** Party id the president belongs to (party template id). */
  partyId: string;
  /** Absolute month index the current term started at. */
  termStartMonth: number;
  /** Term length in months (data-driven default: 48). */
  termLengthMonths: number;
  /** Absolute month index the term ends at (elections happen this month). */
  termEndMonth: number;
  /** 0..1 public approval of the president (drifts toward opinion topics). */
  approval: number;
  /** 0..1 share of parliament / political backing behind the president. */
  politicalSupport: number;
  /** 0..1 how much of the executive branch actually obeys decisions. */
  executiveAuthority: number;
  /** Completed terms (re-election tracking). */
  termsServed: number;
}

// ————————————————————————————————————————————————————————————— parties ———

/** Runtime party record (template comes from parties.json). */
export interface PartyState {
  id: string;
  name: string;
  /** Ideology tag — future policy-reaction modifiers key off this. */
  ideology: 'centrist' | 'progressive' | 'conservative' | 'socialist' | 'liberal';
  /** 0..1 current public support (Σ over parties ≈ 1, drifts monthly). */
  support: number;
  /** 0..1 share of parliament seats (fixed between elections). */
  seatShare: number;
  /** Member of the governing coalition. */
  inGovernment: boolean;
}

export interface ParliamentState {
  seatsTotal: number;
  /** Party id → seat count (Σ = seatsTotal after an election). */
  seats: Record<string, number>;
}

// ————————————————————————————————————————————————————————————— elections ——

export type ElectionPhase = 'idle' | 'campaigning';

export interface ElectionState {
  phase: ElectionPhase;
  /** Absolute month index of the next scheduled election. */
  nextElectionMonth: number;
  /** Absolute month index of the last completed election (−1 = none yet). */
  lastElectionMonth: number;
  /** Campaign effort per party (0..1) accumulated during the campaign window. */
  campaignEffort: Record<string, number>;
  /** Last election vote share per party (null before the first election). */
  lastResults: Record<string, number> | null;
  /** Party id of the election winner (null before the first election). */
  lastWinnerId: string | null;
}

// ————————————————————————————————————————————————————————————— ministries ——

export interface MinistryState {
  /** 0..1 funding level the president assigns (scaled by budget share). */
  funding: number;
  /** 0..1 effectiveness (drifts toward a funding-dependent target). */
  efficiency: number;
}

// ————————————————————————————————————————————————————————————————— budget ——

export const TAX_CATEGORIES = ['income', 'corporate', 'trade'] as const;
export type TaxCategory = (typeof TAX_CATEGORIES)[number];

export const SPENDING_CATEGORIES = [
  'military',
  'healthcare',
  'education',
  'infrastructure',
  'welfare',
  'government',
  'other'
] as const;
export type SpendingCategory = (typeof SPENDING_CATEGORIES)[number];

export interface BudgetState {
  /** Tax rates as fractions of the taxable base (0..MAX_TAX_RATE). */
  taxRates: Record<TaxCategory, number>;
  /**
   * Spending categories as ANNUAL shares of GDP (each 0..1; their sum is the
   * government size — not required to be 1). Spending per month = Σ share ×
   * GDP / 12. Shares are policy levers the president moves; the simulation
   * derives the actual $ amounts.
   */
  spendingShares: Record<SpendingCategory, number>;
}

// ————————————————————————————————————————————————————————————— politics ——

export type ProtestLevel = 'none' | 'minor' | 'significant' | 'massive';

export interface PoliticalState {
  /** Party id → runtime party record (built from the party templates). */
  parties: Record<string, PartyState>;
  parliament: ParliamentState;
  /** Party ids forming the governing coalition (includes the president's). */
  coalition: string[];
  /** 0..1 systemic corruption (events and ministries move it). */
  corruption: number;
  /** 0..1 institutional trust (drifts from corruption/stability/approval). */
  publicTrust: number;
  /** 0..1 current protest pressure (decays; spikes from opinion shocks). */
  protestPressure: number;
  /** Discrete protest level derived from protestPressure. */
  protests: ProtestLevel;
  /** 0..1 strike pressure (labor unrest — unemployment/events driven). */
  strikePressure: number;
  /** Month index of an active general strike end, or null. */
  generalStrikeUntilMonth: number | null;
}

// —————————————————————————————————————————————————————— public opinion ——

export const OPINION_TOPICS = ['economy', 'taxes', 'services', 'corruption', 'security'] as const;
export type OpinionTopic = (typeof OPINION_TOPICS)[number];

export interface PublicOpinionState {
  /** Topic sentiment in [-1, +1] (negative = unhappy about that topic). */
  topics: Record<OpinionTopic, number>;
}

// ———————————————————————————————————————————————————————— decisions ————

/** One concrete effect a decision/event choice applies. Data-driven. */
export interface EffectDef {
  /** Metric id from the central metric vocabulary (Metrics.ts). */
  target: string;
  /**
   * 'add': absolute delta (instant) or per-month delta (while modifier
   * active). 'mul': multiplicative modifier, e.g. 0.05 = +5 %.
   */
  mode: 'add' | 'mul';
  value: number;
  /**
   * When present AND > 0 the effect becomes an ACTIVE MODIFIER for this many
   * months instead of a one-shot change.
   */
  durationMonths?: number;
}

export interface EffectConditionDef {
  metric: string;
  /** Comparison against the metric's CURRENT value. */
  op: 'gte' | 'lte' | 'gt' | 'lt';
  value: number;
}

export interface DecisionCostDef {
  /** One-time treasury cost in M$. */
  treasury?: number;
}

/** Static decision definition (src/data/government/decisions.json). */
export interface DecisionDef {
  id: string;
  name: string;
  description: string;
  category: 'economic' | 'political' | 'social' | 'military';
  cost: DecisionCostDef;
  preconditions: readonly EffectConditionDef[];
  effects: readonly EffectDef[];
  /** How long ACTIVE modifiers from `effects` last, in months. */
  durationMonths: number;
  /** Months before the same decision may be enacted again. */
  cooldownMonths: number;
}

/** An active (duration-carrying) modifier on a country's metrics. */
export interface ActiveModifier {
  /** Decision or event instance that produced the modifier. */
  sourceId: string;
  target: string;
  mode: 'add' | 'mul';
  value: number;
  monthsLeft: number;
}

export interface DecisionsState {
  /** Currently active modifiers (duration effects), ticked monthly. */
  active: ActiveModifier[];
  /** Decision id → absolute month it may be enacted again (cooldown end). */
  cooldowns: Record<string, number>;
  /** Recently enacted decisions (bounded history, newest first). */
  history: { decisionId: string; month: number }[];
}

// ———————————————————————————————————————————————————————————— events ————

/** Static event definition (src/data/government/events.json). */
export interface EventDef {
  id: string;
  title: string;
  description: string;
  category: 'economic' | 'political' | 'social';
  /** Relative selection weight (rng-weighted among eligible events). */
  weight: number;
  /** Eligibility conditions against current metrics. */
  conditions: readonly EffectConditionDef[];
  /** Months before the same event may fire again for the same country. */
  cooldownMonths: number;
  /** True = can only ever happen once per country. */
  once: boolean;
  /** The president's options — each with its own effect bundle. */
  choices: readonly EventChoiceDef[];
  /** Months before an unanswered event expires (first choice auto-applied). */
  expireMonths: number;
}

export interface EventChoiceDef {
  id: string;
  text: string;
  effects: readonly EffectDef[];
}

/** A live event awaiting the president's choice. */
export interface PendingEvent {
  instanceId: string;
  eventId: string;
  firedMonth: number;
  expiresMonth: number;
}

export interface EventsState {
  pending: PendingEvent[];
  /** Event id → absolute month it may fire again. */
  cooldowns: Record<string, number>;
  /** Event ids already consumed (for `once` events). */
  fired: string[];
}

// ———————————————————————————————————————————————————————————— aggregate ——

/** Per-country Phase 2 government state (one record per strategic country). */
export interface GovernmentCountryState {
  president: PresidentState;
  politics: PoliticalState;
  elections: ElectionState;
  ministries: Record<string, MinistryState>;
  budget: BudgetState;
  decisions: DecisionsState;
  events: EventsState;
  opinion: PublicOpinionState;
  /** Absolute month index the monthly simulation last processed. */
  lastSimMonth: number;
}

export interface GovernmentSlice {
  countries: Record<CountryId, GovernmentCountryState>;
}

// —————————————————————————————————————————————————————————————— helpers ——

export const MAX_TAX_RATE = 0.75;
export const TERM_LENGTH_MONTHS = 48;
export const CAMPAIGN_MONTHS = 6;
export const PARLIAMENT_SEATS = 200;
/** Max simultaneous unanswered events per country. */
export const MAX_PENDING_EVENTS = 3;
export const DECISION_HISTORY_LIMIT = 12;

export function protestLevelOf(pressure: number): ProtestLevel {
  if (pressure >= 0.75) return 'massive';
  if (pressure >= 0.45) return 'significant';
  if (pressure >= 0.2) return 'minor';
  return 'none';
}

export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function clampSigned(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(-1, value));
}
