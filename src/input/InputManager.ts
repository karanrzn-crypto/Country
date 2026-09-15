import type { SystemContext } from '../core/GameContext';
import type { PhaseSystem, SystemUpdate } from '../core/SystemTypes';
import type { EventBus } from '../events/EventBus';
import type { InputActionId, InputBindings, InputDevice, InputEventSink, InputSource } from './InputTypes';
import { InputMap } from './InputMap';

/**
 * Input phase system. Collects raw events from the active source(s),
 * maintains per-frame pressed/held/released action sets and emits action
 * events. Headless runs simply have no source and this becomes a no-op.
 */
export class InputManager implements PhaseSystem {
  readonly id = 'core.input';
  readonly phase = 'input' as const;

  private readonly map: InputMap;
  private readonly held = new Set<InputActionId>();
  private readonly pressed: { action: InputActionId; device: InputDevice }[] = [];
  private readonly released: { action: InputActionId; device: InputDevice }[] = [];
  private source: InputSource | null = null;

  private readonly sink: InputEventSink = (event) => {
    const action = this.map.resolve(event);
    if (action === null) return;
    if (event.down) {
      if (!this.held.has(action)) {
        this.held.add(action);
        this.pressed.push({ action, device: event.device });
      }
    } else if (this.held.delete(action)) {
      this.released.push({ action, device: event.device });
    }
  };

  constructor(source: InputSource | null, bindings: InputBindings, private readonly events: EventBus) {
    this.map = new InputMap(bindings);
    this.setSource(source);
  }

  setSource(source: InputSource | null): void {
    this.source?.detach();
    this.source = source;
    this.source?.attach(this.sink);
  }

  update(context: SystemContext, update: SystemUpdate): void {
    if (update.kind !== 'frame') return;
    this.source?.poll?.(this.sink);
    for (const { action, device } of this.pressed) {
      this.events.emit('input.actionPressed', { action, device });
    }
    for (const { action, device } of this.released) {
      this.events.emit('input.actionReleased', { action, device });
    }
    this.pressed.length = 0;
    this.released.length = 0;
    void context;
  }

  isDown(action: InputActionId): boolean {
    return this.held.has(action);
  }

  get bindingCount(): number {
    return this.map.bindingCount;
  }

  dispose(): void {
    this.source?.detach();
    this.source = null;
    this.held.clear();
    this.pressed.length = 0;
    this.released.length = 0;
  }
}
