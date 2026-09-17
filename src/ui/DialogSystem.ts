import type { UIDomAdapter } from './adapter/UIDomAdapter';

interface DialogRequest {
  readonly title: string;
  readonly message: string;
  resolve: (confirmed: boolean) => void;
}

/**
 * Modal confirmation dialogs. One dialog at a time; requests queue up and
 * resolve in order. Pure logic over the DOM adapter — fully testable.
 */
export class DialogSystem {
  private readonly queue: DialogRequest[] = [];
  private active: DialogRequest | null = null;

  constructor(private readonly adapter: UIDomAdapter) {}

  confirm(title: string, message: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.queue.push({ title, message, resolve });
      this.pump();
    });
  }

  private pump(): void {
    if (this.active !== null || this.queue.length === 0) return;
    const request = this.queue.shift() as DialogRequest;
    this.active = request;

    const layer = this.adapter.create('div', 'screen-layer');
    const box = this.adapter.create('div', 'screen');
    const titleElement = this.adapter.create('h2');
    titleElement.setText(request.title);
    const messageElement = this.adapter.create('div', 'screen-subtitle');
    messageElement.setText(request.message);
    const actions = this.adapter.create('div', 'dialog-actions');
    box.appendChild(titleElement);
    box.appendChild(messageElement);
    box.appendChild(actions);
    layer.appendChild(box);
    this.adapter.root().appendChild(layer);

    const finish = (confirmed: boolean): void => {
      layer.remove();
      this.active = null;
      request.resolve(confirmed);
      this.pump();
    };

    const okButton = this.adapter.create('button');
    okButton.setText('تأیید');
    okButton.onClick(() => finish(true));
    const cancelButton = this.adapter.create('button');
    cancelButton.setText('لغو');
    cancelButton.onClick(() => finish(false));
    actions.appendChild(okButton);
    actions.appendChild(cancelButton);
  }

  get pendingCount(): number {
    return this.queue.length + (this.active !== null ? 1 : 0);
  }
}
