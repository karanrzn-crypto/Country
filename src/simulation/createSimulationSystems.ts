import type { GameConfig } from '../config/configTypes';
import type { SimulationSystemDef } from './SimulationEngine';
import { WeatherSystem } from './systems/WeatherSystem';
import { EconomySystem } from './systems/EconomySystem';
import { PopulationSystem } from './systems/PopulationSystem';
import { SupplySystem } from './systems/SupplySystem';
import { PoliticalSystem } from './systems/PoliticalSystem';
import { MilitaryStrengthSystem } from './systems/MilitaryStrengthSystem';

/**
 * Assembles the default simulation pipeline. Registration order defines the
 * deterministic simulation contract; declared dependencies are validated.
 */
export function createDefaultSimulationSystems(_config: GameConfig): SimulationSystemDef[] {
  void _config;
  return [
    new WeatherSystem(),
    new EconomySystem(),
    new PopulationSystem(),
    new SupplySystem(),
    new PoliticalSystem(),
    new MilitaryStrengthSystem()
  ];
}
