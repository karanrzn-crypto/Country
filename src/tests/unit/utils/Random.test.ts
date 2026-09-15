import { describe, it, expect } from 'vitest';
import { Random } from '../../../utils/Random';

describe('Random (deterministic RNG)', () => {
  it('produces identical streams for identical seeds', () => {
    const a = new Random(1337);
    const b = new Random(1337);
    for (let index = 0; index < 1000; index++) {
      expect(a.next()).toBe(b.next());
    }
  });

  it('produces different streams for different seeds', () => {
    const a = new Random(1);
    const b = new Random(2);
    const seqA = Array.from({ length: 10 }, () => a.next());
    const seqB = Array.from({ length: 10 }, () => b.next());
    expect(seqA).not.toEqual(seqB);
  });

  it('keeps next() within [0, 1)', () => {
    const rng = new Random(7);
    for (let index = 0; index < 10000; index++) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('int/range respect their bounds', () => {
    const rng = new Random(99);
    for (let index = 0; index < 1000; index++) {
      const value = rng.int(5);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(5);
      const ranged = rng.range(3, 7);
      expect(ranged).toBeGreaterThanOrEqual(3);
      expect(ranged).toBeLessThanOrEqual(7);
    }
  });

  it('state save/restore reproduces the stream exactly', () => {
    const rng = new Random(2024);
    for (let index = 0; index < 50; index++) rng.next();
    const saved = rng.getState();
    const expected = Array.from({ length: 20 }, () => rng.next());

    rng.setState(saved);
    const replayed = Array.from({ length: 20 }, () => rng.next());
    expect(replayed).toEqual(expected);
  });

  it('chance respects probability bounds', () => {
    const rng = new Random(5);
    expect(rng.chance(0)).toBe(false);
    expect(rng.chance(1)).toBe(true);
  });
});
