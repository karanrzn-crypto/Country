import { describe, it, expect } from 'vitest';
import { createTestGame } from '../../helpers/testGame';
import {
  buildGovernmentSlice,
  createGovernmentCountryState,
  governmentRecordIsComplete,
  politicalPowerDistribution,
  setBudgetShare,
  setTaxLevel,
  setMinistryFunding,
  deriveSpendingShares,
  DEFAULT_BUDGET_SHARES
} from '../../../state/slices/governmentSlice';
import type { PartyTemplate, MinistryTemplate } from '../../../state/slices/governmentSlice';
import { Random } from '../../../utils/Random';
import { stableStringify } from '../../../utils/hash';
import { BUDGET_POOLS, GOVERNMENT_SIZE_OF_GDP, SPENDING_CATEGORIES, TAX_LEVEL_IDS } from '../../../government/types';

const PARTY_TEMPLATES: readonly PartyTemplate[] = [
  { id: 'centrist_union', name: 'Civic Union', ideology: 'centrist', baseSupport: 1.0 },
  { id: 'progress_front', name: 'Progress Front', ideology: 'progressive', baseSupport: 0.8 },
  { id: 'heritage_party', name: 'Heritage Party', ideology: 'conservative', baseSupport: 0.85 },
  { id: 'workers_league', name: "Workers' League", ideology: 'socialist', baseSupport: 0.7 },
  { id: 'liberty_guild', name: 'Liberty Guild', ideology: 'liberal', baseSupport: 0.6 }
];

const MINISTRY_TEMPLATES: readonly MinistryTemplate[] = [
  { id: 'finance', name: 'Ministry of Finance', portfolio: 'government', focus: 'taxEfficiency' },
  { id: 'defense', name: 'Ministry of Defense', portfolio: 'military', focus: 'militaryPower' },
  { id: 'interior', name: 'Ministry of Interior', portfolio: 'government', focus: 'corruption' }
];

