import { describe, it, expect } from 'vitest';
import { InputMap } from '../../../input/InputMap';
import { InputManager } from '../../../input/InputManager';
import { EventBus } from '../../../events/EventBus';
import type { InputBindings, InputEventSink, InputSource } from '../../../input/InputTypes';

const BINDINGS: InputBindings = {
  keyboard: { KeyW: 'moveNorth', KeyS: 'moveSouth', Space: 'togglePause', F3: 'toggleDebug' },
  gamepad: { '0': 'togglePause' }
};

describe('InputMap', () => {
  it('resolves keyboard codes to actions', () => {
    const map = new InputMap(BINDINGS);
    expect(map.resolve({ device: 'keyboard', code: 'KeyW', down: true })).toBe('moveNorth');
    expect(map.resolve({ device: 'keyboard', code: 'Unknown', down: true })).toBeNull();
  });

  it('ignores auto-repeat events', () => {
    const map = new InputMap(BINDINGS);
    expect(map.resolve({ device: 'keyboard', code: 'KeyW', down: true, repeat: true })).toBeNull();
  });

  it('resolves gamepad button indices', () => {
    const map = new InputMap(BINDINGS);
    expect(map.resolve({ device: 'gamepad', code: '0', down: true })).toBe('togglePause');
  });

  it('mouse is not mapped in Phase 0', () => {
    const map = new InputMap(BINDINGS);
    expect(map.resolve({ device: 'mouse', code: 'Left', down: true })).toBeNull();
  });
});

/** Test double: lets tests push raw device events like a real device would. */
class FakeSource implements InputSource {
  readonly device = 'keyboard' as const;
  private sink: InputEventSink | null = null;

  attach(sink: InputEventSink): void {
    this.sink = sink;
  }

  detach(): void {
    this.sink = null;
  }

  press(code: string, down = true): void {
    this.sink?.({ device: 'keyboard', code, down });
  }
}

describe('InputManager', () => {
  function make(): { manager: InputManager; source: FakeSource; events: EventBus } {
    const events = new EventBus();
    const source = new FakeSource();
    const manager = new InputManager(source, BINDINGS, events);
    return { manager, source, events };
  }

  it('emits actionPressed once per keydown and actionReleased on keyup', () => {
    const { manager, source, events } = make();
    const pressed: string[] = [];
    const released: string[] = [];
    events.on('input.actionPressed', ({ action }) => pressed.push(action));
    events.on('input.actionReleased', ({ action }) => released.push(action));

    source.press('KeyW');
    source.press('KeyW'); // key repeat / double press without release
    manager.update({} as never, { kind: 'frame', frame: { frameIndex: 1, dtRealSeconds: 0.016, simTicksThisFrame: 0 } });
    source.press('KeyW', false);
    manager.update({} as never, { kind: 'frame', frame: { frameIndex: 2, dtRealSeconds: 0.016, simTicksThisFrame: 0 } });

    expect(pressed).toEqual(['moveNorth']);
    expect(released).toEqual(['moveNorth']);
  });

  it('tracks held state for polling systems', () => {
    const { manager, source } = make();
    source.press('KeyW');
    source.press('KeyS');
    expect(manager.isDown('moveNorth')).toBe(true);
    expect(manager.isDown('moveSouth')).toBe(true);
    source.press('KeyW', false);
    expect(manager.isDown('moveNorth')).toBe(false);
    expect(manager.isDown('moveSouth')).toBe(true);
  });

  it('works headless with a null source', () => {
    const events = new EventBus();
    const manager = new InputManager(null, BINDINGS, events);
    expect(() =>
      manager.update({} as never, { kind: 'frame', frame: { frameIndex: 1, dtRealSeconds: 0.016, simTicksThisFrame: 0 } })
    ).not.toThrow();
    expect(manager.isDown('moveNorth')).toBe(false);
  });
});
