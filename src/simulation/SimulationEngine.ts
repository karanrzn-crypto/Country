import type { Logger } from '../utils/Logger';
import { SimulationError } from '../utils/errors';
import type { SystemContext } from '../core/GameContext';
import type { PhaseSystem, SystemUpdate } from '../core/SystemTypes';
import type { TickInfo } from '../time/TimeSystem';

/**
 * A simulation system. Systems must NOT import each other; ordering is
 * declared via `dependencies` and validated (missing dep or cycle = error).
 * `tick()` runs once per fixed simulation step — with or without a renderer.
 */
export interface SimulationSystemDef {
  readonly id: string;
  readonly dependencies?: readonly string[];
  init?(context: SystemContext): void;
  tick(context: SystemContext, tick: TickInfo): void;
  dispose?(): void;
}

/**
 * Ordered runner for simulation systems. This is what makes the whole
 * simulation renderer-independent and deterministic: same system order,
 * same seed, same state → same result, verifiable by tests.
 */
export class SimulationEngine implements PhaseSystem {
  readonly id = 'core.simulation';
  readonly phase = 'simulation' as const;

  private readonly ordered: SimulationSystemDef[];

  constructor(systems: readonly SimulationSystemDef[], private readonly logger: Logger) {
    this.ordered = topologicallySortSystems(systems);
  }

  init(context: SystemContext): void {
    for (const system of this.ordered) {
      system.init?.(context);
      this.logger.debug(`Simulation system initialized: ${system.id}`);
    }
  }

  update(context: SystemContext, update: SystemUpdate): void {
    if (update.kind !== 'tick') return;
    const { profiler } = context;
    for (const system of this.ordered) {
      profiler.mark(`sim.${system.id}`);
      try {
        system.tick(context, update.tick);
      } finally {
        profiler.endMark(`sim.${system.id}`);
      }
    }
  }

  dispose(): void {
    for (const system of [...this.ordered].reverse()) {
      system.dispose?.();
    }
  }

  get systemIds(): readonly string[] {
    return this.ordered.map((system) => system.id);
  }
}

/** Kahn's algorithm — deterministic topological order with cycle detection. */
export function topologicallySortSystems(systems: readonly SimulationSystemDef[]): SimulationSystemDef[] {
  const byId = new Map<string, SimulationSystemDef>();
  for (const system of systems) {
    if (byId.has(system.id)) {
      throw new SimulationError(`Duplicate simulation system id "${system.id}"`);
    }
    byId.set(system.id, system);
  }

  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const system of systems) {
    const deps = system.dependencies ?? [];
    indegree.set(system.id, deps.length);
    for (const dep of deps) {
      if (!byId.has(dep)) {
        throw new SimulationError(`Simulation system "${system.id}" depends on unknown system "${dep}"`);
      }
      const list = dependents.get(dep) ?? [];
      list.push(system.id);
      dependents.set(dep, list);
    }
  }

  // Stable processing order: registration order (determinism requirement).
  const queue: string[] = systems.filter((s) => (indegree.get(s.id) ?? 0) === 0).map((s) => s.id);
  const result: SimulationSystemDef[] = [];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    result.push(byId.get(id) as SimulationSystemDef);
    for (const dependent of dependents.get(id) ?? []) {
      const remaining = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) queue.push(dependent);
    }
  }

  if (result.length !== systems.length) {
    const cyclic = systems.filter((s) => !result.includes(s)).map((s) => s.id);
    throw new SimulationError(`Circular dependency between simulation systems: ${cyclic.join(', ')}`);
  }
  return result;
}
