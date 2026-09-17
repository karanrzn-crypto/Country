import { describe, it, expect } from 'vitest';
import { createTestGame } from '../../helpers/testGame';
import {
  buildGovernmentSlice,
  createGovernmentCountryState,
  governmentRecordIsComplete,
  politicalPowerDistribution,
  setTaxRate,
  setSpendingShare,
  setMinistryFunding,
  DEFAULT_TAX_RATES,
  DEFAULT_SPENDING_SHARES
} from '../../../state/slices/governmentSlice';
import type { PartyTemplate, MinistryTemplate } from '../../../state/slices/governmentSlice';
import { Random } from '../../../utils/Random';
import { stableStringify } from '../../../utils/hash';
import { MAX_TAX_RATE, SPENDING_CATEGORIES, TAX_CATEGORIES } from '../../../government/types';

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

  it('budget defaults cover every category and run a near-balanced budget', () => {
    expect(TAX_CATEGORIES.every((category) => DEFAULT_TAX_RATES[category] !== undefined)).toBe(true);
    expect(SPENDING_CATEGORIES.every((category) => DEFAULT_SPENDING_SHARES[category] !== undefined)).toBe(true);
    const total = SPENDING_CATEGORIES.reduce((sum, category) => sum + DEFAULT_SPENDING_SHARES[category], 0);
    // Revenue model ≈ 12 % of GDP at default rates — spending must be close.
    expect(total).toBeGreaterThan(0.09);
    expect(total).toBeLessThan(0.16);
  });

  it('mutators clamp into their documented domains and reject unknown ids', () => {
    const game = createTestGame({ seed: 55 });
    const countryId = game.strategicMap.countryOrder[0];
    const slice = game.gameState.government;

    expect(setTaxRate(slice, countryId, 'income', 0.9)).toBe(MAX_TAX_RATE);
    expect(setTaxRate(slice, countryId, 'income', -1)).toBe(0);
    expect(setTaxRate(slice, 'unknown', 'income', 0.2)).toBe(0);

    expect(setSpendingShare(slice, countryId, 'military', 0.9)).toBe(0.5);
    expect(setSpendingShare(slice, countryId, 'welfare', -0.5)).toBe(0);

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

describe('Economic Budget lever + political power distribution (spec §4/§5)', () => {
  it('setEconomicBudget scales the non-military shares proportionally and leaves military alone', () => {
    const game = createTestGame({ seed: 71 });
    const countryId = Object.keys(game.gameState.government.countries)[0];
    const budget = game.gameState.government.countries[countryId].budget;
    const militaryBefore = budget.spendingShares.military;
    const nonMilitaryBefore = (Object.keys(budget.spendingShares) as (keyof typeof budget.spendingShares)[])
      .filter((category) => category !== 'military')
      .reduce((sum, category) => sum + budget.spendingShares[category], 0);

    game.governmentSetEconomicBudget(countryId, nonMilitaryBefore * 2);
    game.commandBus.flush();
    const militaryAfter = budget.spendingShares.military;
    const nonMilitaryAfter = (Object.keys(budget.spendingShares) as (keyof typeof budget.spendingShares)[])
      .filter((category) => category !== 'military')
      .reduce((sum, category) => sum + budget.spendingShares[category], 0);

    expect(militaryAfter).toBeCloseTo(militaryBefore, 6); // military untouched
    expect(nonMilitaryAfter).toBeCloseTo(nonMilitaryBefore * 2, 3); // doubled in total
    // Every internal share stays inside its documented domain.
    for (const share of Object.values(budget.spendingShares)) {
      expect(share).toBeGreaterThanOrEqual(0);
      expect(share).toBeLessThanOrEqual(0.5);
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
