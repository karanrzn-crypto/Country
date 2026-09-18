/**
 * Construction system (spec §8) — SIMPLE, money-paid, one-time costs:
 *
 *   start a project  → the FULL money cost is deducted from the treasury
 *                      ONCE (a project the country cannot pay cannot start)
 *     → the project BUILDS by time alone (the economic budget scales the
 *       speed — the only budget lever)
 *     → on completion it becomes a BUILDING with exactly ONE effect:
 *       production (monthly resource units) or income (monthly money)
 *
 * No escrow, no waiting-for-resources state, no monthly draws, no resource
 * chains (spec §8: a factory must not need dozens of inputs). One source of
 * truth: the treasury pays once, `buildings` holds the completed effects.
 *
 * Pure functions over GameState — the GovernmentSystem calls `stepProjects`
 * once per month per country; the command facade calls `startProject`.
 * Leaf module: state types + config only.
 */

import type { GameState } from '../state/GameState';
import type { StrategicResourcesConfig } from './types';
import type { BuildingProject } from './resourceTypes';
import { roundTo } from '../utils/math';

/** Lower/upper construction-speed factor over the base rate (budget lever). */
export const CONSTRUCTION_SPEED_BASE = 0.75;
export const CONSTRUCTION_SPEED_SPAN = 0.5;

/**
 * The monthly construction speed factor of a country (economic budget ↑ →
 * faster): the ONE place the budget pool touches construction.
 */
export function constructionSpeedFactorOf(state: GameState, countryId: string): number {
  const economic = state.government.countries[countryId]?.budget.shares.economic ?? 0.5;
  return CONSTRUCTION_SPEED_BASE + CONSTRUCTION_SPEED_SPAN * economic;
}

export type StartProjectResult =
  | { readonly ok: true; readonly project: BuildingProject }
  | { readonly ok: false; readonly reason: 'unknown-type' | 'limit' | 'no-funds' | 'no-capital' };

/**
 * Starts ONE construction project (spec §8): checks the type, the
 * concurrent-project cap and the MONEY (the whole one-time cost must be in
 * the treasury), deducts the cost ONCE and starts building. Negative
 * treasuries are unrepresentable — the check comes first (spec §14).
 */
export function startProject(
  state: GameState,
  countryId: string,
  config: StrategicResourcesConfig,
  typeId: string,
  cityId: string,
  month: number,
  newId: () => string
): StartProjectResult {
  const def = config.buildings.find((candidate) => candidate.id === typeId);
  if (def === undefined) return { ok: false, reason: 'unknown-type' };
  const construction = state.economy.construction[countryId];
  if (construction === undefined) return { ok: false, reason: 'unknown-type' };
  if (construction.projects.length >= config.construction.maxProjects) {
    return { ok: false, reason: 'limit' };
  }
  const treasury = state.economy.treasury[countryId] ?? 0;
  if (treasury < def.cost) return { ok: false, reason: 'no-funds' };

  // ONE-TIME cost, paid in full, exactly once (spec §8/§14).
  state.economy.treasury[countryId] = roundTo(treasury - def.cost, 4);

  const project: BuildingProject = {
    id: newId(),
    typeId,
    cityId,
    startedMonth: month,
    progress: 0
  };
  construction.projects.push(project);
  return { ok: true, project };
}

export interface StepOutcome {
  /** Projects that completed this month (became buildings). */
  readonly completed: BuildingProject[];
}

/**
 * Advances EVERY project of ONE country by one month: building is TIME
 * ONLY (speed = economic budget lever) — a building project never draws
 * money or resources again (the cost was paid once at start, spec §8).
 * Finished projects graduate into buildings (real production/income).
 */
export function stepProjects(
  state: GameState,
  countryId: string,
  config: StrategicResourcesConfig,
  month: number
): StepOutcome {
  const construction = state.economy.construction[countryId];
  if (construction === undefined) return { completed: [] };

  const speed = constructionSpeedFactorOf(state, countryId);
  const completed: BuildingProject[] = [];
  for (const project of construction.projects) {
    const def = config.buildings.find((candidate) => candidate.id === project.typeId);
    if (def === undefined) continue;
    project.progress = Math.min(1, roundTo(project.progress + speed / def.buildMonths, 4));
    if (project.progress >= 1) completed.push(project);
  }

  if (completed.length > 0) {
    const buildings = (state.economy.buildings[countryId] ??= {});
    construction.projects = construction.projects.filter((project) => {
      if (!completed.includes(project)) return true;
      buildings[project.id] = { id: project.id, typeId: project.typeId, cityId: project.cityId };
      void month;
      return false;
    });
  }
  return { completed };
}
