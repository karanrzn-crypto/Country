import { describe, it, expect } from 'vitest';
import { Profiler } from '../../../debug/Profiler';

describe('Profiler', () => {
  it('records measured durations', async () => {
    const profiler = new Profiler();
    profiler.beginFrame();
    profiler.mark('test.work');
    await sleep(2);
    profiler.endMark('test.work');
    profiler.endFrame();

    const stats = profiler.stats('test.work');
    expect(stats).toBeDefined();
    expect(stats?.samples).toBe(1);
    expect(stats?.avgMs).toBeGreaterThanOrEqual(0);
    expect(stats?.maxMs).toBeLessThan(1000);
  });

  it('measure() wraps sync functions', () => {
    const profiler = new Profiler();
    const value = profiler.measure('sync.work', () => 42);
    expect(value).toBe(42);
    expect(profiler.stats('sync.work')?.samples).toBe(1);
  });

  it('keeps a bounded sample ring', () => {
    const profiler = new Profiler();
    for (let index = 0; index < 500; index++) {
      profiler.mark('loop');
      profiler.endMark('loop');
    }
    expect(profiler.stats('loop')?.samples).toBeLessThanOrEqual(120);
  });

  it('dropping endMark leaves no stale state (endFrame clears)', () => {
    const profiler = new Profiler();
    profiler.beginFrame();
    profiler.mark('orphan');
    profiler.endFrame();
    profiler.mark('orphan');
    profiler.endMark('orphan');
    expect(profiler.stats('orphan')?.samples).toBe(1);
  });

  it('disabling clears data and stops recording', () => {
    const profiler = new Profiler();
    profiler.measure('x', () => undefined);
    profiler.setEnabled(false);
    expect(profiler.isEnabled).toBe(false);
    profiler.measure('y', () => undefined);
    expect(profiler.stats('x')).toBeUndefined();
    expect(profiler.stats('y')).toBeUndefined();
  });

  it('lists recorded mark names sorted', () => {
    const profiler = new Profiler();
    profiler.measure('c', () => undefined);
    profiler.measure('a', () => undefined);
    expect(profiler.names()).toEqual(['a', 'c']);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
