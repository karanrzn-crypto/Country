/**
 * Central, typed registry of every event the game can emit.
 *
 * Systems communicate through this contract — never through direct references
 * to each other (loose coupling rule). This file must stay a leaf module:
 * it may import types only, so adding an event never introduces a dependency edge.
 */

import type { EntityId } from '../core/IdGenerator';
import type { LODLevel } from '../world/types';
import type { WeatherType } from '../world/types';
import type { PlayerModeId } from '../player/types';

export interface TickInfoPayload {
  readonly tick: number;
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

export interface CalendarChangePayload {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

export interface GameEventMap {
  // —— core / lifecycle ——
  'game.ready': { readonly tick: number };
  'game.paused': Record<string, never>;
  'game.resumed': Record<string, never>;
  'game.speedChanged': { readonly speed: number; readonly stepIndex: number };
  'game.error': { readonly code: string; readonly message: string };

  // —— time ——
  'time.tick': TickInfoPayload;
  'time.dayChanged': CalendarChangePayload;
  'time.monthChanged': CalendarChangePayload;
  'time.yearChanged': CalendarChangePayload;

  // —— world / streaming ——
  'world.chunkActivated': { readonly chunkId: string; readonly regionId: string; readonly lod: LODLevel };
  'world.chunkDeactivated': { readonly chunkId: string; readonly regionId: string };
  'world.chunkLodChanged': { readonly chunkId: string; readonly lod: LODLevel };
  'world.focusChanged': { readonly chunkId: string; readonly regionId: string };

  // —— simulation ——
  'sim.weatherChanged': { readonly regionId: string; readonly weather: WeatherType };
  'sim.economyTreasuryChanged': { readonly factionId: string; readonly value: number; readonly delta: number };
  'sim.economyProduced': { readonly factoryId: string; readonly outputId: string; readonly amount: number };
  'sim.populationChanged': { readonly regionId: string; readonly population: number };
  'sim.supplyLow': { readonly regionId: string; readonly supply: number };

  // —— military / combat ——
  'military.unitSpawned': {
    readonly unitId: EntityId;
    readonly typeId: string;
    readonly factionId: string;
    readonly regionId: string;
  };
  'combat.projectileFired': { readonly projectileId: EntityId; readonly shooterId: EntityId; readonly targetId: EntityId };
  'combat.entityDamaged': {
    readonly targetId: EntityId;
    readonly sourceId: EntityId | null;
    readonly amount: number;
    readonly remaining: number;
  };
  'combat.entityDestroyed': { readonly entityId: EntityId; readonly sourceId: EntityId | null };
  'combat.entityRespawned': { readonly entityId: EntityId };
  'combat.engagementStarted': {
    readonly engagementId: EntityId;
    readonly attackerFactionId: string;
    readonly defenderFactionId: string;
    readonly regionId: string;
  };

  // —— ai ——
  'ai.strategySelected': { readonly agentId: EntityId; readonly factionId: string; readonly strategyId: string; readonly score: number };
  'ai.orderIssued': { readonly orderId: EntityId; readonly factionId: string; readonly action: string; readonly priority: number };
  'ai.goalCompleted': { readonly agentId: EntityId; readonly goalId: EntityId };

  // —— player ——
  'player.modeChanged': { readonly from: PlayerModeId | null; readonly to: PlayerModeId };
  'player.selectionChanged': { readonly entityIds: readonly EntityId[] };
  'player.focusChunkChanged': { readonly chunkId: string };
  /** Part 3 — country-selection flow (UI opens the countrySelect screen). */
  'player.countrySelectionStarted': Record<string, never>;
  /** Part 3 — the player's country is now registered in state.player. */
  'player.countryConfirmed': { readonly countryId: string };

  // —— strategic map (Part 1) ——
  'map.generated': {
    readonly seed: number;
    readonly continentName: string;
    readonly countryCount: number;
    readonly provinceCount: number;
    readonly cityCount: number;
    readonly warnings: readonly string[];
  };
  'map.selectionChanged': {
    readonly countryId: string | null;
    readonly provinceId: string | null;
    readonly cityId: string | null;
  };
  'map.layerVisibilityChanged': { readonly layer: string; readonly visible: boolean };
  'map.cameraChanged': { readonly x: number; readonly z: number; readonly viewHeight: number };
  /**
   * Presentation-side camera gesture channel (Part 2 camera rework).
   * A non-null anchor begins/replaces a cursor-anchored zoom; null cancels
   * the active gesture (explicit pan / focus / viewport changes).
   */
  'map.zoomGesture': {
    readonly anchor:
      | { readonly x: number; readonly z: number; readonly screenX: number; readonly screenY: number }
      | null;
  };

  // —— ui ——
  'ui.notification': { readonly level: 'info' | 'warn' | 'error'; readonly title: string; readonly message: string };
  'ui.screenChanged': { readonly opened: string | null; readonly closed: string | null };

  // —— assets ——
  'assets.assetLoaded': { readonly assetId: string; readonly kind: string; readonly durationMs: number };
  'assets.assetError': { readonly assetId: string; readonly message: string };
  'assets.groupProgress': { readonly groupId: string; readonly loaded: number; readonly total: number };

  // —— performance / debug ——
  'perf.qualityTierChanged': { readonly tier: 'low' | 'medium' | 'high'; readonly fps: number };
  'debug.commandExecuted': { readonly name: string; readonly args: Readonly<Record<string, unknown>> };

  // —— input ——
  'input.actionPressed': { readonly action: string; readonly device: 'keyboard' | 'mouse' | 'gamepad' };
  'input.actionReleased': { readonly action: string; readonly device: 'keyboard' | 'mouse' | 'gamepad' };

  // —— save ——
  'save.saved': { readonly slot: string; readonly tick: number };
  'save.loaded': { readonly slot: string; readonly tick: number; readonly version: number };
}

export type GameEventName = keyof GameEventMap;
