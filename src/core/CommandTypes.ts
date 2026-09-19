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
  /** ONE monthly TRADE CONTRACT (spec §6/§16): the buyer commits to
   *  `amountPerMonth` units/month from the seller at the base price,
   *  permanent until cancelled. The seller's real export capacity is
   *  checked at signing. */
  | {
      readonly type: 'economy.signContract';
      readonly countryId: string;
      readonly sellerId: string;
      readonly resourceId: string;
      readonly amountPerMonth: number;
    }
  /** Cancel ONE of the caller's trade contracts (spec §7) — the monthly
   *  delivery stops from the next execution on (spec §18). */
  | {
      readonly type: 'economy.cancelContract';
      readonly countryId: string;
      readonly contractId: string;
    }
  /** Start ONE building construction project (money cost paid once) on a
   *  specific grid cell of the caller's own country (spec §1). */
  | {
      readonly type: 'economy.startConstruction';
      readonly countryId: string;
      readonly typeId: string;
      readonly cellKey: string;
    }
  /** BUILD MODE (spec §1): activate (typeId) or cancel (null) build
   *  placement — while active, map clicks place the building. */
  | { readonly type: 'economy.buildMode'; readonly typeId: string | null }
  /** CONFIRM the build preview (spec §21): starts the construction on the
   *  previewed cell (the player saw the quality + estimated output). */
  | { readonly type: 'economy.confirmConstruction'; readonly countryId: string }
  /** The president's DECISION on ONE export request (the export-request
   *  directive §3): approve signs the monthly contract (AI buyer ← player
   *  seller), reject settles the request with nothing created. */
  | { readonly type: 'economy.approveExportRequest'; readonly requestId: string }
  | { readonly type: 'economy.rejectExportRequest'; readonly requestId: string };
