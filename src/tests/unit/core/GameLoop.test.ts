import { describe, it, expect } from 'vitest';
import { GameLoop, ManualFrameClock, MAX_FRAME_DELTA_SECONDS } from '../../../core/GameLoop';

describe('GameLoop', () => {
  it('delivers frames with real-time deltas', () => {
    const clock = new ManualFrameClock();
    const deltas: number[] = [];
    const loop = new GameLoop(clock, (dt) => deltas.push(dt));
    loop.start();
    clock.advance(16);
    clock.advance(16);
    clock.advance(16);
    loop.stop();
    expect(deltas).toHaveLength(3);
    for (const delta of deltas) {
      expect(delta).toBeGreaterThan(0);
      expect(delta).toBeLessThanOrEqual(0.02 + 1e-9);
    }
  });

  it('clamps huge deltas (tab-switch / lag protection)', () => {
    const clock = new ManualFrameClock();
    const deltas: number[] = [];
    const loop = new GameLoop(clock, (dt) => deltas.push(dt));
    loop.start();
    clock.advance(5000);
    expect(deltas[0]).toBeCloseTo(MAX_FRAME_DELTA_SECONDS, 10);
    loop.stop();
  });

  it('stop() prevents further frames', () => {
    const clock = new ManualFrameClock();
    let frames = 0;
    const loop = new GameLoop(clock, () => frames++);
    loop.start();
    clock.advance(16);
    loop.stop();
    clock.advance(16);
    expect(frames).toBe(1);
    expect(loop.isRunning).toBe(false);
  });

  it('restart works after stop', () => {
    const clock = new ManualFrameClock();
    let frames = 0;
    const loop = new GameLoop(clock, () => frames++);
    loop.start();
    clock.advance(16);
    loop.stop();
    loop.start();
    clock.advance(16);
    expect(frames).toBe(2);
  });
});
