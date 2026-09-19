import type { UIElement } from './adapter/UIDomAdapter';

export type NotificationLevel = 'info' | 'warn' | 'error';

/** ONE action button of a notification (e.g. موافقت / مخالفت on an export
 *  request). The callback fires when the button is clicked; the caller
 *  decides whether the notification is removed afterwards. */
export interface NotificationAction {
  readonly label: string;
  readonly onClick: () => void;
}

export interface NotificationOptions {
  /** Action buttons rendered under the message (none by default). */
  readonly actions?: readonly NotificationAction[];
}

interface NotificationRecord {
  readonly id: number;
  readonly level: NotificationLevel;
  readonly title: string;
  readonly message: string;
  readonly expiresAtFrame: number;
  readonly element: UIElement;
}

/**
 * Timed notification feed (top-right). Every notification carries its own
 * ضربدر (X) close button — the president removes it the moment it is read,
 * so nothing clutters the screen permanently (the notifications directive
 * §7) — and optional action buttons (موافقت / مخالفت on export requests).
 * Elements are created through the DOM adapter; the TTL is frame-based so
 * it survives headless testing (auto-dismiss + manual close coexist).
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

  push(
    level: NotificationLevel,
    title: string,
    message: string,
    currentFrame: number,
    options: NotificationOptions = {}
  ): void {
    const element = this.createElement('div', `notification ${level}`);
    // — the header row: title + the ضربدر (X) close button —
    const header = this.createElement('div', 'nt-header');
    const titleElement = this.createElement('div', 'nt-title');
    titleElement.setText(title);
    header.appendChild(titleElement);
    const closeButton = this.createElement('button', 'nt-close');
    closeButton.setText('×');
    closeButton.setAttribute('title', 'بستن اعلان');
    header.appendChild(closeButton);
    element.appendChild(header);
    const messageElement = this.createElement('div', 'nt-message');
    messageElement.setText(message);
    element.appendChild(messageElement);
    const record: NotificationRecord = {
      id: this.nextId++,
      level,
      title,
      message,
      expiresAtFrame: currentFrame + this.ttlFrames,
      element
    };
    // The X closes THIS notification instantly (the manual half of §7).
    closeButton.onClick(() => this.remove(record));
    // — optional action buttons (the export request's موافقت / مخالفت) —
    if (options.actions !== undefined && options.actions.length > 0) {
      const actionsRow = this.createElement('div', 'nt-actions');
      for (const action of options.actions) {
        const button = this.createElement('button', 'nt-action');
        button.setText(action.label);
        button.onClick(() => {
          action.onClick();
          this.remove(record);
        });
        actionsRow.appendChild(button);
      }
      element.appendChild(actionsRow);
    }
    this.container.appendChild(element);
    this.items.push(record);
    this.trimOverflow();
  }

  update(currentFrame: number): void {
    for (let index = this.items.length - 1; index >= 0; index--) {
      const item = this.items[index];
      if (currentFrame >= item.expiresAtFrame) {
        this.remove(item);
      }
    }
  }

  /** Removes ONE notification: element out of the DOM, record out of the
   *  feed (idempotent — a double close is a no-op). */
  private remove(record: NotificationRecord): void {
    const index = this.items.indexOf(record);
    if (index >= 0) this.items.splice(index, 1);
    record.element.remove();
  }

  private trimOverflow(): void {
    while (this.items.length > this.maxVisible) {
      const oldest = this.items.shift();
      oldest?.element.remove();
    }
  }

  get size(): number {
    return this.items.length;
  }
}
