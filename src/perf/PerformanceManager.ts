import type { EventBus } from '../events/EventBus';
import type { PerformanceConfig, QualityTier } from '../config/configTypes';
import { clamp } from '../utils/math';

/**
 * Frame performance sampler + automatic quality tier suggestion.
 * Emits 'perf.qualityTierChanged' with hysteresis so the renderer (pixel
 * ratio, future LOD budgets) can react. Measurement-driven, not speculative.
 */
export class PerformanceManager {
  private readonly frameTimesMs: number[] = [];
  private currentFps = 0;
  private tier: QualityTier = 'high';
  private lastTierChangeFrame = -1_000_000;
  private frameIndex = 0;

  constructor(
    private readonly config: PerformanceConfig,
    private readonly events: EventBus
  ) {}

  sampleFrame(dtSeconds: number): void {
    this.frameIndex += 1;
    this.frameTimesMs.push(dtSeconds * 1000);
    if (this.frameTimesMs.length > this.config.fpsSampleWindow) {
      this.frameTimesMs.shift();
    }
    if (this.frameIndex % 30 !== 0 || this.frameTimesMs.length === 0) return;

    const avgMs = this.frameTimesMs.reduce((sum, ms) => sum + ms, 0) / this.frameTimesMs.length;
    this.currentFps = avgMs > 0 ? clamp(1000 / avgMs, 0, 1000) : 0;

    if (!this.config.autoQuality) return;
    if (this.frameIndex - this.lastTierChangeFrame < 240) return;

    const desired: QualityTier = this.currentFps < 30 ? 'low' : this.currentFps < 50 ? 'medium' : 'high';
    if (desired !== this.tier) {
      this.tier = desired;
      this.lastTierChangeFrame = this.frameIndex;
      this.events.emit('perf.qualityTierChanged', { tier: desired, fps: this.currentFps });
    }
  }

  get fps(): number {
    return this.currentFps;
  }

  get qualityTier(): QualityTier {
    return this.tier;
  }

  get sampledFrames(): number {
    return this.frameIndex;
  }
}
