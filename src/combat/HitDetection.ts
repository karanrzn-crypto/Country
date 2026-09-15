import type { Random } from '../utils/Random';
import type { CombatantView } from './types';
import { clamp } from '../utils/math';

/**
 * Hit resolution abstraction. The default resolver is stochastic (accuracy
 * roll); a 3D raycast resolver can implement the same interface later for
 * direct-control combat without touching CombatSystem.
 */
export interface HitResolver {
  resolve(shooter: CombatantView, target: CombatantView, accuracy: number, rng: Random): boolean;
}

export class StochasticHitResolver implements HitResolver {
  resolve(_shooter: CombatantView, _target: CombatantView, accuracy: number, rng: Random): boolean {
    return rng.chance(clamp(accuracy, 0.05, 0.95));
  }
}