describe('GovernmentSlice (Phase 2 state)', () => {
  it('builds one complete record per strategic country (deterministic per seed)', () => {
    const a = new Random(777);
    const b = new Random(777);
    const sliceA = buildGovernmentSlice(['country_0', 'country_1'], { country_0: 'Alpha', country_1: 'Beta' }, PARTY_TEMPLATES, MINISTRY_TEMPLATES, a);
    const sliceB = buildGovernmentSlice(['country_0', 'country_1'], { country_0: 'Alpha', country_1: 'Beta' }, PARTY_TEMPLATES, MINISTRY_TEMPLATES, b);
    expect(stableStringify(sliceA)).toBe(stableStringify(sliceB));

    for (const record of Object.values(sliceA.countries)) {
      expect(governmentRecordIsComplete(record)).toBe(true);
      expect(record.president.name.length).toBeGreaterThan(0);
      expect(record.president.approval).toBeGreaterThanOrEqual(0);
      expect(record.president.approval).toBeLessThanOrEqual(1);
      expect(record.elections.nextElectionMonth).toBe(record.president.termLengthMonths);
      expect(record.lastSimMonth).toBe(0);
    }
  });

  it('party supports are normalized and the strongest party forms the initial government', () => {
    const slice = buildGovernmentSlice(['country_0'], { country_0: 'Alpha' }, PARTY_TEMPLATES, MINISTRY_TEMPLATES, new Random(42));
    const record = slice.countries.country_0;
    const parties = Object.values(record.politics.parties);
    expect(parties.length).toBe(PARTY_TEMPLATES.length);
    const supportSum = parties.reduce((sum, party) => sum + party.support, 0);
    expect(supportSum).toBeCloseTo(1, 6);

    const strongest = parties.reduce((best, party) => (party.support > best.support ? party : best), parties[0]);
    expect(record.president.partyId).toBe(strongest.id);
    expect(record.politics.coalition).toEqual([strongest.id]);
    expect(strongest.inGovernment).toBe(true);
    for (const party of parties) {
      expect(party.inGovernment).toBe(party.id === strongest.id);
    }
  });

  it('per-country political landscapes differ but stay normalized', () => {
    const ids = ['country_0', 'country_1', 'country_2', 'country_3'];
    const slice = buildGovernmentSlice(ids, Object.fromEntries(ids.map((id) => [id, id])), PARTY_TEMPLATES, MINISTRY_TEMPLATES, new Random(9));
    const supports = ids.map((id) => Object.values(slice.countries[id].politics.parties).map((party) => party.support));
    // The per-country hash jitter guarantees varied landscapes.
    const vectors = supports.map((values) => values.map((value) => value.toFixed(4)).join(','));
    expect(new Set(vectors).size).toBeGreaterThan(1);
    for (const values of supports) {
      expect(values.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 6);
    }
  });

  it('budget defaults: an even 50/50 pool, MEDIUM tax, derived spending money', () => {
    expect(BUDGET_POOLS.every((pool) => DEFAULT_BUDGET_SHARES[pool] !== undefined)).toBe(true);
    expect(DEFAULT_BUDGET_SHARES.economic + DEFAULT_BUDGET_SHARES.military).toBeCloseTo(1, 12);
    const derived = deriveSpendingShares(DEFAULT_BUDGET_SHARES);
    expect(SPENDING_CATEGORIES.every((category) => derived[category] !== undefined)).toBe(true);
    const total = SPENDING_CATEGORIES.reduce((sum, category) => sum + derived[category], 0);
    // The derived money plumbing preserves the government size (~12 % of GDP).
    expect(total).toBeCloseTo(GOVERNMENT_SIZE_OF_GDP, 9);
    // Half the pot is military money, half the economic categories.
    expect(derived.military).toBeCloseTo(GOVERNMENT_SIZE_OF_GDP / 2, 9);
  });

  it('mutators clamp into their documented domains and reject unknown ids', () => {
    const game = createTestGame({ seed: 55 });
    const countryId = game.strategicMap.countryOrder[0];
    const slice = game.gameState.government;

    // Pool shares clamp into [0, 1]; the other pool absorbs the remainder.
    expect(setBudgetShare(slice, countryId, 'economic', 1.4).economic).toBe(1);
    expect(slice.countries[countryId].budget.shares.military).toBe(0);
    expect(setBudgetShare(slice, countryId, 'economic', -1).economic).toBe(0);
    expect(slice.countries[countryId].budget.shares.military).toBe(1);
    expect(setBudgetShare(slice, 'unknown', 'economic', 0.2).economic).toBe(0.5); // default posture, no crash

    // Tax levels accept exactly the four ids.
    for (const level of TAX_LEVEL_IDS) {
      expect(setTaxLevel(slice, countryId, level)).toBe(level);
    }

    expect(setMinistryFunding(slice, countryId, 'finance', 1.7)).toBe(1);
    expect(setMinistryFunding(slice, countryId, 'finance', -2)).toBe(0);
    expect(setMinistryFunding(slice, countryId, 'nope', 0.5)).toBe(0);

    game.dispose();
  });

  it('the campaign state slice is JSON-safe (save roundtrip in-memory)', () => {
    const game = createTestGame({ seed: 56 });
    const slice = game.gameState.government;
    const roundtrip = JSON.parse(JSON.stringify(slice)) as typeof slice;
    expect(stableStringify(roundtrip)).toBe(stableStringify(slice));
    game.dispose();
  });

  it('createGovernmentCountryState draws unique president names sequentially', () => {
    const used = new Set<string>();
    const rng = new Random(3);
    const first = createGovernmentCountryState('c', 'C', PARTY_TEMPLATES, MINISTRY_TEMPLATES, rng);
    used.add(first.president.name);
    const second = createGovernmentCountryState('c', 'C', PARTY_TEMPLATES, MINISTRY_TEMPLATES, rng);
    expect(used.has(second.president.name)).toBe(false);
  });
});

