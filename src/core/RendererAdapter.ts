import type { GameState } from '../state/GameState';
import type { SystemContext } from './GameContext';

export interface RenderFrame {
  readonly state: GameState;
  readonly frameIndex: number;
  readonly dtSeconds: number;
}

export interface RendererStats {
  readonly drawCalls: number;
  readonly triangles: number;
  readonly meshes: number;
}

/**
 * Contract between the renderer-agnostic core and any visualization backend
 * (Three.js today, alternative backends later).
 *
 * The core NEVER imports Three.js. The renderer is a disposable view of the
 * game state — never its owner, never its source of truth (Architecture Rule 1).
 */
export interface IGameRenderer {
  init(context: SystemContext): void;
  render(frame: RenderFrame): void;
  resize(width: number, height: number): void;
  getStats(): RendererStats;
  dispose(): void;
}
