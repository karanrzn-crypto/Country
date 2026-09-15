/**
 * Minimal DOM abstraction for the UI layer. UI logic (screens, HUD,
 * notifications, dialogs) is written against this interface and is therefore
 * unit-testable without a real browser; the browser implementation is the
 * only place that touches `document`.
 */

export type Unsubscribe = () => void;

export interface UIElement {
  setText(text: string): void;
  setClass(className: string): void;
  setVisible(visible: boolean): void;
  appendChild(child: UIElement): void;
  remove(): void;
  onClick(handler: () => void): Unsubscribe;
}

export interface UIDomAdapter {
  create(tag: string, className?: string): UIElement;
  root(): UIElement;
}
