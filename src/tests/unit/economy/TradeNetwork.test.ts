/**
 * Global Trade Network tests (world-level trade resolution).
 *
 * Covers the directive's core invariants with EXACT numbers:
 *  - §12's four-country example reproduces step by step (A→B = 20, C→B = 20);
 *  - §9: only the TRUE surplus is sellable, only the TRUE shortage is bought
 *    (a country never sells what it needs itself);
 *  - §7: global supply < global demand → unfilled shortage, the rest covered;
 *  - §8: trades form between ANY two countries — the player is not the hub;
 *  - §10: the market price tier follows the GLOBAL supply/demand ratio;
 *  - determinism: same input → identical flows, order-independent.
 */
import { describe, it, expect } from 'vitest';
import { resolveWorldTradeForResource } from '../../../economy/tradeNetwork';
import { marketTierFromSupplyDemand, marketPriceTierOf } from '../../../economy/market';
import { emptyCountryResourceState, type CountryResourceState } from '../../../economy/resourceTypes';

/** Shorthand: production/consumption vectors per country. */
function world(
  vectors: Record<string, { p?: Record<string, number>; c?: Record<string, number> }>,
  resourceId = 'food'
): {
  countryIds: string[];
  production: Record<string, Record<string, number>>;
  consumption: Record<string, Record<string, number>>;
} {
  const countryIds = Object.keys(vectors);
  const production: Record<string, Record<string, number>> = {};
  const consumption: Record<string, Record<string, number>> = {};
  for (const [countryId, vector] of Object.entries(vectors)) {
    production[countryId] = vector.p ?? {};
    consumption[countryId] = vector.c ?? {};
  }
  void resourceId;
  return { countryIds, production, consumption };
}

describe('the spec §12 example — four countries, one resource', () => {
  it('A→B = 20 and C→B = 20; B is fully covered; D sells nothing', () => {
    const w = world({
      a: { p: { food: 100 }, c: { food: 80 } },  // surplus 20
      b: { p: { food: 50 }, c: { food: 90 } },   // shortage 40
      c: { p: { food: 120 }, c: { food: 100 } }, // surplus 20
      d: { p: { food: 70 }, c: { food: 60 } }    // surplus 10
    });
    const result = resolveWorldTradeForResource(w.countryIds, w.production, w.consumption, 'food');

    expect(result.globalSupply).toBe(50);
    expect(result.globalDemand).toBe(40);
    // Deterministic pair amounts (equal surplus → id tie-break: a before c).
    expect(result.flows).toEqual([
      { sellerId: 'a', buyerId: 'b', amount: 20 },
      { sellerId: 'c', buyerId: 'b', amount: 20 }
    ]);
    expect(result.importsByBuyer['b']).toBe(40);
    expect(result.exportsBySeller['a']).toBe(20);
    expect(result.exportsBySeller['c']).toBe(20);
    expect(result.exportsBySeller['d'] ?? 0).toBe(0); // outcompeted — stays potential
    expect(result.unfilledByBuyer['b'] ?? 0).toBe(0); // fully covered
  });
});

