import type { EntityBase, EntityKind } from './Entity';
import type { EntityId } from '../core/IdGenerator';
import { StateError } from '../utils/errors';

/**
 * Generic ID-keyed entity registry with iteration in insertion order
 * (deterministic). Used for runtime-only entities (AI agents, projectiles,
 * orders); persisted game records live directly in state slices so saves
 * stay plain JSON.
 */
export class EntityRegistry<T extends EntityBase> {
  private readonly items = new Map<EntityId, T>();

  add(item: T): void {
    if (this.items.has(item.id)) {
      throw new StateError(`Entity "${item.id}" already registered`);
    }
    this.items.set(item.id, item);
  }

  get(id: EntityId): T | undefined {
    return this.items.get(id);
  }

  require(id: EntityId): T {
    const item = this.items.get(id);
    if (item === undefined) throw new StateError(`Unknown entity "${id}"`);
    return item;
  }

  has(id: EntityId): boolean {
    return this.items.has(id);
  }

  delete(id: EntityId): boolean {
    return this.items.delete(id);
  }

  values(): IterableIterator<T> {
    return this.items.values();
  }

  ids(): IterableIterator<EntityId> {
    return this.items.keys();
  }

  get size(): number {
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
  }
}

export function entityKindLabel(kind: EntityKind): string {
  return kind;
}
