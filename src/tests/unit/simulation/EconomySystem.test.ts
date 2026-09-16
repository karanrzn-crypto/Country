import { describe, it, expect } from 'vitest';
import { createTestGame } from '../../helpers/testGame';

describe('EconomySystem', () => {
  it('factories produce outputs at data-driven rates', () => {
    // Default HOUR mode: one clock-unit (60 min) every 6 sim ticks, so
    // 144 ticks = 24 hour-steps = 1440 game-minutes = exactly one game day.
    const game = createTestGame({ seed: 9 });
    const stockpiles = game.gameState.economy.stockpiles;
    const foodBefore = stockpiles.republic.food;
    game.runTicks(144); // exactly one game day in Hour mode
    const foodAfter = game.gameState.economy.stockpiles.republic.food;
    // farm: 10 food/day, 2 farms owned by republic, full day elapsed.
    expect(foodAfter - foodBefore).toBeCloseTo(20, 3);
    game.dispose();
  });

  it('factories with missing inputs stall (no free production)', () => {
    const game = createTestGame({ seed: 9 });
    // Burn all oil: steel_mill & electronics_plant need oil.
    game.gameState.economy.stockpiles.republic.oil = 0;
    // Also prevent oil_derrick from refilling: it belongs to republic in the demo world,
    // so remove the factory's output by marking it inactive.
    game.gameState.economy.factories['oil_south'].active = false;
    const steelBefore = game.gameState.economy.stockpiles.republic.steel;
    game.runTicks(24);
    const steelAfter = game.gameState.economy.stockpiles.republic.steel;
    expect(steelAfter).toBeCloseTo(steelBefore, 3);
    game.dispose();
  });

  it('treasury changes via income minus upkeep and emits events', () => {
    const game = createTestGame({ seed: 9 });
    const events: number[] = [];
    game.gameEvents.on('sim.economyTreasuryChanged', ({ factionId, delta }) => {
      if (factionId === 'republic') events.push(delta);
    });
    const before = game.gameState.economy.treasury.republic;
    game.runTicks(24);
    const after = game.gameState.economy.treasury.republic;
    expect(events.length).toBeGreaterThan(0);
    // Republic income (big population) exceeds upkeep in the demo.
    expect(after).toBeGreaterThan(before);
    game.dispose();
  });

  it('is deterministic for identical seeds', () => {
    const a = createTestGame({ seed: 314 });
    const b = createTestGame({ seed: 314 });
    a.runTicks(48);
    b.runTicks(48);
    expect(a.gameState.economy.treasury.republic).toBe(b.gameState.economy.treasury.republic);
    expect(JSON.stringify(a.gameState.economy.stockpiles)).toBe(
      JSON.stringify(b.gameState.economy.stockpiles)
    );
    a.dispose();
    b.dispose();
  });
});
