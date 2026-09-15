/**
 * Deterministic seeded RNG (mulberry32).
 *
 * The complete internal state is a single 32-bit integer, so it can be
 * captured and restored for save games, deterministic replays and tests.
 * All gameplay randomness MUST go through this class — never Math.random().
 */
export class Random {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Deterministic float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [0, maxExclusive). */
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }

  /** Integer in [minInclusive, maxInclusive]. */
  range(minInclusive: number, maxInclusive: number): number {
    return minInclusive + this.int(maxInclusive - minInclusive + 1);
  }

  /** True with probability p (clamped to [0,1]). */
  chance(p: number): boolean {
    const prob = p < 0 ? 0 : p > 1 ? 1 : p;
    return this.next() < prob;
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }

  getState(): number {
    return this.state >>> 0;
  }

  setState(state: number): void {
    this.state = state >>> 0;
  }
}
