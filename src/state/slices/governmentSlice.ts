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
  BUDGET_POOLS,
  GOVERNMENT_SIZE_OF_GDP,
  PARLIAMENT_SEATS,
  SPENDING_CATEGORIES,
  TAX_LEVEL_IDS,
  TERM_LENGTH_MONTHS,
  type BudgetPool,
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
  type TaxLevel
} from '../../government/types';
import { OPINION_TOPICS } from '../../government/types';

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

/**
 * Relative weights of the non-military spending categories inside the
 * ECONOMIC half of the budget pool. The economic money pot
 * (economic share × GOVERNMENT_SIZE_OF_GDP) distributes over them by these
 * weights; the military pot goes to `military` outright. Same mix the
 * pre-pool defaults used, so a 50/50 campaign keeps the old balance.
 */
export const ECONOMIC_CATEGORY_WEIGHTS: Readonly<Record<Exclude<SpendingCategory, 'military'>, number>> = {
  healthcare: 0.02,
  education: 0.018,
  infrastructure: 0.016,
  welfare: 0.02,
  government: 0.024,
  other: 0.004
};

/** Default budget posture (spec §1): an even 50/50 split, MEDIUM tax. */
export const DEFAULT_BUDGET_SHARES: Readonly<Record<BudgetPool, number>> = {
  economic: 0.5,
  military: 0.5
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
    shares: { ...DEFAULT_BUDGET_SHARES },
    tax: 'medium',
    spendingShares: deriveSpendingShares(DEFAULT_BUDGET_SHARES)
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

/**
 * Derives the INTERNAL spendingShares (money plumbing) from the 100% pool
 * split: military money = military share × GOVERNMENT_SIZE_OF_GDP; the
 * economic pot distributes over the other categories by their fixed weights
 * (equal split in the degenerate zero-weight case). The TOTAL government
 * size stays constant — only the split moves money between the halves.
 */
export function deriveSpendingShares(
  shares: Readonly<Record<BudgetPool, number>>
): Record<SpendingCategory, number> {
  const result = {} as Record<SpendingCategory, number>;
  for (const category of SPENDING_CATEGORIES) result[category] = 0;
  result.military = Math.max(0, Math.min(1, shares.military ?? 0)) * GOVERNMENT_SIZE_OF_GDP;
  const economicPot = Math.max(0, Math.min(1, shares.economic ?? 0)) * GOVERNMENT_SIZE_OF_GDP;
  const weightTotal = Object.values(ECONOMIC_CATEGORY_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
  if (weightTotal <= 1e-9) {
    const categories = Object.keys(ECONOMIC_CATEGORY_WEIGHTS) as Exclude<SpendingCategory, 'military'>[];
    for (const category of categories) result[category] = economicPot / categories.length;
  } else {
    for (const [category, weight] of Object.entries(ECONOMIC_CATEGORY_WEIGHTS)) {
      result[category as Exclude<SpendingCategory, 'military'>] = (economicPot * weight) / weightTotal;
    }
  }
  return result;
}

/**
 * Normalizes the pool shares so Σ is EXACTLY 1: the LAST pool absorbs any
 * floating-point remainder (with two pools this pins military = 1 − economic
 * bit-exactly). Pure arithmetic — no clamping here; callers clamp first.
 */
export function normalizeBudgetShares(shares: Record<BudgetPool, number>): void {
  const last = BUDGET_POOLS[BUDGET_POOLS.length - 1];
  let rest = 0;
  for (let index = 0; index < BUDGET_POOLS.length - 1; index += 1) {
    rest += shares[BUDGET_POOLS[index]];
  }
  shares[last] = 1 - rest;
}

/**
 * THE TEN-POINT BUDGET GRID (the budget directive §1): the economic budget
 * changes only in steps of 10 — 0, 10, 20 … 100 (stored as 0..0.1..1). A
 * requested value is clamped into [0, 1] and snapped to the NEAREST grid
 * point, so no caller (UI stepper, command, event, test) can ever write an
 * off-grid share into the state. The other pool mirrors exactly (1 − x),
 * which keeps both on the grid by construction.
 */
export function snapBudgetShare(value: number): number {
  const clamped = Number.isFinite(value) ? clamp01(value) : 0;
  return Math.round(clamped * 10) / 10;
}

/**
 * THE budget mutator (spec §1/§10 + the budget directive §1): sets ONE
 * pool's share of the 100% pool — snapped onto the TEN-POINT grid (0, 0.1,
 * …, 1; the budget changes only in steps of 10) — and distributes the
 * remainder over the OTHER pools proportionally (with two pools that means
 * military = 1 − economic exactly, in BOTH directions — also on-grid).
 * Re-derives the internal spending money so the whole simulation follows.
 * Returns the applied split.
 */
export function setBudgetShare(
  slice: GovernmentSlice,
  countryId: string,
  pool: BudgetPool,
  value: number
): Record<BudgetPool, number> {
  const government = slice.countries[countryId];
  if (government === undefined) return { ...DEFAULT_BUDGET_SHARES };
  const target = snapBudgetShare(value);
  const shares = government.budget.shares;
  const others = BUDGET_POOLS.filter((candidate) => candidate !== pool);
  const otherSum = others.reduce((sum, candidate) => sum + Math.max(0, shares[candidate]), 0);
  shares[pool] = target;
  const remainder = 1 - target;
  if (otherSum <= 1e-9) {
    for (const candidate of others) shares[candidate] = remainder / others.length;
  } else {
    for (const candidate of others) shares[candidate] = remainder * (Math.max(0, shares[candidate]) / otherSum);
  }
  normalizeBudgetShares(shares);
  government.budget.spendingShares = deriveSpendingShares(shares);
  return { ...shares };
}

/** Sets the tax level (spec §4). Returns the applied level. */
export function setTaxLevel(slice: GovernmentSlice, countryId: string, level: TaxLevel): TaxLevel {
  const government = slice.countries[countryId];
  if (government === undefined) return 'medium';
  government.budget.tax = level;
  return government.budget.tax;
}

/**
 * Repairs a loaded/migrated budget record into a valid pool state: clamps,
 * SNAPS onto the ten-point grid (saves from before the budget-directive
 * carried arbitrary shares — they normalize to the nearest legal step),
 * re-derives the money plumbing, and coerces an unknown tax level back to
 * MEDIUM. Idempotent; used by the load heal.
 */
export function repairBudgetRecord(record: GovernmentCountryState): void {
  const shares = record.budget.shares;
  if (shares !== undefined && typeof shares === 'object') {
    for (const pool of BUDGET_POOLS) {
      const value = shares[pool];
      shares[pool] = typeof value === 'number' && Number.isFinite(value) ? snapBudgetShare(value) : 0;
    }
    normalizeBudgetShares(shares);
  } else {
    record.budget.shares = { ...DEFAULT_BUDGET_SHARES };
  }
  record.budget.spendingShares = deriveSpendingShares(record.budget.shares);
  if (!TAX_LEVEL_IDS.includes(record.budget.tax)) record.budget.tax = 'medium';
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
    BUDGET_POOLS.every((pool) => record.budget.shares[pool] !== undefined) &&
    TAX_LEVEL_IDS.includes(record.budget.tax) &&
    SPENDING_CATEGORIES.every((category) => record.budget.spendingShares[category] !== undefined) &&
    OPINION_TOPICS.every((topic) => record.opinion.topics[topic] !== undefined) &&
    Object.keys(record.ministries).length > 0 &&
    Object.keys(record.politics.parties).length > 0 &&
    record.elections.nextElectionMonth >= 0 &&
    record.president.termEndMonth >= record.president.termStartMonth
  );
}

// ————————————————————————————————————————————————————— power distribution ———

/** One party's slice of the political power pie (Politics panel, spec §5). */
export interface PoliticalPowerEntry {
  readonly partyId: string;
  readonly partyName: string;
  /** 0..1 share of political power (Σ over parties = 1). */
  readonly share: number;
  /** Member of the governing coalition (visual emphasis in the UI). */
  readonly inGovernment: boolean;
}

/**
 * THE power-distribution data of ONE country (spec §5 — real system data,
 * never hard-coded, and changeable by design: future political decisions
 * shift `support` / parliament seats and THIS derivation follows).
 *
 * Power basis: parliament seat shares once seats are assigned (institutional
 * power after an election); the normalized public support before it. The
 * most-powerful party is simply the largest entry. Deterministic.
 */
export function politicalPowerDistribution(government: GovernmentCountryState): PoliticalPowerEntry[] {
  const parties = Object.values(government.politics.parties);
  if (parties.length === 0) return [];
  const seatsAssigned = Object.keys(government.politics.parliament.seats).length > 0;
  const weights = parties.map((party) => ({
    partyId: party.id,
    partyName: party.name,
    inGovernment: party.inGovernment,
    weight: Math.max(0, seatsAssigned ? party.seatShare : party.support)
  }));
  const total = weights.reduce((sum, entry) => sum + entry.weight, 0);
  return weights
    .map((entry) => ({
      partyId: entry.partyId,
      partyName: entry.partyName,
      inGovernment: entry.inGovernment,
      share: total > 1e-9 ? entry.weight / total : 1 / weights.length
    }))
    .sort((a, b) => b.share - a.share || a.partyId.localeCompare(b.partyId));
}
