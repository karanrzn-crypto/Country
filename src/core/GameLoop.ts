/**
 * Frame clock abstraction decoupling the loop from the browser.
 * Tests and headless runs inject a ManualFrameClock for full control.
 */
export interface FrameClock {
  now(): number;
  request(callback: (timestampMs: number) => void): void;
}

/** Browser clock driven by requestAnimationFrame. */
export class RafFrameClock implements FrameClock {
  now(): number {
    return performance.now();
  }

  request(callback: (timestampMs: number) => void): void {
    requestAnimationFrame(callback);
  }
}

/** Manually-advanced clock for tests and headless execution. */
export class ManualFrameClock implements FrameClock {
  private currentTime = 0;
  private pending: ((timestampMs: number) => void) | null = null;

  now(): number {
    return this.currentTime;
  }

  request(callback: (timestampMs: number) => void): void {
    this.pending = callback;
  }

  /** Advances virtual time and fires the pending frame callback, if any. */
  advance(deltaMs: number): void {
    this.currentTime += deltaMs;
    const callback = this.pending;
    this.pending = null;
    callback?.(this.currentTime);
  }
}

/** Upper bound for a single frame delta (spiral-of-death protection). */
export const MAX_FRAME_DELTA_SECONDS = 0.25;

/**
 * Fixed-timestep game loop. Produces clamped real-time frame deltas; the
 * Game converts them into fixed simulation ticks via an accumulator.
 * The loop itself knows nothing about simulation or rendering.
 */
export class GameLoop {
  private running = false;
  private lastTime = 0;

  constructor(
    private readonly clock: FrameClock,
    private readonly onFrame: (dtRealSeconds: number) => void
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = this.clock.now();
    const tick = (timestampMs: number): void => {
      if (!this.running) return;
      let dtSeconds = (timestampMs - this.lastTime) / 1000;
      if (dtSeconds < 0) dtSeconds = 0;
      if (dtSeconds > MAX_FRAME_DELTA_SECONDS) dtSeconds = MAX_FRAME_DELTA_SECONDS;
      this.lastTime = timestampMs;
      this.onFrame(dtSeconds);
      this.clock.request(tick);
    };
    this.clock.request(tick);
  }

  stop(): void {
    this.running = false;
  }

  get isRunning(): boolean {
    return this.running;
  }
}
