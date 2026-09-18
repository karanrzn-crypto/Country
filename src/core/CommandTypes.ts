import type { EntityId } from './IdGenerator';
import type { PlayerModeId } from '../player/types';

/**
 * Commands are the only way for UI / input / debug tooling to affect the
 * simulation. They are processed in the "state" phase of each frame.
 */
export type GameCommand =
  | { readonly type: 'game.togglePause' }
  | { readonly type: 'game.setPaused'; readonly paused: boolean }
  | { readonly type: 'game.setSpeed'; readonly speed: number }
  | { readonly type: 'game.setSpeedStep'; readonly index: number }
  | { readonly type: 'game.cycleSpeed' }
  | { readonly type: 'game.setTimeMode'; readonly mode: 'hour' | 'day' | 'month' | 'year' }
  | { readonly type: 'player.setMode'; readonly mode: PlayerModeId }
  | { readonly type: 'player.focusChunk'; readonly chunkId: string }
  | { readonly type: 'player.select'; readonly entityIds: readonly EntityId[] }
  // —— country selection flow (Part 3) ——
  | { readonly type: 'player.beginCountrySelection' }
  | { readonly type: 'player.confirmCountry'; readonly countryId: string }
  | { readonly type: 'ui.openScreen'; readonly screenId: string }
  | { readonly type: 'ui.closeScreen'; readonly screenId: string }
  | {
      readonly type: 'ui.notify';
      readonly level: 'info' | 'warn' | 'error';
      readonly title: string;
      readonly message: string;
    }
  | { readonly type: 'save.save'; readonly slot: string; readonly label?: string }
  | { readonly type: 'save.load'; readonly slot: string }
  | { readonly type: 'debug.command'; readonly name: string; readonly args?: Readonly<Record<string, unknown>> }
  // —— strategic map (Part 1) ——
  | {
      readonly type: 'map.select';
      readonly countryId?: string | null;
      readonly provinceId?: string | null;
      readonly cityId?: string | null;
    }
  | { readonly type: 'map.pick'; readonly x: number; readonly z: number }
  | { readonly type: 'map.hover'; readonly x: number | null; readonly z: number | null }
  | { readonly type: 'map.clearSelection' }
  | { readonly type: 'map.setLayerVisible'; readonly layer: string; readonly visible: boolean }
  | { readonly type: 'map.setSelectionMode'; readonly mode: 'country' | 'province' }
  | { readonly type: 'map.setCamera'; readonly x?: number; readonly z?: number; readonly viewHeight?: number }
  | { readonly type: 'map.panBy'; readonly dx: number; readonly dz: number }
  | {
      readonly type: 'map.zoomBy';
      readonly factor: number;
      /** Optional world point kept under the cursor while zooming. */
      readonly anchorX?: number;
      readonly anchorZ?: number;
      /** Cursor pixel (canvas space) — with the anchor enables exact cursor-centered zoom. */
      readonly screenX?: number;
      readonly screenY?: number;
    }
  | { readonly type: 'map.focusCountry'; readonly countryId: string }
  | { readonly type: 'map.setViewport'; readonly width: number; readonly height: number }
  // —— Phase 2 — presidency & governance ——
  /** The ONE 100% budget pool (spec §1): set one pool's share, the other
   *  pool absorbs the remainder (economic + military = 100% always). */
  | {
      readonly type: 'government.setBudgetShare';
      readonly countryId: string;
      readonly pool: 'economic' | 'military';
      readonly value: number;
    }
  /** The ONE tax level (spec §9): کم / متوسط / زیاد. */
  | {
      readonly type: 'government.setTaxLevel';
      readonly countryId: string;
      readonly level: 'low' | 'medium' | 'high';
    }
  | { readonly type: 'government.setMinistryFunding'; readonly countryId: string; readonly ministryId: string; readonly value: number }
  | { readonly type: 'government.enactDecision'; readonly countryId: string; readonly decisionId: string }
  | { readonly type: 'government.resolveEvent'; readonly countryId: string; readonly instanceId: string; readonly choiceId: string }
  // —— Phase 3 — the simple economy (spec §6/§8) ——
  /** ONE explicit deal: buy units of a resource from a chosen seller country. */
  | {
      readonly type: 'economy.buyResource';
      readonly countryId: string;
      readonly sellerId: string;
      readonly resourceId: string;
      readonly amount: number;
    }
  /** Start ONE building construction project (money cost paid once). */
  | { readonly type: 'economy.startConstruction'; readonly countryId: string; readonly typeId: string };
