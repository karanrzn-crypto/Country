import type { UIElement, UIDomAdapter } from './adapter/UIDomAdapter';
import type { EventBus } from '../events/EventBus';

export type ScreenBuilder = (container: UIElement) => void;

/**
 * Screen stack (menus, map, dialogs layer). Screens are built by registered
 * builder functions through the DOM adapter; the manager only handles the
 * stack discipline: open → push, close → pop, duplicate open → refocus.
 * UI observes state; it never owns simulation data (spec 0.9).
 */
export class ScreenManager {
  private readonly stack: string[] = [];
  private readonly containers = new Map<string, UIElement>();
  private readonly builders = new Map<string, ScreenBuilder>();

  constructor(
    private readonly adapter: UIDomAdapter,
    private readonly events: EventBus
  ) {}

  registerScreen(screenId: string, builder: ScreenBuilder): void {
    this.builders.set(screenId, builder);
  }

  open(screenId: string): void {
    const builder = this.builders.get(screenId);
    if (builder === undefined) {
      throw new Error(`Unknown screen "${screenId}"`);
    }
    if (this.isOpen(screenId)) {
      this.moveToTop(screenId);
      return;
    }
    const layer = this.adapter.create('div', 'screen-layer');
    const container = this.adapter.create('div', 'screen');
    layer.appendChild(container);
    this.adapter.root().appendChild(layer);
    builder(container);
    this.containers.set(screenId, layer);
    this.stack.push(screenId);
    this.events.emit('ui.screenChanged', { opened: screenId, closed: null });
  }

  close(screenId: string): void {
    const index = this.stack.indexOf(screenId);
    if (index === -1) return;
    this.stack.splice(index, 1);
    this.containers.get(screenId)?.remove();
    this.containers.delete(screenId);
    this.events.emit('ui.screenChanged', { opened: null, closed: screenId });
  }

  closeTop(): string | null {
    const top = this.stack[this.stack.length - 1];
    if (top === undefined) return null;
    this.close(top);
    return top;
  }

  isOpen(screenId: string): boolean {
    return this.stack.includes(screenId);
  }

  get current(): string | null {
    return this.stack[this.stack.length - 1] ?? null;
  }

  get depth(): number {
    return this.stack.length;
  }

  private moveToTop(screenId: string): void {
    const index = this.stack.indexOf(screenId);
    if (index >= 0 && index !== this.stack.length - 1) {
      this.stack.splice(index, 1);
      this.stack.push(screenId);
    }
  }
}
