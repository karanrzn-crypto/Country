import type { SystemContext } from '../../core/GameContext';
import type { TickInfo } from '../../time/TimeSystem';
import type { SimulationSystemDef } from '../SimulationEngine';
import { hasStockpile, consumeStockpile, addStockpile } from '../../state/slices/economySlice';
import { regionsOfCountry } from '../../state/slices/worldSlice';
import { roundTo } from '../../utils/math';

/**
 * Economy simulation: factory production (inputs → outputs at data-driven
 * rates) and treasury income (population taxes) minus military upkeep.
 * Fully deterministic; emits events consumed by UI and AI.
 */
export class EconomySystem implements SimulationSystemDef {
  readonly id = 'economy';

  tick(context: SystemContext, tick: TickInfo): void {
    const { state, config, data, events } = context;
    const dayFraction = tick.hoursPerTick / 24;
    const economy = state.economy;

    // —— factory production ——
    for (const factory of Object.values(economy.factories)) {
      if (!factory.active) continue;
      const factoryType = data.economyData.factoryTypes.find((def) => def.id === factory.typeId);
      if (factoryType === undefined) continue;

      const cycles = factoryType.cyclesPerDay * dayFraction;
      const inputsNeeded = scaleRecord(factoryType.inputs, cycles);
      const outputsProduced = scaleRecord(factoryType.outputs, cycles);

      if (hasStockpile(economy.stockpiles, factory.ownerId, inputsNeeded)) {
        consumeStockpile(economy.stockpiles, factory.ownerId, inputsNeeded);
        for (const [resourceId, amount] of Object.entries(outputsProduced)) {
          addStockpile(economy.stockpiles, factory.ownerId, resourceId, amount);
          events.emit('sim.economyProduced', { factoryId: factory.id, outputId: resourceId, amount });
        }
        factory.lastOutputAmount = Object.values(outputsProduced).reduce((sum, value) => sum + value, 0);
      } else {
        factory.lastOutputAmount = 0;
      }
    }

    // —— treasury: taxes & upkeep ——
    for (const countryId of Object.keys(economy.treasury)) {
      const regions = regionsOfCountry(state.world, countryId).map((region) => region.id);
      const population = totalPopulationOfRegions(state.population.regions, regions);
      const income = (population / 1000) * config.economy.taxPerThousandCitizensPerDay * dayFraction;

      const liveUnits = Object.values(state.military.units).filter(
        (unit) => unit.countryId === countryId && unit.operationalState !== 'destroyed'
      );
      const equipmentUpkeep = totalUpkeepOfCountry(state.military.units, data, countryId);
      const upkeep =
        (equipmentUpkeep + liveUnits.length * config.economy.unitUpkeepPerDay) * dayFraction;

      const delta = income - upkeep;
      economy.treasury[countryId] = roundTo((economy.treasury[countryId] ?? 0) + delta, 4);
      if (delta !== 0) {
        events.emit('sim.economyTreasuryChanged', {
          factionId: countryId,
          value: economy.treasury[countryId],
          delta: roundTo(delta, 4)
        });
      }
    }
  }
}

function totalPopulationOfRegions(
  populationByRegion: Readonly<Record<string, { population: number }>>,
  regionIds: readonly string[]
): number {
  let total = 0;
  for (const regionId of regionIds) total += populationByRegion[regionId]?.population ?? 0;
  return total;
}

function totalUpkeepOfCountry(
  units: Readonly<Record<string, { countryId: string; operationalState: string; equipment: Readonly<Record<string, number>> }>>,
  data: { equipment(id: string): { upkeepPerDay: number } },
  countryId: string
): number {
  let total = 0;
  for (const unit of Object.values(units)) {
    if (unit.countryId !== countryId || unit.operationalState === 'destroyed') continue;
    for (const [equipmentId, count] of Object.entries(unit.equipment)) {
      total += data.equipment(equipmentId).upkeepPerDay * count;
    }
  }
  return total;
}

function scaleRecord(record: Readonly<Record<string, number>>, factor: number): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(record)) {
    result[key] = value * factor;
  }
  return result;
}
