/**
 * Government state slice (Phase 2) — presidency, parties, parliament,
 * elections, ministries, budget, decisions, events, public opinion.
 *
 * One record per strategic-map country (country_0…), built at campaign
 * start from the static party/ministry templates (DataRegistry) and saved
 * with the game. All mutation flows through the clamped helpers below so
 * every value stays inside its documented domain — the UI and systems never
 * write raw numbers.
 */

import type { CountryId } from '../../world/types';
import type { Random } from '../../utils/Random';
import { generatePersonName } from '../../world/map/MapNames';
import {
  clamp01,
  MAX_TAX_RATE,
  PARLIAMENT_SEATS,
  SPENDING_CATEGORIES,
  TAX_CATEGORIES,
  TERM_LENGTH_MONTHS,
  type BudgetState,
  type DecisionsState,
  type ElectionState,
  type EventsState,
  type GovernmentCountryState,
  type GovernmentSlice,
  type MinistryState,
  type PartyState,
  type PoliticalState,
  type PresidentState,
  type PublicOpinionState,
  type SpendingCategory,
  type TaxCategory
} from '../../government/types';
import { OPINION_TOPICS } from '../../government/types';
import { SECTORS } from '../../economy/macro';

/** Static party template (src/data/government/parties.json). */
export interface PartyTemplate {
  readonly id: string;
  readonly name: string;
  readonly ideology: PartyState['ideology'];
  /** Relative popularity weight — per-country supports derive from this. */
  readonly baseSupport: number;
}

/** Static ministry template (src/data/government/ministries.json). */
export interface MinistryTemplate {
  readonly id: string;
  readonly name: string;
  /** Spending category the ministry draws its budget from. */
  readonly portfolio: SpendingCategory;
  /** Metric the ministry's efficiency improves (informational + systems). */
  readonly focus: string;
}

/** Initial values for budget policy (same for every country at start). */
export const DEFAULT_TAX_RATES: Readonly<Record<TaxCategory, number>> = {
  income: 0.22,
  corporate: 0.19,
  trade: 0.08
};

/**
 * Initial values for budget policy (same for every country at start).
 * Calibrated against the revenue model (≈ 12 % of GDP at default tax
 * rates): the defaults run a TINY structural deficit so a new player
 * starts stable but must actually govern the budget.
 */
export const DEFAULT_SPENDING_SHARES: Readonly<Record<SpendingCategory, number>> = {
  military: 0.018,
  healthcare: 0.02,
  education: 0.018,
  infrastructure: 0.016,
  welfare: 0.02,
  government: 0.024,
  other: 0.004
};

/** Deterministic per-country support split of the party templates. */
function initialPartySupports(templates: readonly PartyTemplate[], countryId: string): Record<string, number> {
  // Hash the country id into a stable jitter per party (±25 %) — every
  // country starts with a distinct political landscape, reproducibly.
  let hash = 2166136261;
  for (const character of countryId) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const jitter = (index: number): number => {
    const value = Math.imul(hash ^ (index + 1) * 2654435761, 40503) >>> 0;
    return 0.75 + (value % 1000) / 2000; // 0.75 .. 1.25
  };
  const weights = templates.map((template, index) => Math.max(0.05, template.baseSupport * jitter(index)));
  const total = weights.reduce((sum, value) => sum + value, 0);
  const supports: Record<string, number> = {};
  templates.forEach((template, index) => {
    supports[template.id] = weights[index] / total;
  });
  return supports;
}

