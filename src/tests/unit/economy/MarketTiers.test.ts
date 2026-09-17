/**
 * Market pricing tests (spec §4/§6/§7) — tiers derived from REAL surpluses
 * and deficits, never random, never hand-set:
 *  - seller side: surplus ↑ → cheaper (the spec's 100/40/10 → Low/Medium/High)
 *  - buyer side: shortage ↑ → willingness to pay ↑ (the spec's 20/10/3)
 *  - determinism and order-independence
 */
import { describe, it, expect } from 'vitest';
import {
  spareSurplusOf,
  unmetDeficitOf,
  tiersFromSpares,
  demandTiersFromNeeds,
  demandFactorFromNeeds,
  sellerPriceTiersOf,
  buyerDemandTiersOf
} from '../../../economy/market';
import { emptyCountryResourceState, type CountryResourceState } from '../../../economy/resourceTypes';

function recordWith(fields: {
  production?: Record<string, number>;
  consumption?: Record<string, number>;
  exports?: Record<string, number>;
}): CountryResourceState {
  const record = emptyCountryResourceState();
  Object.assign(record.production, fields.production ?? {});
  Object.assign(record.consumption, fields.consumption ?? {});
  Object.assign(record.exports, fields.exports ?? {});
  return record;
}

describe('seller price tiers (§4: surplus ↑ → price ↓)', () => {
  it('the spec example: spares 100/40/10 → Low/Medium/High', () => {
    const tiers = tiersFromSpares({ a: 100, b: 40, c: 10 });
    expect(tiers['a']).toBe('low');
    expect(tiers['b']).toBe('medium');
    expect(tiers['c']).toBe('high');
  });

  it('countries without spare are not sellers; nothing is random', () => {
    const tiers = tiersFromSpares({ a: 50, b: 0, c: -5 });
    expect(tiers['a']).toBe('low'); // the ONLY seller holds everything → cheap
    expect('b' in tiers).toBe(false);
    expect('c' in tiers).toBe(false);
    // Deterministic: same input → same output.
    expect(tiersFromSpares({ a: 50, b: 0, c: -5 })).toEqual(tiers);
  });

  it('spareSurplusOf = production − consumption − what is already offered', () => {
    const record = recordWith({ production: { iron: 40 }, consumption: { iron: 10 }, exports: { iron: 12 } });
    expect(spareSurplusOf(record, 'iron')).toBe(18);
    // A deficit is never a spare.
    const short = recordWith({ production: { iron: 5 }, consumption: { iron: 20 } });
    expect(spareSurplusOf(short, 'iron')).toBe(0);
  });

  it('sellerPriceTiersOf reads the committed records (UI parity)', () => {
    const records = {
      a: recordWith({ production: { oil: 120 }, consumption: { oil: 20 } }),
      b: recordWith({ production: { oil: 50 }, consumption: { oil: 10 } }),
      c: recordWith({ production: { oil: 12 }, consumption: { oil: 2 } })
    };
    const tiers = sellerPriceTiersOf(records, ['a', 'b', 'c'], 'oil');
    expect(tiers['a']).toBe('low');
    expect(tiers['b']).toBe('medium');
    expect(tiers['c']).toBe('high');
  });
});

describe('buyer demand tiers (§6: shortage ↑ → willingness to pay ↑)', () => {
  it('the spec example: needs 20/10/3 → High/Medium/Low', () => {
    const tiers = demandTiersFromNeeds({ a: 20, b: 10, c: 3 });
    expect(tiers['a'].tier).toBe('high');
    expect(tiers['a'].need).toBe(20);
    expect(tiers['b'].tier).toBe('medium');
    expect(tiers['c'].tier).toBe('low');
  });

  it('unmetDeficitOf = consumption − production (never negative)', () => {
    const buyer = recordWith({ production: { iron: 14 }, consumption: { iron: 29 } });
    expect(unmetDeficitOf(buyer, 'iron')).toBe(15);
    const seller = recordWith({ production: { iron: 30 }, consumption: { iron: 10 } });
    expect(unmetDeficitOf(seller, 'iron')).toBe(0);
  });

  it('buyers without deficit are not buyers', () => {
    const records = {
      a: recordWith({ production: { iron: 10 }, consumption: { iron: 30 } }),
      b: recordWith({ production: { iron: 40 }, consumption: { iron: 40 } })
    };
    const demands = buyerDemandTiersOf(records, ['a', 'b'], 'iron');
    expect(Object.keys(demands)).toEqual(['a']);
    expect(demands['a'].tier).toBe('high');
  });
});

describe('demand factor (§7: the market reacts, simply)', () => {
  it('the average willingness to pay sits between the tier factors', () => {
    const factors = { low: 0.85, medium: 1, high: 1.15 };
    // One eager buyer → the eager factor.
    expect(demandFactorFromNeeds({ a: 20, b: 5, c: 2 }, factors)).toBeCloseTo((1.15 + 1 + 0.85) / 3, 6);
    // No buyers at all → neutral.
    expect(demandFactorFromNeeds({}, factors)).toBe(1);
  });
});
