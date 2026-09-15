import type { SystemContext } from '../../core/GameContext';
import type { TickInfo } from '../../time/TimeSystem';
import type { SimulationSystemDef } from '../SimulationEngine';
import { clamp } from '../../utils/math';

const POPULATION_CAPACITY_PER_INFRASTRUCTURE = 400_000;
const DAILY_GROWTH_RATE = 0.0004;
const ABSTRACT_UPDATE_INTERVAL_TICKS = 720; // monthly — cheap aggregate path

/**
 * Population simulation with simulation-LOD:
 * - regions containing active chunks → detailed daily growth model;
 * - far regions → abstract (monthly, aggregated) growth only.
 * This demonstrates the "distant entities simulate cheaper" pattern.
 */
export class PopulationSystem implements SimulationSystemDef {
  readonly id = 'population';

  tick(context: SystemContext, tick: TickInfo): void {
    const dailyUpdate = tick.tick % 24 === 0;
    const abstractUpdate = tick.tick % ABSTRACT_UPDATE_INTERVAL_TICKS === 0;
    if (!dailyUpdate && !abstractUpdate) return;
    const { state, world, events } = context;

    for (const region of Object.values(state.world.regions)) {
      const simLevel = world.simulationLevelForRegion(region.id);
      // Abstract regions skip daily updates entirely (cheaper far-simulation).
      if (simLevel === 'abstract' && !abstractUpdate) continue;
      if (simLevel !== 'abstract' && !dailyUpdate) continue;

      const record = state.population.regions[region.id];
      if (record === undefined) continue;
      const capacity = Math.max(1000, region.infrastructure * POPULATION_CAPACITY_PER_INFRASTRUCTURE);
      record.capacity = capacity;

      const foodFactor = this.foodAvailabilityFactor(context, region.id);
      const logisticFactor = clamp(1 - record.population / capacity, 0, 1);
      const growth = record.population * DAILY_GROWTH_RATE * foodFactor * logisticFactor;
      record.population = Math.max(1000, Math.round(record.population + growth));
      record.lastGrowth = growth;

      if (simLevel !== 'abstract') {
        events.emit('sim.populationChanged', { regionId: region.id, population: record.population });
      }
    }
  }

  private foodAvailabilityFactor(context: SystemContext, regionId: string): number {
    const countryId = context.state.world.countryOfRegion[regionId];
    if (countryId === undefined) return 0.75;
    const food = context.state.economy.stockpiles[countryId]?.food ?? 0;
    const population = context.state.population.regions[regionId]?.population ?? 0;
    const dailyFoodNeed = population / 1000;
    if (dailyFoodNeed <= 0) return 1;
    return clamp(food / 24 / dailyFoodNeed, 0.25, 1.25);
  }
}
