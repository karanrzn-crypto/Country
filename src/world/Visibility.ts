import type { ChunkId, ChunkState, LODLevel } from './types';

export interface VisibilityContext {
  readonly chunkId: ChunkId;
  readonly state: ChunkState;
  readonly lod: LODLevel;
}

export interface VisibilityStrategy {
  isVisible(context: VisibilityContext): boolean;
}

/** Default strategy: only active chunks are visible in the 3D layer. */
export class DistanceVisibilityStrategy implements VisibilityStrategy {
  isVisible(context: VisibilityContext): boolean {
    return context.state === 'active';
  }
}

/**
 * Pluggable visibility/culling entry point. The default is distance-based;
 * frustum or occlusion strategies can replace it in later phases without
 * touching any manager or renderer code.
 */
export class VisibilityManager {
  private strategy: VisibilityStrategy = new DistanceVisibilityStrategy();

  setStrategy(strategy: VisibilityStrategy): void {
    this.strategy = strategy;
  }

  get currentStrategy(): VisibilityStrategy {
    return this.strategy;
  }

  isVisible(context: VisibilityContext): boolean {
    return this.strategy.isVisible(context);
  }
}
