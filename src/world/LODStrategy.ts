import type { LODLevel } from '../world/types';
import type { ChunkState } from '../world/types';
import type { SimulationLevel } from '../simulation/SimulationLevel';

/**
 * LOD strategy — pure functions mapping distance/streaming state to detail.
 * Kept data-independent so Phase 1+ can swap in richer strategies without
 * touching managers.
 */

/** Rendering detail for a chunk at the given chunk-grid distance from focus. */
export function computeLodForDistance(distanceChunks: number): LODLevel {
  if (distanceChunks <= 1) return 0;
  if (distanceChunks <= 3) return 1;
  return 2;
}

/** Simulation detail for a chunk based on its streaming state. */
export function simulationLevelForChunkState(state: ChunkState): SimulationLevel {
  switch (state) {
    case 'active':
      return 'detailed';
    case 'simulated':
      return 'light';
    default:
      return 'abstract';
  }
}
