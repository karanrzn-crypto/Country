import type { GameState } from '../state/GameState';
import { regionsOfCountry } from '../state/slices/worldSlice';
import { totalPopulation } from '../state/slices/populationSlice';

export interface HudModel {
  readonly mode: string;
  readonly treasury: string;
  readonly population: string;
  readonly chunks: string;
}

/** Pure speed-label formatting — '×1', '×2', '×5', '×10'. */
export function formatSpeedLabel(speed: number): string {
  return `×${speed}`;
}

/** Pure HUD state → strings mapping (unit-testable without DOM). */
export function buildHudModel(
  state: GameState,
  modeName: string,
  chunkCounts: { active: number; simulated: number; unloaded: number }
): HudModel {
  const regions = regionsOfCountry(state.world, state.player.countryId).map((region) => region.id);
  let treasury = 0;
  const playerTreasury = state.economy.treasury[state.player.countryId];
  if (playerTreasury !== undefined) treasury = playerTreasury;
  let population = 0;
  for (const regionId of regions) {
    population += state.population.regions[regionId]?.population ?? 0;
  }
  void totalPopulation;

  return {
    mode: modeName ?? '—',
    treasury: Math.round(treasury).toLocaleString('en-US'),
    population: Math.round(population).toLocaleString('en-US'),
    chunks: `A:${chunkCounts.active} S:${chunkCounts.simulated} U:${chunkCounts.unloaded}`
  };
}
