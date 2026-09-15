import type { InputActionId, InputBindings, InputDevice, RawInputEvent } from './InputTypes';

/**
 * Data-driven device-event → action mapping (src/data/inputBindings.json).
 * Unknown devices and unmapped codes resolve to null and are ignored.
 */
export class InputMap {
  private readonly keyboard = new Map<string, InputActionId>();
  private readonly gamepad = new Map<string, InputActionId>();

  constructor(bindings: InputBindings) {
    for (const [code, action] of Object.entries(bindings.keyboard)) {
      this.keyboard.set(code, action);
    }
    for (const [code, action] of Object.entries(bindings.gamepad)) {
      this.gamepad.set(code, action);
    }
  }

  resolve(event: RawInputEvent): InputActionId | null {
    if (event.repeat === true) return null;
    const map = this.mapFor(event.device);
    if (map === undefined) return null;
    return map.get(event.code) ?? null;
  }

  private mapFor(device: InputDevice): Map<string, InputActionId> | undefined {
    if (device === 'keyboard') return this.keyboard;
    if (device === 'gamepad') return this.gamepad;
    return undefined; // mouse bindings arrive with pointer work in Phase 1
  }

  get bindingCount(): number {
    return this.keyboard.size + this.gamepad.size;
  }
}
