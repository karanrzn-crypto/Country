import type { EntityId } from './IdGenerator';
import type { PlayerModeId } from '../player/types';

/**
 * Commands are the only way for UI / input / debug tooling to affect the
 * simulation. They are processed in the "state" phase of each frame.
 */
export type GameCommand =
  | { readonly type: 'game.togglePause' }
  | { readonly type: 'game.setSpeed'; readonly speed: number }
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
  | { readonly type: 'map.clearSelection' }
  | { readonly type: 'map.setLayerVisible'; readonly layer: string; readonly visible: boolean }
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
  | { readonly type: 'map.setViewport'; readonly width: number; readonly height: number };
