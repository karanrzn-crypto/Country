import type { UIElement, UIDomAdapter, Unsubscribe } from './UIDomAdapter';

/**
 * Real-browser DOM adapter — the ONLY file in the UI layer allowed to touch
 * the DOM API directly. Instantiate it in main.ts and inject everywhere else.
 */
export class BrowserDomAdapter implements UIDomAdapter {
  private rootElement: UIElement | null = null;

  constructor(private readonly mount: HTMLElement) {}

  create(tag: string, className?: string): UIElement {
    const element = document.createElement(tag);
    if (className !== undefined) element.className = className;
    return new BrowserUIElement(element);
  }

  root(): UIElement {
    if (this.rootElement === null) {
      this.rootElement = new BrowserUIElement(this.mount);
    }
    return this.rootElement;
  }
}

class BrowserUIElement implements UIElement {
  constructor(private readonly element: HTMLElement) {}

  setText(text: string): void {
    this.element.textContent = text;
  }

  setClass(className: string): void {
    this.element.className = className;
  }

  setVisible(visible: boolean): void {
    this.element.style.display = visible ? '' : 'none';
  }

  setAttribute(name: string, value: string): void {
    this.element.setAttribute(name, value);
  }

  appendChild(child: UIElement): void {
    if (child instanceof BrowserUIElement) {
      this.element.appendChild(child.element);
    }
  }

  remove(): void {
    this.element.remove();
  }

  onClick(handler: () => void): Unsubscribe {
    this.element.addEventListener('click', handler);
    return () => this.element.removeEventListener('click', handler);
  }
}
