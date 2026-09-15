import type { SystemContext } from '../core/GameContext';
import type { PhaseSystem, SystemUpdate } from '../core/SystemTypes';
import type { EntityId } from '../core/IdGenerator';
import type { EventBus } from '../events/EventBus';
import type { DataRegistry } from '../data/DataRegistry';
import { HealthSystem } from './HealthSystem';
import { ProjectileSystem } from './ProjectileSystem';
import { StochasticHitResolver } from './HitDetection';
import type { HitResolver } from './HitDetection';
import { pickTarget } from './TargetingSystem';
import { computeDamage, totalArmorOf } from './DamageSystem';
import type { CombatantView } from './types';
import type { UnitRecord } from '../military/types';
import type { EquipmentDef } from '../military/types';

interface EngagementRecord {
  readonly engagementId: EntityId;
  readonly attackerFactionId: string;
  readonly defenderFactionId: string;
  lastActiveTick: number;
}

/**
 * Combat phase orchestrator (per fixed tick, rendering-independent).
 *
 * Flow: respawn processing → view building (active units only) → engagement
 * detection (hostile units sharing a region) → targeting → projectile flight
 * → armor-aware damage → death/respawn bookkeeping. All state lives in the
 * game state slices; this class holds only runtime caches, rebuilt from
 * state on init and after every save-load.
 */
export class CombatSystem implements PhaseSystem {
  readonly id = 'core.combat';
  readonly phase = 'combat' as const;

  private readonly healths: HealthSystem;
  private readonly projectiles: ProjectileSystem;
  private readonly hitResolver: HitResolver = new StochasticHitResolver();
  private readonly cooldowns = new Map<EntityId, number>();
  private readonly engagements = new Map<string, EngagementRecord>();
  private enabled = true;
  private context: SystemContext | null = null;
  private readonly unsubscribes: (() => void)[] = [];

  constructor(
    private readonly events: EventBus,
    private readonly ids: { next(kind: string): EntityId }
  ) {
    this.healths = new HealthSystem(events);
    this.projectiles = new ProjectileSystem(events, this.ids);
  }

  init(context: SystemContext): void {
    this.context = context;
    this.rebuildFromState(context);
    // Combat runtime must be rebuilt when a save is loaded into this game.
    this.unsubscribes.push(
      this.events.on('save.loaded', () => {
        if (this.context !== null) this.rebuildFromState(this.context);
      }),
      // Freshly spawned units (debug, future recruitment) get health tracking.
      this.events.on('military.unitSpawned', ({ unitId }) => {
        if (this.context === null) return;
        const unit = this.context.state.military.units[unitId];
        if (unit !== undefined && !this.healths.hasRecord(unitId)) {
          this.healths.register(unitId, this.maxHealthOf(unit));
        }
      })
    );
  }

  /** Rebuilds runtime caches from the persisted state slices. */
  rebuildFromState(context: SystemContext): void {
    this.healths.reset();
    this.projectiles.clear();
    this.cooldowns.clear();
    this.engagements.clear();
    for (const unit of Object.values(context.state.military.units)) {
      if (unit.operationalState === 'destroyed') continue;
      this.healths.register(unit.id, this.maxHealthOf(unit));
    }
  }

  update(context: SystemContext, update: SystemUpdate): void {
    if (update.kind !== 'tick' || !this.enabled) return;
    if (!context.config.combat.enabled) return;
    const tickNumber = update.tick.tick;

    // —— respawns ——
    for (const entityId of this.healths.processRespawns(tickNumber)) {
      const unit = context.state.military.units[entityId];
      if (unit !== undefined) {
        unit.operationalState = 'idle';
        this.events.emit('combat.entityRespawned', { entityId });
      }
    }

    // —— views & engagement detection ——
    const views = this.buildViews(context);
    const byRegion = new Map<string, CombatantView[]>();
    for (const view of views) {
      const list = byRegion.get(view.regionId) ?? [];
      list.push(view);
      byRegion.set(view.regionId, list);
    }

    for (const [regionId, locals] of byRegion) {
      const hostilePair = this.findHostilePair(context, locals);
      if (hostilePair !== null) {
        this.ensureEngagement(regionId, hostilePair[0], hostilePair[1], tickNumber);
        this.resolveRegionCombat(context, regionId, locals, tickNumber);
      }
    }

    // —— projectiles in flight ——
    const completed = this.projectiles.tick();
    for (const { projectile } of completed) {
      const shooter = views.find((view) => view.entityId === projectile.shooterId);
      const target = views.find((view) => view.entityId === projectile.targetId);
      if (shooter === undefined || target === undefined) continue; // target left/destroyed
      if (!this.hitResolver.resolve(shooter, target, projectile.payload.accuracy, context.rng)) {
        continue;
      }
      const unit = context.state.military.units[target.entityId];
      if (unit === undefined) continue;
      const armor = totalArmorOf(unit.equipment, (id) => this.equipment(context.data, id));
      const damage = computeDamage(projectile.payload.damage, projectile.payload.armorPen, armor);
      const killed = this.healths.applyDamage(target.entityId, damage, shooter.entityId, tickNumber);
      if (killed) this.handleDestroyed(context, target.entityId, tickNumber);
    }

    // —— engagement bookkeeping ——
    for (const [regionId, engagement] of this.engagements) {
      if (tickNumber - engagement.lastActiveTick > 48) {
        this.engagements.delete(regionId);
      }
    }
  }

  // —— internals ——