describe('§9 — no meaningless trade', () => {
  it('a country never exports what it needs itself (exportable = max(P−C, 0))', () => {
    // X produces 10, consumes 30 — it canNOT sell 10 and buy 30 back.
    const w = world({
      x: { p: { oil: 10 }, c: { oil: 30 } },
      y: { p: { oil: 100 }, c: { oil: 20 } }
    });
    const result = resolveWorldTradeForResource(w.countryIds, w.production, w.consumption, 'oil');
    expect(result.exportsBySeller['x'] ?? 0).toBe(0);   // nothing sold by X
    expect(result.globalSupply).toBe(80);               // only Y's true surplus
    expect(result.importsByBuyer['x']).toBe(20);        // X's true shortage
    expect(result.flows).toEqual([{ sellerId: 'y', buyerId: 'x', amount: 20 }]);
  });

  it('balanced countries trade nothing (P = C)', () => {
    const w = world({
      a: { p: { wood: 25 }, c: { wood: 25 } },
      b: { p: { wood: 40 }, c: { wood: 40 } }
    });
    const result = resolveWorldTradeForResource(w.countryIds, w.production, w.consumption, 'wood');
    expect(result.flows).toEqual([]);
    expect(result.globalSupply).toBe(0);
    expect(result.globalDemand).toBe(0);
    expect(result.marketTier).toBe('medium');
  });

  it('the player-style self-sufficient country imports NOTHING (Test 1/§5)', () => {
    // Oil 40/30 surplus, Food 60/50 surplus, Wood 25/25 balanced, Iron 15/30 short.
    const w = world({
      home: { p: { oil: 40, food: 60, wood: 25, iron: 15 }, c: { oil: 30, food: 50, wood: 25, iron: 30 } },
      seller: { p: { iron: 60 }, c: { iron: 10 } }
    });
    const result = resolveWorldTradeForResource(w.countryIds, w.production, w.consumption, 'oil');
    expect(result.importsByBuyer['home'] ?? 0).toBe(0);
    const food = resolveWorldTradeForResource(w.countryIds, w.production, w.consumption, 'food');
    expect(food.importsByBuyer['home'] ?? 0).toBe(0);
    const wood = resolveWorldTradeForResource(w.countryIds, w.production, w.consumption, 'wood');
    expect(wood.flows).toEqual([]);
    const iron = resolveWorldTradeForResource(w.countryIds, w.production, w.consumption, 'iron');
    expect(iron.importsByBuyer['home']).toBe(15); // ONLY the genuinely short resource
  });
});

describe('§7 — global shortage and priority', () => {
  it('when supply < demand, the most urgent buyers are served and the rest stay unfilled', () => {
    // Supply 10, demand 10+8: largest shortage (b) is served first.
    const w = world({
      s: { p: { iron: 30 }, c: { iron: 20 } },  // surplus 10
      b: { p: { iron: 12 }, c: { iron: 22 } },  // shortage 10
      c: { p: { iron: 4 }, c: { iron: 12 } }    // shortage 8
    });
    const result = resolveWorldTradeForResource(w.countryIds, w.production, w.consumption, 'iron');
    expect(result.globalSupply).toBe(10);
    expect(result.globalDemand).toBe(18);
    expect(result.importsByBuyer['b']).toBe(10);   // the bigger shortage first
    expect(result.unfilledByBuyer['c']).toBe(8);   // the world ran out — honest remainder
    expect(result.unfilledByBuyer['b'] ?? 0).toBe(0);
    expect(result.exportsBySeller['s']).toBe(10);
  });

  it('a shortage covered exactly reads unfilled = 0 (Test 2)', () => {
    const w = world({
      buyer: { p: { oil: 20 }, c: { oil: 30 } },
      seller: { p: { oil: 50 }, c: { oil: 30 } }
    });
    const result = resolveWorldTradeForResource(w.countryIds, w.production, w.consumption, 'oil');
    expect(result.importsByBuyer['buyer']).toBe(10);
    expect(result.unfilledByBuyer['buyer'] ?? 0).toBe(0);
  });
});

describe('§8 — any pair may trade (the player is not the hub)', () => {
  it('two AI countries trade while the player sits out entirely (Tests 4/5)', () => {
    const w = world({
      player: { p: { coal: 50 }, c: { coal: 50 } }, // balanced — never in the market
      a: { p: { coal: 10 }, c: { coal: 40 } },      // shortage 30
      b: { p: { coal: 90 }, c: { coal: 40 } }       // surplus 50
    });
    const result = resolveWorldTradeForResource(w.countryIds, w.production, w.consumption, 'coal');
    expect(result.flows).toEqual([{ sellerId: 'b', buyerId: 'a', amount: 30 }]);
    expect(result.importsByBuyer['player'] ?? 0).toBe(0);
    expect(result.exportsBySeller['player'] ?? 0).toBe(0);
  });

  it('two disjoint pairs trade simultaneously (A←B food, C←D oil)', () => {
    const w = world({
      a: { p: { food: 10 }, c: { food: 30 } },
      b: { p: { food: 80, oil: 5 }, c: { food: 20, oil: 5 } },
      c: { p: { oil: 10 }, c: { oil: 30 } },
      d: { p: { oil: 80, food: 5 }, c: { oil: 20, food: 5 } }
    });
    const food = resolveWorldTradeForResource(w.countryIds, w.production, w.consumption, 'food');
    expect(food.flows).toEqual([{ sellerId: 'b', buyerId: 'a', amount: 20 }]);
    const oil = resolveWorldTradeForResource(w.countryIds, w.production, w.consumption, 'oil');
    expect(oil.flows).toEqual([{ sellerId: 'd', buyerId: 'c', amount: 20 }]);
  });
});

