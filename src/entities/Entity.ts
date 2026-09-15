import type { EntityId } from '../core/IdGenerator';

/** Kinds of runtime entities managed by registries. */
export type EntityKind =
  | 'unit'
  | 'formation'
  | 'character'
  | 'factory'
  | 'projectile'
  | 'agent'
  | 'order'
  | 'generic';

export interface EntityBase {
  readonly id: EntityId;
  readonly kind: EntityKind;
}