  private resolveRegionCombat(
    context: SystemContext,
    regionId: string,
    locals: readonly CombatantView[],
    tickNumber: number
  ): void {
    const { state, config } = context;
    for (const shooter of locals) {
      if (!this.healths.isAlive(shooter.entityId)) continue;
      if (state.military.units[shooter.entityId]?.operationalState === 'destroyed') continue;
      const readyTick = this.cooldowns.get(shooter.entityId) ?? 0;
      if (tickNumber < readyTick) continue;

      const targets = locals.filter((view) => view.factionId !== shooter.factionId);
      const target = pickTarget(shooter, targets, 'nearest');
      if (target === null) continue;

      const weapon = this.primaryWeapon(context, state.military.units[shooter.entityId]);
      if (weapon === null) continue;
      if (weapon.range < config.combat.maxEngagementRangeChunks) continue;

      this.projectiles.spawn(shooter.entityId, target.entityId, {
        damage: weapon.damage,
        armorPen: weapon.armorPen,
        accuracy: weapon.accuracy * config.combat.baseAccuracy
      }, config.combat.projectileSpeedChunksPerTick);

      this.cooldowns.set(shooter.entityId, tickNumber + Math.max(1, weapon.cooldownTicks));
      void regionId;
    }
  }

  private handleDestroyed(context: SystemContext, entityId: EntityId, tickNumber: number): void {
    const unit = context.state.military.units[entityId];
    if (unit !== undefined) {
      unit.operationalState = 'destroyed';
      if (context.config.combat.respawnDelayTicks > 0) {
        this.healths.scheduleRespawn(entityId, tickNumber + context.config.combat.respawnDelayTicks);
      }
    }
  }

  private buildViews(context: SystemContext): CombatantView[] {
    const views: CombatantView[] = [];
    for (const unit of Object.values(context.state.military.units)) {
      if (unit.operationalState === 'destroyed' || unit.regionId === null) continue;
      const region = context.state.world.regions[unit.regionId];
      if (region === undefined) continue;
      views.push({
        entityId: unit.id,
        factionId: unit.countryId,
        regionId: unit.regionId,
        gx: region.gridX,
        gz: region.gridZ,
        healthRatio: this.healths.hasRecord(unit.id) ? this.healths.healthRatio(unit.id) : 1,
        power: this.unitPower(context, unit)
      });
    }
    return views;
  }

  private findHostilePair(context: SystemContext, locals: readonly CombatantView[]): readonly [string, string] | null {
    for (const a of locals) {
      for (const b of locals) {
        if (a.factionId === b.factionId) continue;
        if (areHostileFactions(context, a.factionId, b.factionId)) {
          return [a.factionId, b.factionId] as const;
        }
      }
    }
    return null;
  }

  private ensureEngagement(
    regionId: string,
    attackerFactionId: string,
    defenderFactionId: string,
    tickNumber: number
  ): void {
    const existing = this.engagements.get(regionId);
    if (existing !== undefined) {
      existing.lastActiveTick = tickNumber;
      return;
    }
    const engagement: EngagementRecord = {
      engagementId: this.ids.next('engagement'),
      attackerFactionId,
      defenderFactionId,
      lastActiveTick: tickNumber
    };
    this.engagements.set(regionId, engagement);
    this.events.emit('combat.engagementStarted', {
      engagementId: engagement.engagementId,
      attackerFactionId,
      defenderFactionId,
      regionId
    });
  }

  private maxHealthOf(unit: UnitRecord): number {
    return Math.max(10, unit.soldiersMax * 10);
  }

  private unitPower(context: SystemContext, unit: UnitRecord): number {
    let power = 0;
    for (const [equipmentId, count] of Object.entries(unit.equipment)) {
      const def = this.equipment(context.data, equipmentId);
      power += (def.damage / 10 + def.armor / 20) * count;
    }
    return Math.max(1, power);
  }

  private primaryWeapon(context: SystemContext, unit: UnitRecord | undefined): EquipmentDef | null {
    if (unit === undefined) return null;
    let best: EquipmentDef | null = null;
    for (const equipmentId of Object.keys(unit.equipment)) {
      const def = this.equipment(context.data, equipmentId);
      if (def.damage <= 0) continue;
      if (best === null || def.damage > best.damage || (def.damage === best.damage && def.id < best.id)) {
        best = def;
      }
    }
    return best;
  }

  private equipment(data: DataRegistry, id: string): EquipmentDef {
    try {
      return data.equipment(id);
    } catch {
      // Data drift protection: missing equipment acts as a blank entry.
      return {
        id,
        name: id,
        category: 'support',
        domain: 'ground',
        cost: 0,
        upkeepPerDay: 0,
        damage: 0,
        armorPen: 0,
        range: 0,
        accuracy: 0,
        cooldownTicks: 0,
        armor: 0,
        speedKmh: 0
      };
    }
  }

  // —— external surface ——

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  getStats(): Record<string, string | number> {
    return {
      tracked: this.healths.trackedCount,
      projectiles: this.projectiles.size,
      engagements: this.engagements.size
    };
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes.length = 0;
    this.healths.reset();
    this.projectiles.clear();
    this.cooldowns.clear();
    this.engagements.clear();
    this.context = null;
  }
}

function areHostileFactions(context: SystemContext, a: string, b: string): boolean {
  const relations = context.state.diplomacy.relations;
  const value = relations[a]?.[b] ?? 0;
  return a !== b && value <= -20;
}
