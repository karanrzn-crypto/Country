import { describe, it, expect } from 'vitest';
import { ObjectPool } from '../../../perf/ObjectPool';

describe('ObjectPool', () => {
  it('reuses released instances instead of allocating new ones', () => {
    let created = 0;
    const pool = new ObjectPool<{ value: number }>(() => {
      created++;
      return { value: 0 };
    });

    const first = pool.acquire();
    pool.release(first);
    const second = pool.acquire();
    expect(second).toBe(first);
    expect(created).toBe(1);
  });

  it('calls reset on release', () => {
    const pool = new ObjectPool<{ value: number }>(
      () => ({ value: 1 }),
      (item) => {
        item.value = 0;
      }
    );
    const item = pool.acquire();
    item.value = 42;
    pool.release(item);
    expect(item.value).toBe(0);
  });

  it('tracks stats', () => {
    const pool = new ObjectPool<number>(() => 0, undefined, 2);
    expect(pool.stats.size).toBe(2); // prewarmed
    const a = pool.acquire();
    const b = pool.acquire();
    const c = pool.acquire();
    expect(pool.stats.inUse).toBe(3);
    pool.release(a);
    pool.release(b);
    pool.release(c);
    expect(pool.stats.inUse).toBe(0);
    expect(pool.stats.acquired).toBe(3);
    expect(pool.stats.released).toBe(3);
  });
});
