/**
 * Stable, human-readable entity IDs: `<kind>-<counter>` (e.g. `unit-000042`).
 *
 * The counter state is serialized with save games so IDs remain stable across
 * save/load cycles — required for deterministic replays and stable references.
 */
export type EntityId = string;

export interface IdGeneratorState {
  readonly counters: Readonly<Record<string, number>>;
}

export class IdGenerator {
  private counters = new Map<string, number>();

  next(kind: string): EntityId {
    const nextValue = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, nextValue);
    return `${kind}-${String(nextValue).padStart(6, '0')}`;
  }

  peek(kind: string): EntityId {
    const current = this.counters.get(kind) ?? 0;
    return `${kind}-${String(current + 1).padStart(6, '0')}`;
  }

  /** Pre-register an ID loaded from external data so future IDs never collide. */
  observe(id: EntityId): void {
    const [kind, numeric] = splitId(id);
    const value = Number.parseInt(numeric, 10);
    if (Number.isNaN(value)) return;
    const current = this.counters.get(kind) ?? 0;
    if (value > current) this.counters.set(kind, value);
  }

  serialize(): IdGeneratorState {
    return { counters: Object.fromEntries(this.counters) };
  }

  restore(state: IdGeneratorState): void {
    this.counters = new Map(Object.entries(state.counters));
  }
}

export function splitId(id: EntityId): readonly [string, string] {
  const index = id.lastIndexOf('-');
  if (index <= 0) return [id, '0'];
  return [id.slice(0, index), id.slice(index + 1)];
}
