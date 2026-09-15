import type { EventBus } from '../events/EventBus';
import type { GameState } from '../state/GameState';
import type { PlayerModeDef, PlayerModeId } from './types';

/**
 * Validates and applies player mode transitions (President ↔ Commander ↔
 * Soldier/Aircraft). The current mode lives in the player state slice —
 * this system owns the transition rules, defined by data-driven mode defs.
 */
export class PlayerModeSystem {
  private readonly modes = new Map<PlayerModeId, PlayerModeDef>();

  constructor(
    modeDefs: readonly PlayerModeDef[],
    private readonly events: EventBus
  ) {
    for (const def of modeDefs) {
      this.modes.set(def.id, def);
    }
  }

  setMode(state: GameState, requested: PlayerModeId): boolean {
    const target = this.modes.get(requested);
    if (target === undefined) return false;
    const current = state.player.mode;
    if (current === requested) return true;
    if (current !== null && !this.canTransition(current, requested)) return false;
    state.player.mode = requested;
    this.events.emit('player.modeChanged', { from: current, to: requested });
    return true;
  }

  canTransition(from: PlayerModeId, to: PlayerModeId): boolean {
    const fromDef = this.modes.get(from);
    return fromDef !== undefined && fromDef.transitions.includes(to);
  }

  modeDef(id: PlayerModeId): PlayerModeDef {
    const def = this.modes.get(id);
    if (def === undefined) throw new Error(`Unknown player mode "${id}"`);
    return def;
  }

  get all(): readonly PlayerModeDef[] {
    return [...this.modes.values()];
  }
}