/** Creates the Phase 2 government record for ONE country. */
export function createGovernmentCountryState(
  countryId: string,
  countryName: string,
  partyTemplates: readonly PartyTemplate[],
  ministryTemplates: readonly MinistryTemplate[],
  rng: Random
): GovernmentCountryState {
  const supports = initialPartySupports(partyTemplates, countryId);
  const parties: Record<string, PartyState> = {};
  for (const template of partyTemplates) {
    parties[template.id] = {
      id: template.id,
      name: template.name,
      ideology: template.ideology,
      support: supports[template.id] ?? 0,
      seatShare: supports[template.id] ?? 0,
      inGovernment: false
    };
  }
  // Initial government: the most popular party governs alone.
  const governing = partyTemplates.reduce(
    (best, candidate) => ((supports[candidate.id] ?? 0) > (supports[best.id] ?? 0) ? candidate : best),
    partyTemplates[0]
  );
  for (const party of Object.values(parties)) {
    party.inGovernment = party.id === governing.id;
  }

  const ministries: Record<string, MinistryState> = {};
  for (const template of ministryTemplates) {
    ministries[template.id] = { funding: 0.6, efficiency: 0.6 };
  }

  const president: PresidentState = {
    name: generatePersonName(rng, new Set()),
    partyId: governing.id,
    termStartMonth: 0,
    termLengthMonths: TERM_LENGTH_MONTHS,
    termEndMonth: TERM_LENGTH_MONTHS,
    approval: 0.55,
    politicalSupport: 0.5,
    executiveAuthority: 0.6,
    termsServed: 1
  };

  const politics: PoliticalState = {
    parties,
    parliament: { seatsTotal: PARLIAMENT_SEATS, seats: {} },
    coalition: [governing.id],
    corruption: 0.22,
    publicTrust: 0.55,
    protestPressure: 0.05,
    protests: 'none',
    strikePressure: 0.05,
    generalStrikeUntilMonth: null
  };

  const elections: ElectionState = {
    phase: 'idle',
    nextElectionMonth: TERM_LENGTH_MONTHS,
    lastElectionMonth: -1,
    campaignEffort: {},
    lastResults: null,
    lastWinnerId: null
  };

  const budget: BudgetState = {
    taxRates: { ...DEFAULT_TAX_RATES },
    spendingShares: { ...DEFAULT_SPENDING_SHARES }
  };

  const decisions: DecisionsState = { active: [], cooldowns: {}, history: [] };
  const events: EventsState = { pending: [], cooldowns: {}, fired: [] };
  const opinion: PublicOpinionState = {
    topics: Object.fromEntries(OPINION_TOPICS.map((topic) => [topic, 0])) as PublicOpinionState['topics']
  };

  void countryName; // reserved: future localized title (e.g. "President of X")
  return {
    president,
    politics,
    elections,
    ministries,
    budget,
    decisions,
    events,
    opinion,
    lastSimMonth: 0
  };
}

/** Builds the whole government slice for every strategic-map country. */
export function buildGovernmentSlice(
  countryIds: readonly CountryId[],
  countryNames: Readonly<Record<string, string>>,
  partyTemplates: readonly PartyTemplate[],
  ministryTemplates: readonly MinistryTemplate[],
  rng: Random
): GovernmentSlice {
  const countries: Record<CountryId, GovernmentCountryState> = {};
  for (const countryId of countryIds) {
    countries[countryId] = createGovernmentCountryState(
      countryId,
      countryNames[countryId] ?? countryId,
      partyTemplates,
      ministryTemplates,
      rng
    );
  }
  return { countries };
}

// ————————————————————————————————————————————————————————————— mutators ——

/** Sets a tax rate (clamped to [0, MAX_TAX_RATE]). Returns the clamped value. */
export function setTaxRate(slice: GovernmentSlice, countryId: string, category: TaxCategory, value: number): number {
  const government = slice.countries[countryId];
  if (government === undefined) return 0;
  const clamped = Math.max(0, Math.min(MAX_TAX_RATE, value));
  government.budget.taxRates[category] = clamped;
  return clamped;
}

/** Sets a spending share (clamped to [0, 0.5] of GDP). Returns the clamped value. */
export function setSpendingShare(slice: GovernmentSlice, countryId: string, category: SpendingCategory, value: number): number {
  const government = slice.countries[countryId];
  if (government === undefined) return 0;
  const clamped = Math.max(0, Math.min(0.5, value));
  government.budget.spendingShares[category] = clamped;
  return clamped;
}

/** Sets a ministry funding level (clamped to [0, 1]). Returns the clamped value. */
export function setMinistryFunding(slice: GovernmentSlice, countryId: string, ministryId: string, value: number): number {
  const government = slice.countries[countryId];
  if (government === undefined || government.ministries[ministryId] === undefined) return 0;
  const clamped = clamp01(value);
  government.ministries[ministryId].funding = clamped;
  return clamped;
}

/** Structural completeness check used by tests and the save validator. */
export function governmentRecordIsComplete(record: GovernmentCountryState): boolean {
  return (
    TAX_CATEGORIES.every((category) => record.budget.taxRates[category] !== undefined) &&
    SPENDING_CATEGORIES.every((category) => record.budget.spendingShares[category] !== undefined) &&
    OPINION_TOPICS.every((topic) => record.opinion.topics[topic] !== undefined) &&
    Object.keys(record.ministries).length > 0 &&
    Object.keys(record.politics.parties).length > 0 &&
    record.elections.nextElectionMonth >= 0 &&
    record.president.termEndMonth >= record.president.termStartMonth
  );
}

/** Aggregated annual spending shares (diagnostics + dashboard). */
export function totalSpendingShare(record: GovernmentCountryState): number {
  return SPENDING_CATEGORIES.reduce((sum, category) => sum + record.budget.spendingShares[category], 0);
}

/** Sector ids re-export for UI conveniences (avoids import duplication). */
export { SECTORS };
