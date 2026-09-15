import type { GameEventMap, GameEventName } from './EventTypes';
import type { Logger } from '../utils/Logger';

export type GameEventHandler<T> = (payload: T) => void;
export type Unsubscribe = () => void;

/**
 * Typed, synchronous publish/subscribe event bus.
 *
 * - Loosely coupled: systems never reference each other, only the bus.
 * - Listener errors are isolated: one failing handler never breaks the rest.
 * - Iteration order is insertion order (deterministic within a session).
 */
export class EventBus {
  private readonly handlers = new Map<GameEventName, Set<(payload: never) => void>>();

  constructor(private readonly logger?: Logger) {}

  on<K extends GameEventName>(eventName: K, handler: GameEventHandler<GameEventMap[K]>): Unsubscribe {
    let set = this.handlers.get(eventName);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(eventName, set);
    }
    set.add(handler as (payload: never) => void);
    return () => this.off(eventName, handler);
  }

  once<K extends GameEventName>(eventName: K, handler: GameEventHandler<GameEventMap[K]>): Unsubscribe {
    const off = this.on(eventName, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  off<K extends GameEventName>(eventName: K, handler: GameEventHandler<GameEventMap[K]>): void {
    this.handlers.get(eventName)?.delete(handler as (payload: never) => void);
  }

  emit<K extends GameEventName>(eventName: K, payload: GameEventMap[K]): void {
    const set = this.handlers.get(eventName);
    if (set === undefined || set.size === 0) return;
    // Copy so handlers may subscribe/unsubscribe during dispatch safely.
    for (const handler of [...set]) {
      try {
        (handler as (p: GameEventMap[K]) => void)(payload);
      } catch (error) {
        this.logger?.error(`Event handler failed for "${eventName}"`, error);
      }
    }
  }

  listenerCount(eventName?: GameEventName): number {
    if (eventName !== undefined) return this.handlers.get(eventName)?.size ?? 0;
    let total = 0;
    for (const set of this.handlers.values()) total += set.size;
    return total;
  }

  clear(): void {
    this.handlers.clear();
  }
}
