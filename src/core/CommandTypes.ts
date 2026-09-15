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
  | { readonly type: 'debug.command'; readonly name: string; readonly args?: Readonly<Record<string, unknown>> };
