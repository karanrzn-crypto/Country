import { describe, it, expect } from 'vitest';
import { resolveConfig } from '../../../config/GameConfig';
import { ConfigError } from '../../../utils/errors';

describe('resolveConfig', () => {
  it('returns validated defaults with no overrides', () => {
    const config = resolveConfig();
    expect(config.sim.tickRateHz).toBe(5);
    expect(config.world.activeRadius).toBe(2);
    expect(config.world.simulatedRadius).toBeGreaterThanOrEqual(config.world.activeRadius);
  });

  it('deep-merges partial overrides', () => {
    const config = resolveConfig({
      world: { activeRadius: 3 },
      economy: { startingTreasury: 5000 }
    });
    expect(config.world.activeRadius).toBe(3);
    expect(config.world.chunkSize).toBe(10); // untouched default
    expect(config.economy.startingTreasury).toBe(5000);
  });

  it('rejects invalid values with ConfigError', () => {
    expect(() => resolveConfig({ sim: { tickRateHz: 0 } })).toThrowError(ConfigError);
    expect(() => resolveConfig({ time: { startMonth: 13 } })).toThrowError(ConfigError);
    expect(() => resolveConfig({ combat: { baseAccuracy: 2 } })).toThrowError(ConfigError);
  });

  it('enforces the simulatedRadius >= activeRadius invariant', () => {
    expect(() =>
      resolveConfig({
        world: { activeRadius: 4, simulatedRadius: 2 }
      })
    ).toThrowError(ConfigError);
  });

  it('rejects unknown config fields', () => {
    expect(() =>
      resolveConfig({ unknownSection: { x: 1 } } as never)
    ).toThrowError(ConfigError);
  });
});
