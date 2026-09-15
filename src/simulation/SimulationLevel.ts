/**
 * Simulation detail levels. Entities far from the player simulate cheaper:
 * detailed → per-entity logic, light → simplified, abstract → aggregated.
 */
export type SimulationLevel = 'detailed' | 'light' | 'abstract';

export const SIMULATION_LEVEL_ORDER: Readonly<Record<SimulationLevel, number>> = {
  detailed: 3,
  light: 2,
  abstract: 1
};
