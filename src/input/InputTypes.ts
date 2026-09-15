/**
 * Input abstraction: devices emit raw events; an InputMap translates them to
 * semantic actions; gameplay subscribes to actions — never to raw key codes
 * (so rebinding never touches gameplay code).
 */

export type InputDevice = 'keyboard' | 'mouse' | 'gamepad';

export interface RawInputEvent {
  readonly device: InputDevice;
  readonly code: string;
  readonly down: boolean;
  readonly repeat?: boolean;
}

export type InputActionId = string;
export type InputEventSink = (event: RawInputEvent) => void;

export interface InputSource {
  readonly device: InputDevice;
  attach(sink: InputEventSink): void;
  detach(): void;
  /** Optional per-frame polling (gamepads). */
  poll?(sink: InputEventSink): void;
}

export interface InputBindings {
  readonly keyboard: Readonly<Record<string, InputActionId>>;
  readonly gamepad: Readonly<Record<string, InputActionId>>;
}
