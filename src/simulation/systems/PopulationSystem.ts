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

  tick(context: SystemContext, _tick: TickInfo): void {
    // Cadences count SIM STEPS (save-restored), not clock minutes.
    const dailyUpdate = context.time.step % 24 === 0;
    const abstractUpdate = context.time.step % ABSTRACT_UPDATE_INTERVAL_TICKS === 0;
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
    const state = context.state;
    const countryId = state.world.countryOfRegion[regionId];
    if (countryId === undefined) return 0.75;
    const population = state.population.regions[regionId]?.population ?? 0;
    const dailyFoodNeed = population / 1000;
    if (dailyFoodNeed <= 0) return 1;

    // Strategic countries: food availability reads the REAL stockpile — a
    // healthy buffer keeps growth at full speed, an empty one slows it
    // (famine protection: growth stalls, it does not collapse, spec §8).
    const record = state.economy.resources[countryId];
    if (record !== undefined) {
      const monthlyNeed = Math.max(1, record.consumption.food ?? 0);
      return clamp((record.stock.food ?? 0) / (monthlyNeed * 2), 0.3, 1.1);
    }

    // Legacy demo world: the old stockpile record.
    const food = state.economy.stockpiles[countryId]?.food ?? 0;
    return clamp(food / 24 / dailyFoodNeed, 0.25, 1.25);
  }
}
