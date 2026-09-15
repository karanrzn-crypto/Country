import { describe, it, expect } from 'vitest';
import { armorReduction, computeDamage, totalArmorOf } from '../../../combat/DamageSystem';
import { ARMOR_SOFTENING_K } from '../../../combat/DamageSystem';

describe('damage math (pure functions)', () => {
  it('armor 0 → no reduction', () => {
    expect(armorReduction(0, 0)).toBe(0);
    expect(computeDamage(100, 0, 0)).toBe(100);
  });

  it('armor softening: reduction approaches 1 but never exceeds it', () => {
    expect(armorReduction(ARMOR_SOFTENING_K, 0)).toBeCloseTo(0.5, 6);
    expect(armorReduction(ARMOR_SOFTENING_K * 9, 0)).toBeCloseTo(0.9, 6);
    expect(armorReduction(1e9, 0)).toBeLessThan(1);
  });

  it('penetration removes a proportional share of the armor benefit', () => {
    // armor 50 → raw 0.5; pen 1 → full penetration → no reduction.
    expect(armorReduction(50, 1)).toBeCloseTo(0, 6);
    // pen 0.5 → half the armor benefit.
    expect(armorReduction(50, 0.5)).toBeCloseTo(0.25, 6);
  });

  it('computeDamage applies armor and pen together', () => {
    expect(computeDamage(100, 0.5, 50)).toBeCloseTo(75, 6);
    expect(computeDamage(0, 0, 0)).toBe(0);
    expect(computeDamage(-5, 0, 0)).toBe(0);
  });

  it('totalArmorOf sums weighted equipment armor', () => {
    const total = totalArmorOf({ a: 2, b: 1 }, (id) => ({ armor: id === 'a' ? 10 : 5 }));
    expect(total).toBe(25);
  });
});
