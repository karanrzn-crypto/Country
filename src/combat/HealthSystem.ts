import type { EventBus } from '../events/EventBus';
import type { EntityId } from '../core/IdGenerator';
import type { HealthRecord } from './types';

/**
 * Health/Death/Respawn bookkeeping for every damageable entity.
 * Emits combat events; never touches meshes. Runtime-only (rebuilt from
 * persisted unit state on init/load).
 */
export class HealthSystem {
  private readonly healths = new Map<EntityId, HealthRecord>();
  private readonly respawnQueue: { entityId: EntityId; readyTick: number }[] = [];

  constructor(private readonly events: EventBus) {}

  register(entityId: EntityId, maxHealth: number): void {
    if (this.healths.has(entityId)) return;
    this.healths.set(entityId, { entityId, current: maxHealth, max: maxHealth, destroyed: false });
  }

  unregister(entityId: EntityId): void {
    this.healths.delete(entityId);
  }

  isAlive(entityId: EntityId): boolean {
    const record = this.healths.get(entityId);
    return record !== undefined && !record.destroyed && record.current > 0;
  }

  hasRecord(entityId: EntityId): boolean {
    return this.healths.has(entityId);
  }

  healthRatio(entityId: EntityId): number {
    const record = this.healths.get(entityId);
    if (record === undefined || record.max <= 0) return 1;
    return Math.max(0, record.current / record.max);
  }

  /** Applies damage; returns true when this hit destroyed the entity. */
  applyDamage(entityId: EntityId, amount: number, sourceId: EntityId | null, tick: number): boolean {
    const record = this.healths.get(entityId);
    if (record === undefined || record.destroyed || amount <= 0) return false;
    record.current = Math.max(0, record.current - amount);
    this.events.emit('combat.entityDamaged', {
      targetId: entityId,
      sourceId,
      amount,
      remaining: record.current
    });
    if (record.current <= 0) {
      record.destroyed = true;
      this.events.emit('combat.entityDestroyed', { entityId, sourceId });
      void tick;
      return true;
    }
    return false;
  }

  heal(entityId: EntityId, amount: number): void {
    const record = this.healths.get(entityId);
    if (record === undefined || record.destroyed) return;
    record.current = Math.min(record.max, record.current + amount);
  }

  scheduleRespawn(entityId: EntityId, readyTick: number): void {
    this.respawnQueue.push({ entityId, readyTick });
  }

  /** Returns entity ids whose respawn delay elapsed this tick. */
  processRespawns(currentTick: number): EntityId[] {
    const ready: EntityId[] = [];
    for (let index = this.respawnQueue.length - 1; index >= 0; index--) {
      const entry = this.respawnQueue[index];
      if (currentTick >= entry.readyTick) {
        const record = this.healths.get(entry.entityId);
        if (record !== undefined) {
          record.destroyed = false;
          record.current = record.max;
        }
        ready.push(entry.entityId);
        this.respawnQueue.splice(index, 1);
      }
    }
    return ready;
  }

  /** Rebuilds from persisted state (used on init and save-load). */
  reset(): void {
    this.healths.clear();
    this.respawnQueue.length = 0;
  }

  get trackedCount(): number {
    return this.healths.size;
  }
}
