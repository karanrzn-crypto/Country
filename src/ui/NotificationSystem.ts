import type { UIElement } from './adapter/UIDomAdapter';

export type NotificationLevel = 'info' | 'warn' | 'error';

interface NotificationRecord {
  readonly id: number;
  readonly level: NotificationLevel;
  readonly title: string;
  readonly message: string;
  readonly expiresAtFrame: number;
  readonly element: UIElement | null;
}

/**
 * Timed notification feed (top-right). Elements are created through the DOM
 * adapter; TTL is frame-based so it survives headless testing.
 */
export class NotificationSystem {
  private readonly items: NotificationRecord[] = [];
  private nextId = 1;

  constructor(
    private readonly container: UIElement,
    private readonly createElement: (tag: string, className?: string) => UIElement,
    private readonly ttlFrames = 600,
    private readonly maxVisible = 5
  ) {}

  push(level: NotificationLevel, title: string, message: string, currentFrame: number): void {
    const element = this.createElement('div', `notification ${level}`);
    const titleElement = this.createElement('div', 'nt-title');
    titleElement.setText(title);
    const messageElement = this.createElement('div', 'nt-message');
    messageElement.setText(message);
    element.appendChild(titleElement);
    element.appendChild(messageElement);
    this.container.appendChild(element);

    this.items.push({
      id: this.nextId++,
      level,
      title,
      message,
      expiresAtFrame: currentFrame + this.ttlFrames,
      element
    });
    this.trimOverflow();
  }

  update(currentFrame: number): void {
    for (let index = this.items.length - 1; index >= 0; index--) {
      const item = this.items[index];
      if (currentFrame >= item.expiresAtFrame) {
        item.element?.remove();
        this.items.splice(index, 1);
      }
    }
  }

  private trimOverflow(): void {
    while (this.items.length > this.maxVisible) {
      const oldest = this.items.shift();
      oldest?.element?.remove();
    }
  }

  get size(): number {
    return this.items.length;
  }
}