describe('Budget pool + tax levels (spec §1/§4/§10)', () => {
  it('the pool split is ZERO-SUM in both directions: raising one pool lowers the other by the same amount', () => {
    const game = createTestGame({ seed: 71 });
    const countryId = Object.keys(game.gameState.government.countries)[0];
    const budget = game.gameState.government.countries[countryId].budget;

    game.governmentSetBudgetShare(countryId, 'economic', 0.6);
    game.commandBus.flush();
    expect(budget.shares.economic).toBeCloseTo(0.6, 9);
    expect(budget.shares.military).toBeCloseTo(0.4, 9);

    game.governmentSetBudgetShare(countryId, 'military', 0.7);
    game.commandBus.flush();
    expect(budget.shares.military).toBeCloseTo(0.7, 9);
    expect(budget.shares.economic).toBeCloseTo(0.3, 9);
    game.dispose();
  });

  it('the sum stays EXACTLY 100% through arbitrary command sequences', () => {
    const game = createTestGame({ seed: 74 });
    const countryId = Object.keys(game.gameState.government.countries)[0];
    const budget = game.gameState.government.countries[countryId].budget;
    const rng = new Random(5);
    for (let step = 0; step < 40; step += 1) {
      const pool = rng.chance(0.5) ? 'economic' : 'military';
      game.governmentSetBudgetShare(countryId, pool, rng.next());
      game.commandBus.flush();
      const sum = budget.shares.economic + budget.shares.military;
      expect(sum).toBeCloseTo(1, 9);
    }
    game.dispose();
  });

  it('moving the pool re-derives the internal spending money (total size constant)', () => {
    const game = createTestGame({ seed: 75 });
    const countryId = Object.keys(game.gameState.government.countries)[0];
    const budget = game.gameState.government.countries[countryId].budget;
    const totalOf = (): number => SPENDING_CATEGORIES.reduce((sum, category) => sum + budget.spendingShares[category], 0);

    game.governmentSetBudgetShare(countryId, 'military', 0.8);
    game.commandBus.flush();
    expect(budget.spendingShares.military).toBeCloseTo(0.8 * GOVERNMENT_SIZE_OF_GDP, 9);
    expect(totalOf()).toBeCloseTo(GOVERNMENT_SIZE_OF_GDP, 9);
    game.dispose();
  });

  it('setTaxLevel switches between exactly the four levels', () => {
    const game = createTestGame({ seed: 76 });
    const countryId = Object.keys(game.gameState.government.countries)[0];
    for (const level of TAX_LEVEL_IDS) {
      game.governmentSetTaxLevel(countryId, level);
      game.commandBus.flush();
      expect(game.gameState.government.countries[countryId].budget.tax).toBe(level);
    }
    game.dispose();
  });

  it('power distribution is real, normalized, and puts the biggest party first', () => {
    const game = createTestGame({ seed: 72 });
    const countryId = Object.keys(game.gameState.government.countries)[0];
    const government = game.gameState.government.countries[countryId];
    const distribution = politicalPowerDistribution(government);
    expect(distribution.length).toBe(Object.keys(government.politics.parties).length);
    const total = distribution.reduce((sum, entry) => sum + entry.share, 0);
    expect(total).toBeCloseTo(1, 6);
    // Sorted descending; the FIRST entry is the group at the apex of power.
    for (let i = 1; i < distribution.length; i++) {
      expect(distribution[i - 1].share).toBeGreaterThanOrEqual(distribution[i].share);
    }
    const strongest = Object.values(government.politics.parties).reduce(
      (best, party) => (party.support > best.support ? party : best),
      Object.values(government.politics.parties)[0]
    );
    expect(distribution[0].partyId).toBe(strongest.id);
    game.dispose();
  });

  it('power follows parliament seats once an election has assigned them', () => {
    const game = createTestGame({ seed: 73 });
    const countryId = Object.keys(game.gameState.government.countries)[0];
    const government = game.gameState.government.countries[countryId];
    // Simulate a completed election: REPLACE the party field entirely (two
    // parties; seats assigned — support deliberately inverted vs seats).
    government.politics.parliament.seats = { party_a: 120, party_b: 80 };
    government.politics.parties = {
      party_a: {
        id: 'party_a', name: 'A', ideology: 'centrist',
        support: 0.1, seatShare: 0.6, inGovernment: true
      },
      party_b: {
        id: 'party_b', name: 'B', ideology: 'liberal',
        support: 0.9, seatShare: 0.4, inGovernment: false
      }
    };
    const distribution = politicalPowerDistribution(government);
    expect(distribution.length).toBe(2);
    expect(distribution[0].partyId).toBe('party_a'); // seats (0.6) beat support (0.1)
    expect(distribution[0].share).toBeCloseTo(0.6, 6);
    expect(distribution[1].share).toBeCloseTo(0.4, 6);
    game.dispose();
  });
});
