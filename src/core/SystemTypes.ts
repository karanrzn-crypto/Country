import type { TickInfo } from '../time/TimeSystem';

/**
 * Ordered phases of the game loop (spec):
 * Input → State → Simulation → AI → Combat → Rendering.
 *
 * Frame phases ('input' | 'state' | 'render') run once per rendered frame.
 * Tick phases ('simulation' | 'ai' | 'combat') run once per fixed sim tick,
 * in that order, so AI and combat always see the freshest simulated state.
 */
export type FramePhase = 'input' | 'state' | 'render';
export type TickPhase = 'simulation' | 'ai' | 'combat';
export type GamePhase = FramePhase | TickPhase;

export interface FrameInfo {
  frameIndex: number;
  dtRealSeconds: number;
  simTicksThisFrame: number;
}

export type SystemUpdate = { kind: 'frame'; frame: FrameInfo } | { kind: 'tick'; tick: TickInfo };

/**
 * A gameplay system. Systems receive the shared SystemContext (defined in
 * GameContext.ts) and never import each other — cross-system communication
 * goes through events.
 */
export interface PhaseSystem {
  readonly id: string;
  readonly phase: GamePhase;
  init?(context: import('./GameContext').SystemContext): void;
  update(context: import('./GameContext').SystemContext, update: SystemUpdate): void;
  dispose?(): void;
}
