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

  it('every tick advances the step counter exactly once (no double-advance)', () => {
    const game = createTestGame({ seed: 77 });
    let tickEvents = 0;
    game.gameEvents.on('time.tick', () => tickEvents++);
    game.runFrames(90);
    // One time.tick heartbeat per sim step, and the clock is EXACTLY
    // Hour-mode math over that step count: 60 min per 6 steps.
    expect(tickEvents).toBe(game.gameTime.step);
    expect(game.gameTime.tick).toBe(60 * Math.floor(game.gameTime.step / 6));
    game.dispose();
  });

  it('setSpeedStep command selects a data-driven step through the bus', () => {
    const game = createTestGame({ seed: 77 });
    expect(game.gameTime.speedStepList).toEqual([1, 5, 10]);
    game.gameCommands.send({ type: 'game.setSpeedStep', index: 2 });
    game.frame(1 / 60);
    expect(game.gameTime.speed).toBe(10);
    game.gameCommands.send({ type: 'game.cycleSpeed' });
    game.frame(1 / 60);
    expect(game.gameTime.speed).toBe(1); // wraps back to the slowest
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

  it('HOUR mode steps hour by hour with exact midnight rollover', () => {
    const game = createTestGame({ seed: 77 });
    // Hour cadence: one 60-minute step per 6 sim ticks → 61 ticks = 10 steps.
    game.runTicks(61);
    const date = game.gameTime.date;
    expect(date.hour).toBe(10);
    expect(date.minute).toBe(0);
    expect(date.day).toBe(1);
    // Run to exactly midnight: 24 h = 24 steps = 144 ticks → day 2, 00:00.
    game.runTicks(144 - 61);
    const midnight = game.gameTime.date;
    expect(midnight.day).toBe(2);
    expect(midnight.hour).toBe(0);
    expect(midnight.minute).toBe(0);
    game.dispose();
  });

  it('speed multiplies the RATE of simulated time (10× ≈ 10× the game-minutes)', () => {
    const frames = 240;
    const slow = createTestGame({ seed: 77 });
    slow.runFrames(frames);
    const slowMinutes = slow.gameTime.elapsedMinutes;
    slow.dispose();

    const fast = createTestGame({ seed: 77 });
    fast.gameTime.setSpeedStep(3); // ×10
    fast.runFrames(frames);
    const fastMinutes = fast.gameTime.elapsedMinutes;
    fast.dispose();

    // The clock itself only ever advances in whole game-minutes; the step
    // count scales with speed, so 10× must pass ~10× the simulated time.
    expect(fastMinutes).toBeGreaterThan(slowMinutes * 5);
    expect(fastMinutes).toBeLessThanOrEqual(slowMinutes * 11);
  });

  it('at 10× the date visibly rolls over days (real fast-forward, not minute-spin)', () => {
    const game = createTestGame({ seed: 77 });
    game.gameTime.setSpeedStep(3); // ×10
    // 240 frames × 1/60 s × 10× × 30 Hz = 1200 game-minutes = 20 game-hours…  plus slack.
    game.runFrames(480);
    const elapsedDays = Math.floor(game.gameTime.elapsedMinutes / (24 * 60));
    expect(elapsedDays).toBeGreaterThanOrEqual(1);
    let dayEvents = 0;
    game.gameEvents.on('time.dayChanged', () => dayEvents++);
    game.runFrames(480);
    expect(dayEvents).toBeGreaterThan(0);
    game.dispose();
  });
});