describe('§10 — the global market price tier', () => {
  it('supply ≫ demand → cheap; balanced → normal; supply ≪ demand → expensive', () => {
    expect(marketTierFromSupplyDemand(100, 40)).toBe('low');
    expect(marketTierFromSupplyDemand(50, 50)).toBe('medium');
    expect(marketTierFromSupplyDemand(40, 100)).toBe('high');
  });

  it('edge cases: no demand → cheap, no supply → expensive, neither → normal', () => {
    expect(marketTierFromSupplyDemand(30, 0)).toBe('low');
    expect(marketTierFromSupplyDemand(0, 30)).toBe('high');
    expect(marketTierFromSupplyDemand(0, 0)).toBe('medium');
  });

  it('marketPriceTierOf reads the live records with the SAME thresholds', () => {
    const records: Record<string, CountryResourceState> = {
      glutton: emptyCountryResourceState(),
      hungry: emptyCountryResourceState()
    };
    records.glutton.production['gold'] = 200;
    records.glutton.consumption['gold'] = 10;
    records.hungry.production['gold'] = 5;
    records.hungry.consumption['gold'] = 15;
    // Supply 190, demand 10 → ratio 19 → cheap.
    expect(marketPriceTierOf(records, Object.keys(records), 'gold')).toBe('low');
    records.glutton.production['gold'] = 12;
    // Supply 2, demand 10 → scarcity → expensive.
    expect(marketPriceTierOf(records, Object.keys(records), 'gold')).toBe('high');
  });
});

describe('determinism and order-independence', () => {
  it('same world in a different array order → identical trade results', () => {
    const vectors = {
      a: { p: { iron: 100 }, c: { iron: 60 } },
      b: { p: { iron: 20 }, c: { iron: 70 } },
      c: { p: { iron: 40 }, c: { iron: 30 } },
      d: { p: { iron: 15 }, c: { iron: 35 } }
    };
    const forward = world(vectors);
    const first = resolveWorldTradeForResource(forward.countryIds, forward.production, forward.consumption, 'iron');
    const reversed = world({
      d: vectors.d,
      c: vectors.c,
      b: vectors.b,
      a: vectors.a
    });
    const second = resolveWorldTradeForResource(
      [...reversed.countryIds].reverse(),
      reversed.production,
      reversed.consumption,
      'iron'
    );
    expect(second.flows).toEqual(first.flows);
    expect(second.importsByBuyer).toEqual(first.importsByBuyer);
    expect(second.exportsBySeller).toEqual(first.exportsBySeller);
    expect(second.unfilledByBuyer).toEqual(first.unfilledByBuyer);
  });

  it('every flow is positive and seller ≠ buyer', () => {
    const w = world({
      a: { p: { food: 100 }, c: { food: 80 } },
      b: { p: { food: 50 }, c: { food: 90 } },
      c: { p: { food: 120 }, c: { food: 100 } },
      d: { p: { food: 70 }, c: { food: 60 } }
    });
    const result = resolveWorldTradeForResource(w.countryIds, w.production, w.consumption, 'food');
    for (const flow of result.flows) {
      expect(flow.amount).toBeGreaterThan(0);
      expect(flow.sellerId).not.toBe(flow.buyerId);
    }
  });
});
