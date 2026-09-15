import type { SystemContext } from '../core/GameContext';
import type { PhaseSystem, SystemUpdate } from '../core/SystemTypes';
import type { UIDomAdapter, UIElement } from '../ui/adapter/UIDomAdapter';

export type DebugStatsProvider = {
  readonly label: string;
  readonly read: () => Readonly<Record<string, string | number>>;
};

/**
 * Debug overlay (F3): profiler stats + provider stats + state counters.
 * Text-only, throttled; headless-safe (no adapter → no-op).
 */
export class DebugOverlay implements PhaseSystem {
  readonly id = 'core.debugOverlay';
  readonly phase = 'render' as const;

  private readonly element: UIElement | null;
  private visible: boolean;
  private frameCounter = 0;
  private readonly unsubscribes: (() => void)[] = [];

  constructor(
    adapter: UIDomAdapter | null,
    visibleByDefault: boolean,
    private readonly providers: readonly DebugStatsProvider[] = []
  ) {
    this.visible = visibleByDefault;
    if (adapter === null) {
      this.element = null;
      return;
    }
    this.element = adapter.create('div', 'debug-overlay');
    this.element.setVisible(this.visible);
    adapter.root().appendChild(this.element);
  }

  init(context: SystemContext): void {
    this.unsubscribes.push(
      context.events.on('input.actionPressed', ({ action }) => {
        if (action === 'toggleDebug') this.toggle();
      })
    );
  }

  toggle(): void {
    this.visible = !this.visible;
    this.element?.setVisible(this.visible);
  }

  update(context: SystemContext, update: SystemUpdate): void {
    if (update.kind !== 'frame' || this.element === null || !this.visible) return;
    this.frameCounter = update.frame.frameIndex;
    if (this.frameCounter % 10 !== 0) return;
    this.element.setText(this.buildText(context));
  }

  private buildText(context: SystemContext): string {
    const lines: string[] = [];
    const fps = context.perf.fps > 0 ? context.perf.fps.toFixed(0) : '—';
    lines.push(`fps ${fps}   tier ${context.perf.qualityTier}   frame #${this.frameCounter}`);
    lines.push(`tick ${context.time.tick}   paused ${context.time.isPaused}   speed ×${context.time.speed}`);
    const counts = context.world.counts();
    lines.push(`chunks active ${counts.active} / simulated ${counts.simulated} / unloaded ${counts.unloaded}`);
    lines.push(`units ${Object.keys(context.state.military.units).length}   events ${context.events.listenerCount()}`);
    for (const name of context.profiler.names()) {
      const stats = context.profiler.stats(name);
      if (stats === undefined) continue;
      lines.push(`${name}: avg ${stats.avgMs.toFixed(2)}ms  max ${stats.maxMs.toFixed(2)}ms`);
    }
    for (const provider of this.providers) {
      const values = provider.read();
      const parts = Object.entries(values).map(([key, value]) => `${key} ${value}`);
      if (parts.length > 0) lines.push(`${provider.label}: ${parts.join('  ')}`);
    }
    return lines.join('\n');
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes.length = 0;
    this.element?.remove();
  }
}
