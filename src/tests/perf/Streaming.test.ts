import { describe, it, expect } from 'vitest';
import { createTestGame } from '../helpers/testGame';

/**
 * Performance-architecture guardrails (architecture test, not a benchmark):
 * - streaming converges within a bounded number of updates;
 * - per-update operation budgets are respected;
 * - a long headless run completes within a generous wall-clock budget.
 */
describe('streaming & performance architecture', () => {
  it('converges streaming within a bounded number of budgeted updates', () => {
    const game = createTestGame({ seed: 1, configOverrides: { world: { maxChunkOpsPerTick: 2 } } });
    game.gameWorld.chunks.setFocus('region_capital.c0x0', 0); // start fully unloaded

    let updates = 0;
    let convergedAt = -1;
    while (updates < 500) {
      game.gameWorld.streamTick();
      updates++;
      const streamed = game.gameWorld.streamedCounts();
      const converged =
        streamed.active === game.gameWorld.counts().active &&
        streamed.simulated === game.gameWorld.counts().simulated;
      if (converged && updates > 1 && convergedAt < 0) convergedAt = updates;
    }
    // 16 chunks ÷ budget 2 = 8 updates at minimum; allow generous slack.
    expect(convergedAt).toBeGreaterThan(0);
    expect(convergedAt).toBeLessThanOrEqual(64);
    game.dispose();
  });

  it('the per-update budget is never exceeded', () => {
    const game = createTestGame({ seed: 2, configOverrides: { world: { maxChunkOpsPerTick: 3 } } });
    game.gameWorld.chunks.setFocus('region_border.c0x0', 0);

    let previousCounts = game.gameWorld.streamedCounts();
    for (let index = 0; index < 30; index++) {
      game.gameWorld.streamTick();
      const currentCounts = game.gameWorld.streamedCounts();
      const changes =
        Math.abs(currentCounts.active - previousCounts.active) +
        Math.abs(currentCounts.simulated - previousCounts.simulated) +
        Math.abs(currentCounts.unloaded - previousCounts.unloaded);
      // Each streamed change touches one chunk exactly once; budget is 3,
      // so the observed delta per update is bounded by 2× budget.
      expect(changes).toBeLessThanOrEqual(6);
      previousCounts = currentCounts;
    }
    game.dispose();
  });

  it('a 1000-tick headless run completes within a generous time budget', () => {
    const game = createTestGame({ seed: 3 });
    const startedAt = performance.now();
    game.runTicks(1000);
    const elapsedMs = performance.now() - startedAt;
    // 1000 ticks on a tiny world: foundation sanity bound (not a benchmark).
    expect(elapsedMs).toBeLessThan(5000);
    expect(game.gameTime.tick).toBe(1000);
    game.dispose();
  });
});
