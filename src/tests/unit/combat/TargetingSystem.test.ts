import { describe, it, expect } from 'vitest';
import { pickTarget } from '../../../combat/TargetingSystem';
import type { CombatantView } from '../../../combat/types';

function view(id: string, factionId: string, gx: number, gz: number, power = 10, healthRatio = 1): CombatantView {
  return { entityId: id, factionId, regionId: 'r', gx, gz, power, healthRatio };
}

describe('TargetingSystem', () => {
  const shooter = view('a-1', 'republic', 0, 0);

  it('skips friendlies and dead candidates', () => {
    const candidates = [view('f-1', 'republic', 1, 0), view('dead-1', 'neighbor', 1, 1, 10, 0)];
    expect(pickTarget(shooter, candidates, 'nearest')).toBeNull();
  });

  it('nearest mode picks the closest hostile with deterministic tie-break', () => {
    const candidates = [view('n-far', 'neighbor', 5, 5), view('n-close-b', 'neighbor', 1, 0), view('n-close-a', 'neighbor', 1, 0)];
    const target = pickTarget(shooter, candidates, 'nearest');
    expect(target?.entityId).toBe('n-close-a'); // tie → lexicographically smaller id
  });

  it('weakest mode prefers the lowest power × health', () => {
    const candidates = [view('strong', 'neighbor', 1, 0, 100), view('weak', 'neighbor', 9, 9, 1, 0.5)];
    expect(pickTarget(shooter, candidates, 'weakest')?.entityId).toBe('weak');
  });

  it('strongest mode prefers the highest power', () => {
    const candidates = [view('strong', 'neighbor', 9, 9, 100), view('weak', 'neighbor', 1, 0, 1)];
    expect(pickTarget(shooter, candidates, 'strongest')?.entityId).toBe('strong');
  });
});
