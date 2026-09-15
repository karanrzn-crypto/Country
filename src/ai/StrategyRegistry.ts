import type { AIStrategyDef } from './types';
import { AIError } from '../utils/errors';

/**
 * Registry of data-driven strategies. Strategies are defined in JSON and
 * registered here at boot — new strategies require zero code changes.
 */
export class StrategyRegistry {
  private readonly byId = new Map<string, AIStrategyDef>();

  registerAll(defs: readonly AIStrategyDef[]): void {
    for (const def of defs) {
      if (this.byId.has(def.id)) {
        throw new AIError(`Strategy "${def.id}" already registered`);
      }
      this.byId.set(def.id, def);
    }
  }

  get(id: string): AIStrategyDef {
    const def = this.byId.get(id);
    if (def === undefined) throw new AIError(`Unknown strategy "${id}"`);
    return def;
  }

  byKind(kind: 'strategic' | 'tactical'): AIStrategyDef[] {
    return [...this.byId.values()].filter((def) => def.kind === kind);
  }

  get size(): number {
    return this.byId.size;
  }
}
