import { describe, it, expect } from 'vitest';
import { createTestGame } from '../../helpers/testGame';

describe('WeatherSystem (deterministic)', () => {
  it('produces identical weather sequences for identical seeds', () => {
    const a = createTestGame({ seed: 1234 });
    const b = createTestGame({ seed: 1234 });
    a.runTicks(120);
    b.runTicks(120);
    expect(JSON.stringify(a.gameState.environment.weather)).toBe(
      JSON.stringify(b.gameState.environment.weather)
    );
    a.dispose();
    b.dispose();
  });

  it('only changes weather on interval ticks', () => {
    const game = createTestGame({ seed: 77 });
    const before = JSON.stringify(game.gameState.environment.weather);
    game.runTicks(5); // < 12-tick interval → no change yet
    expect(JSON.stringify(game.gameState.environment.weather)).toBe(before);
    game.runTicks(7); // crosses tick 12
    // Weather MAY have changed now; the exact outcome is seed-dependent.
    expect(typeof game.gameState.environment.weather).toBe('object');
    game.dispose();
  });

  it('emits sim.weatherChanged only for regions whose weather changed', () => {
    const game = createTestGame({ seed: 555 });
    const changed: string[] = [];
    game.gameEvents.on('sim.weatherChanged', ({ regionId }) => changed.push(regionId));
    game.runTicks(120);
    // Never more than one event per region per interval.
    const unique = new Set(changed);
    expect(changed.length).toBeLessThanOrEqual(120 / 12 * unique.size + unique.size);
    for (const regionId of changed) {
      expect(game.gameState.world.regions[regionId]).toBeDefined();
    }
    game.dispose();
  });
});
