import type { SystemContext } from '../../core/GameContext';
import type { PhaseSystem, SystemUpdate } from '../../core/SystemTypes';
import type { EventBus } from '../../events/EventBus';
import type { Unsubscribe } from '../../events/EventBus';

/**
 * Map camera input (core-side, renderer-free):
 * - held movement actions pan the logical camera (clamped by Game.mapSetCamera)
 * - discrete zoom actions step the view height
 *
 * The browser pointer (drag/wheel/click) is handled presentation-side and
 * arrives through the same command contract. Keyboard mapping stays fully
 * data-driven via inputBindings.json.
 */
export class MapCameraController implements PhaseSystem {
  readonly id = 'world.mapCamera';
  readonly phase = 'state' as const;

  private readonly unsubscribes: Unsubscribe[] = [];

  constructor(private readonly events: EventBus) {}

  init(context: SystemContext): void {
    const zoomStep = 0.85; // zoom-in factor per press (< 1 = closer)
    this.unsubscribes.push(
      this.events.on('input.actionPressed', ({ action }) => {
        if (action === 'zoomIn') context.commands.send({ type: 'map.zoomBy', factor: zoomStep });
        else if (action === 'zoomOut') context.commands.send({ type: 'map.zoomBy', factor: 1 / zoomStep });
      })
    );
  }

  update(context: SystemContext, update: SystemUpdate): void {
    if (update.kind !== 'frame') return;
    const input = context.input;
    if (input === null) return;

    const dx = (input.isDown('moveEast') ? 1 : 0) - (input.isDown('moveWest') ? 1 : 0);
    const dz = (input.isDown('moveSouth') ? 1 : 0) - (input.isDown('moveNorth') ? 1 : 0);
    if (dx === 0 && dz === 0) return;

    const camera = context.state.map.camera;
    const viewport = context.state.map.viewport;
    // Pan speed scales with the visible world width so it feels identical
    // at every zoom level.
    const worldPerSecond =
      camera.viewHeight * viewport.width * context.config.map.panSpeedFractionPerSecond;
    const step = (worldPerSecond * update.frame.dtRealSeconds) / Math.max(1, viewport.width);
    if (dx !== 0 || dz !== 0) {
      context.commands.send({ type: 'map.panBy', dx: dx * step, dz: dz * step });
    }
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes.length = 0;
  }
}
