/**
 * Generic object pool. Used where entities churn frequently (projectiles,
 * particles later, UI elements) to avoid GC pressure — but only where churn
 * is real (no premature optimization).
 */

export interface PoolStats {
  readonly size: number;
  readonly inUse: number;
  readonly acquired: number;
  readonly released: number;
}

export class ObjectPool<T> {
  private readonly free: T[] = [];
  private inUse = 0;
  private acquiredCount = 0;
  private releasedCount = 0;

  constructor(
    private readonly factory: () => T,
    private readonly reset?: (item: T) => void,
    prewarm = 0
  ) {
    for (let i = 0; i < prewarm; i++) this.free.push(factory());
  }

  acquire(): T {
    const item = this.free.pop() ?? this.factory();
    this.inUse += 1;
    this.acquiredCount += 1;
    return item;
  }

  release(item: T): void {
    this.reset?.(item);
    this.free.push(item);
    this.inUse -= 1;
    this.releasedCount += 1;
  }

  get stats(): PoolStats {
    return {
      size: this.free.length,
      inUse: this.inUse,
      acquired: this.acquiredCount,
      released: this.releasedCount
    };
  }
}
