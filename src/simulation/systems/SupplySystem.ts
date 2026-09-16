import type { SystemContext } from '../../core/GameContext';
import type { TickInfo } from '../../time/TimeSystem';
import type { SimulationSystemDef } from '../SimulationEngine';
import { clamp } from '../../utils/math';

const SUPPLY_INTERVAL_TICKS = 6;
const MAX_SUPPLY_REACH = 3; // BFS depth from the capital region

/**
 * Supply foundation: computes a per-region supply satisfaction ratio by
 * flooding outward from each country's capital through region borders,
 * attenuated by distance, infrastructure and weather. Combat and AI metrics
 * consume these ratios. Deeper logistics (depots, convoys) come later.
 */
export class SupplySystem implements SimulationSystemDef {
  readonly id = 'supply';

  tick(context: SystemContext, _tick: TickInfo): void {
    // Cadence counts SIM STEPS (save-restored), not clock minutes.
    if (context.time.step % SUPPLY_INTERVAL_TICKS !== 0) return;
    const { state, events } = context;

    for (const countryId of Object.keys(state.world.countries)) {
      const ownedRegions = Object.values(state.world.regions).filter(
        (region) => state.world.countryOfRegion[region.id] === countryId
      );
      if (ownedRegions.length === 0) continue;

      const capital = ownedRegions.find((region) => region.capitalCityId !== null) ?? ownedRegions[0];

      // BFS flood from the capital.
      const visited = new Set<string>([capital.id]);
      let frontier: string[] = [capital.id];
      let depth = 0;
      while (frontier.length > 0 && depth <= MAX_SUPPLY_REACH) {
        const nextFrontier: string[] = [];
        for (const regionId of frontier) {
          const region = state.world.regions[regionId];
          if (region === undefined) continue;
          const weather = state.environment.weather[regionId] ?? 'clear';
          const weatherFactor = weather === 'storm' ? 0.6 : weather === 'rain' ? 0.8 : 1;
          const decay = Math.pow(0.75, depth);
          const ratio = clamp((region.infrastructure / 5) * decay * weatherFactor, 0, 1);
          state.economy.supply[regionId] = ratio;
          if (ratio < 0.3) {
            events.emit('sim.supplyLow', { regionId, supply: ratio });
          }
          for (const neighborId of region.neighbors) {
            if (!visited.has(neighborId) && state.world.countryOfRegion[neighborId] === countryId) {
              visited.add(neighborId);
              nextFrontier.push(neighborId);
            }
          }
        }
        frontier = nextFrontier;
        depth += 1;
      }

      // Regions unreachable from the capital get a minimal supply level.
      for (const region of ownedRegions) {
        if (!visited.has(region.id)) {
          state.economy.supply[region.id] = 0.1;
        }
      }
    }
  }
}
