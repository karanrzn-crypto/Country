import type { InputBindings, InputEventSink, InputSource } from './InputTypes';

/**
 * DOM keyboard source. Prevents default browser behavior for bound keys
 * (Space scrolling, F3 search...) without touching gameplay code.
 */
export class KeyboardMouseSource implements InputSource {
  readonly device = 'keyboard' as const;
  private sink: InputEventSink | null = null;

  constructor(private readonly preventCodes: ReadonlySet<string> = new Set()) {}

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.preventCodes.has(event.code) && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
    }
    this.sink?.({ device: 'keyboard', code: event.code, down: true, repeat: event.repeat });
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.sink?.({ device: 'keyboard', code: event.code, down: false });
  };

  attach(sink: InputEventSink): void {
    this.sink = sink;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
  }

  detach(): void {
    this.sink = null;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
  }
}

/** Minimal gamepad polling source (edge-detected buttons). */
export class GamepadSource implements InputSource {
  readonly device = 'gamepad' as const;
  private readonly previous = new Set<number>();

  attach(_sink: InputEventSink): void {
    // Poll-based source: nothing to register here.
  }

  detach(): void {
    this.previous.clear();
  }

  poll(sink: InputEventSink): void {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return;
    for (const gamepad of navigator.getGamepads()) {
      if (gamepad === null) continue;
      gamepad.buttons.forEach((button, index) => {
        const pressed = button.pressed;
        const wasPressed = this.previous.has(index);
        if (pressed && !wasPressed) {
          sink({ device: 'gamepad', code: String(index), down: true });
          this.previous.add(index);
        } else if (!pressed && wasPressed) {
          sink({ device: 'gamepad', code: String(index), down: false });
          this.previous.delete(index);
        }
      });
    }
  }
}

/** Builds the default keyboard source preventing default behavior for bound keys. */
export function createKeyboardSource(bindings: InputBindings): KeyboardMouseSource {
  return new KeyboardMouseSource(new Set(Object.keys(bindings.keyboard)));
}
