import type { UIElement, UIDomAdapter, Unsubscribe } from '../../ui/adapter/UIDomAdapter';

/** In-memory UIElement for DOM-free UI tests. */
export class InMemoryUIElement implements UIElement {
  text = '';
  className = '';
  visible = true;
  readonly children: InMemoryUIElement[] = [];
  parent: InMemoryUIElement | null = null;
  private readonly clickHandlers = new Set<() => void>();

  setText(text: string): void {
    this.text = text;
  }

  setClass(className: string): void {
    this.className = className;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
  }

  appendChild(child: UIElement): void {
    if (child instanceof InMemoryUIElement) {
      child.parent = this;
      this.children.push(child);
    }
  }

  remove(): void {
    if (this.parent !== null) {
      const index = this.parent.children.indexOf(this);
      if (index >= 0) this.parent.children.splice(index, 1);
      this.parent = null;
    }
  }

  onClick(handler: () => void): Unsubscribe {
    this.clickHandlers.add(handler);
    return () => this.clickHandlers.delete(handler);
  }

  /** Test helper: simulates a click. */
  click(): void {
    for (const handler of [...this.clickHandlers]) handler();
  }

  get childCount(): number {
    return this.children.length;
  }
}

/** In-memory adapter — UI logic tests run in plain node. */
export class InMemoryDomAdapter implements UIDomAdapter {
  readonly rootElement = new InMemoryUIElement();

  create(tag: string, className?: string): UIElement {
    const element = new InMemoryUIElement();
    element.className = className ?? tag;
    return element;
  }

  root(): UIElement {
    return this.rootElement;
  }
}
