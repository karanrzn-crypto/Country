import { describe, it, expect } from 'vitest';
import { createTestGame } from '../../helpers/testGame';

/**
 * Game clock (Part 4): the TimeSystem is THE single source of truth for
 * game time. Pause must stop the tick pipeline entirely (time-dependent
 * systems must not run at all — and never run "twice" for the same moment),
 * rendering/UI keep running, and resume continues from the exact tick where
 * the game stopped. Speeds are step-based and owned by the TimeSystem.
 */
describe('Game clock: pause / resume / speed steps', () => {
  it('paused game: no ticks, no time events — rendering-style frames still run', () => {
    const game = createTestGame({ seed: 77 });
    game.runFrames(60);
    const tickBefore = game.gameTime.tick;
    expect(tickBefore).toBeGreaterThan(0);

    let tickEvents = 0;
    game.gameEvents.on('time.tick', () => tickEvents++);
    game.setPaused(true);
    expect(game.gameTime.isPaused).toBe(true);
    game.runFrames(120);
    expect(game.gameTime.tick).toBe(tickBefore);
    expect(tickEvents).toBe(0);
    game.dispose();
  });

  it('resume continues from the exact tick where the game stopped', () => {
    const game = createTestGame({ seed: 77 });
    game.runFrames(60);
    const stoppedAt = game.gameTime.tick;
    game.setPaused(true);
    game.runFrames(30);
    expect(game.gameTime.tick).toBe(stoppedAt);
    game.setPaused(false);
    game.runFrames(60);
    expect(game.gameTime.tick).toBeGreaterThan(stoppedAt);
    game.dispose();
  });

  it('every tick advances time exactly once (no double-advance)', () => {
    const game = createTestGame({ seed: 77 });
    let tickEvents = 0;
    game.gameEvents.on('time.tick', () => tickEvents++);
    game.runFrames(90);
    expect(tickEvents).toBe(game.gameTime.tick);
    game.dispose();
  });

  it('setSpeedStep command selects a data-driven step through the bus', () => {
    const game = createTestGame({ seed: 77 });
    expect(game.gameTime.speedStepList).toEqual([1, 2, 5, 10]);
    game.gameCommands.send({ type: 'game.setSpeedStep', index: 2 });
    game.frame(1 / 60);
    expect(game.gameTime.speed).toBe(5);
    game.gameCommands.send({ type: 'game.cycleSpeed' });
    game.frame(1 / 60);
    expect(game.gameTime.speed).toBe(10);
    game.dispose();
  });

  it('higher speed advances the clock faster (speed is owned by TimeSystem)', () => {
    const slow = createTestGame({ seed: 77 });
    slow.runFrames(90); // speed 1
    const slowTicks = slow.gameTime.tick;
    slow.dispose();

    const fast = createTestGame({ seed: 77 });
    fast.gameTime.setSpeedStep(3); // ×10
    fast.runFrames(90);
    const fastTicks = fast.gameTime.tick;
    fast.dispose();

    expect(fastTicks).toBeGreaterThan(slowTicks * 5);
  });

  it('game.setPaused command works through the bus', () => {
    const game = createTestGame({ seed: 77 });
    game.gameCommands.send({ type: 'game.setPaused', paused: true });
    game.frame(1 / 60);
    expect(game.gameTime.isPaused).toBe(true);
    game.gameCommands.send({ type: 'game.setPaused', paused: false });
    game.frame(1 / 60);
    expect(game.gameTime.isPaused).toBe(false);
    game.dispose();
  });
});
