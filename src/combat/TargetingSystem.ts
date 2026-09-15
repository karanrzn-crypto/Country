import type { CombatantView, TargetingMode } from './types';
import { chebyshevDistance } from '../utils/math';

/**
 * Deterministic target selection. Ties always resolve by entity id so the
 * same battlefield state always yields the same target (replay safety).
 */
export function pickTarget(
  shooter: CombatantView,
  candidates: readonly CombatantView[],
  mode: TargetingMode
): CombatantView | null {
  let best: CombatantView | null = null;
  let bestDistance = 0;
  let bestScore = 0;

  for (const candidate of candidates) {
    if (candidate.factionId === shooter.factionId) continue;
    if (candidate.healthRatio <= 0) continue;
    const distance = chebyshevDistance(shooter.gx, shooter.gz, candidate.gx, candidate.gz);
    const score =
      mode === 'nearest'
        ? -distance
        : mode === 'weakest'
          ? -(candidate.power * candidate.healthRatio)
          : candidate.power * candidate.healthRatio;

    if (best === null) {
      best = candidate;
      bestDistance = distance;
      bestScore = score;
      continue;
    }
    if (score > bestScore) {
      best = candidate;
      bestDistance = distance;
      bestScore = score;
    } else if (score === bestScore && candidate.entityId < best.entityId) {
      best = candidate;
      bestDistance = distance;
    }
  }

  void bestDistance;
  return best;
}
