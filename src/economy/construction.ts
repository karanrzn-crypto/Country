/**
 * Construction system (spec §1) — SIMPLE, money-paid, one-time costs on
 * geographic grid cells:
 *
 *   pick a building   → the FULL money cost is deducted from the treasury
 *                       ONCE (a project that cannot be paid cannot start)
 *   pick a grid cell  → the cell must be the player's OWN land and hold no
 *                       economic building yet (ONE building per region)
 *     → the project BUILDS by time alone (the economic budget scales the
 *       speed — the only budget lever)
 *     → on completion it becomes a BUILDING anchored to that cell: its one
 *       effect is producing its good (scaled by the economy level, §3)
 *
 * No escrow, no waiting-for-resources state, no monthly draws, no resource
 * chains. One source of truth: the treasury pays once, `buildings` holds
 * the completed effects — always read from here, never copied.
 *
 * Pure functions over GameState — the GovernmentSystem calls `stepProjects`
 * once per month per country; the command facade calls `startProject`.
 * Leaf module: state types + config only.
 */

import type { GameState } from '../state/GameState';
import type { StrategicResourcesConfig } from './types';
import type { BuildingProject } from './resourceTypes';
import { economicBuildingAtCell, cellIsUnderConstruction } from './resources';
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
  | {
      readonly ok: false;
      readonly reason:
        | 'unknown-type'
        | 'limit'
        | 'no-funds'
        | 'occupied';
    };

/**
 * Starts ONE construction project (spec §1): checks the type, the
 * concurrent-project cap, the CELL (one economic building per region — a
 * cell holding a building or a project is taken) and the MONEY (the whole
 * one-time cost must be in the treasury), deducts the cost ONCE and starts
 * building. Negative treasuries are unrepresentable — the check comes first
 * (spec §14). Cell OWNERSHIP (own country, valid land) is validated by the
 * caller against the live map model.
 */
export function startProject(
  state: GameState,
  countryId: string,
  config: StrategicResourcesConfig,
  typeId: string,
  cellKey: string,
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
  // ONE economic building per region (spec §1): the cell must be free —
  // neither a completed building nor an in-progress project may sit there.
  if (cellKey === '' || economicBuildingAtCell(state, cellKey) !== null || cellIsUnderConstruction(state, cellKey)) {
    return { ok: false, reason: 'occupied' };
  }
  const treasury = state.economy.treasury[countryId] ?? 0;
  if (treasury < def.cost) return { ok: false, reason: 'no-funds' };

  // ONE-TIME cost, paid in full, exactly once (spec §14).
  state.economy.treasury[countryId] = roundTo(treasury - def.cost, 4);

  const project: BuildingProject = {
    id: newId(),
    typeId,
    cellKey,
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
 * money or resources again (the cost was paid once at start, spec §1).
 * Finished projects graduate into buildings on their OWN cell (real
 * production, §2's grid info reads them from here).
 */
export function stepProjects(
  state: GameState,
  countryId: string,
  config: StrategicResourcesConfig,
  month: number
): StepOutcome {
  void month;
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
      buildings[project.id] = { id: project.id, typeId: project.typeId, cellKey: project.cellKey };
      return false;
    });
  }
  return { completed };
}
