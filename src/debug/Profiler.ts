/**
 * Lightweight profiler with named marks and ring-buffer samples.
 * Systems are wrapped in marks by the Game kernel; debug UI aggregates.
 * Disabling the profiler makes marks no-ops (zero overhead in production).
 */

export interface ProfilerStats {
  readonly samples: number;
  readonly avgMs: number;
  readonly maxMs: number;
  readonly lastMs: number;
}

const MAX_SAMPLES_PER_MARK = 120;

export class Profiler {
  private enabled = true;
  private readonly openMarks = new Map<string, number>();
  private readonly samples = new Map<string, number[]>();
  private frameCount = 0;

  mark(name: string): void {
    if (!this.enabled) return;
    this.openMarks.set(name, performance.now());
  }

  endMark(name: string): void {
    if (!this.enabled) return;
    const startedAt = this.openMarks.get(name);
    if (startedAt === undefined) return;
    this.openMarks.delete(name);
    this.record(name, performance.now() - startedAt);
  }

  measure<T>(name: string, fn: () => T): T {
    if (!this.enabled) return fn();
    this.mark(name);
    try {
      return fn();
    } finally {
      this.endMark(name);
    }
  }

  private record(name: string, durationMs: number): void {
    let ring = this.samples.get(name);
    if (ring === undefined) {
      ring = [];
      this.samples.set(name, ring);
    }
    ring.push(durationMs);
    if (ring.length > MAX_SAMPLES_PER_MARK) ring.shift();
  }

  stats(name: string): ProfilerStats | undefined {
    const ring = this.samples.get(name);
    if (ring === undefined || ring.length === 0) return undefined;
    let sum = 0;
    let max = 0;
    for (const ms of ring) {
      sum += ms;
      if (ms > max) max = ms;
    }
    return {
      samples: ring.length,
      avgMs: sum / ring.length,
      maxMs: max,
      lastMs: ring[ring.length - 1]
    };
  }

  names(): string[] {
    return [...this.samples.keys()].sort();
  }

  beginFrame(): void {
    if (!this.enabled) return;
    this.frameCount += 1;
  }

  endFrame(): void {
    if (!this.enabled) return;
    // Any marks left open at frame end are dropped (instruments a bug).
    this.openMarks.clear();
  }

  get frames(): number {
    return this.frameCount;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.openMarks.clear();
      this.samples.clear();
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  reset(): void {
    this.samples.clear();
    this.openMarks.clear();
    this.frameCount = 0;
  }
}
