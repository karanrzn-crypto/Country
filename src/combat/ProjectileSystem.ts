import { EntityRegistry } from '../entities/EntityRegistry';
import { ObjectPool } from '../perf/ObjectPool';
import type { EntityId } from '../core/IdGenerator';
import type { EventBus } from '../events/EventBus';
import type { DamagePayload } from './types';

export interface ProjectileRecord {
  readonly id: EntityId;
  readonly kind: 'projectile';
  readonly shooterId: EntityId;
  readonly targetId: EntityId;
  readonly payload: DamagePayload;
  /** Travel progress 0..1 (chunk-grid abstraction; 3D VFX is renderer-side). */
  progress: number;
  readonly speedPerTick: number;
}

export interface CompletedHit {
  readonly projectile: ProjectileRecord;
  readonly hit: boolean;
}

/**
 * Projectile simulation backed by an object pool — projectiles churn fast,
 * so allocation pressure matters even in Phase 0 (spec: pooling where churn
 * is real, no premature optimization elsewhere).
 */
export class ProjectileSystem {
  private readonly active = new EntityRegistry<ProjectileRecord>();
  private readonly pool: ObjectPool<ProjectileRecord>;

  constructor(
    private readonly events: EventBus,
    private readonly ids: { next(kind: string): EntityId }
  ) {
    this.pool = new ObjectPool<ProjectileRecord>(
      () => ({
        id: '',
        kind: 'projectile',
        shooterId: '',
        targetId: '',
        payload: { damage: 0, armorPen: 0, accuracy: 0 },
        progress: 0,
        speedPerTick: 0
      }),
      (projectile) => {
        projectile.progress = 0;
      }
    );
  }

  spawn(
    shooterId: EntityId,
    targetId: EntityId,
    payload: DamagePayload,
    speedPerTick: number
  ): ProjectileRecord {
    const projectile = this.pool.acquire();
    (projectile as { id: EntityId }).id = this.ids.next('projectile');
    (projectile as { shooterId: EntityId }).shooterId = shooterId;
    (projectile as { targetId: EntityId }).targetId = targetId;
    (projectile as { payload: DamagePayload }).payload = payload;
    (projectile as { speedPerTick: number }).speedPerTick = speedPerTick;
    projectile.progress = 0;
    this.active.add(projectile);
    this.events.emit('combat.projectileFired', {
      projectileId: projectile.id,
      shooterId,
      targetId
    });
    return projectile;
  }

  /** Advances all projectiles; returns those that arrived this tick. */
  tick(): CompletedHit[] {
    const completed: CompletedHit[] = [];
    for (const projectile of [...this.active.values()]) {
      projectile.progress += projectile.speedPerTick;
      if (projectile.progress >= 1) {
        completed.push({ projectile, hit: true });
        this.recycle(projectile);
      }
    }
    return completed;
  }

  recycle(projectile: ProjectileRecord): void {
    this.active.delete(projectile.id);
    this.pool.release(projectile);
  }

  /** Drops everything without touching pooled objects (used on load). */
  clear(): void {
    for (const projectile of [...this.active.values()]) {
      this.recycle(projectile);
    }
  }

  get size(): number {
    return this.active.size;
  }

  get poolStats(): { size: number; inUse: number; acquired: number; released: number } {
    return this.pool.stats;
  }
}
