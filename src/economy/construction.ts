/**
 * Construction system (spec §1/§4/§5/§6) — SIMPLE, one-time costs on
 * geographic grid cells, deliberately HARD to start:
 *
 *   pick a building   → THREE gates must pass at once (spec §4):
 *                         money        (the treasury pays ONCE, in full)
 *                         materials    (industrial-goods units, stock-paid ONCE)
 *                         workforce    (a CAPACITY held while building — the
 *                                       country's base + per-million pool
 *                                       must fit the running projects)
 *                       plus the CONSTRUCTION CAPACITY (spec §6): at most
 *                       `maxProjects` sites at the same time (AI included)
 *   pick a grid cell  → the cell must be the player's OWN land and hold no
 *                       economic building yet (ONE building per region)
 *     → the project BUILDS by time alone (the economic budget scales the
 *       speed — the only budget lever; build months are LONG, §5)
 *     → on completion it becomes a BUILDING anchored to that cell, holding
 *       a FINITE extraction reserve for oil/iron (spec §8 — sized by the
 *       cell's land quality)
 *
 * One source of truth: the treasury + stock pay once, `buildings` holds
 * the completed effects — always read from here, never copied.
 *
 * Pure functions over GameState — the GovernmentSystem calls `stepProjects`
 * once per month per country; the command facade calls `startProject`.
 * Leaf module: state types + config + map geography only.
 */

import type { GameState } from '../state/GameState';
import type { StrategicMapModel } from '../world/map/MapTypes';
import type { StrategicResourcesConfig } from './types';
import type { BuildingProject, BuildingRecord } from './resourceTypes';
import { economicBuildingAtCell, cellIsUnderConstruction } from './resources';
import { cellQualityOf, reserveCapacityOf } from './quality';
import { findGridCell } from '../world/map/MapGeography';
import { roundTo } from '../utils/math';

/** Lower/upper construction-speed factor over the base rate (budget lever). */
export const CONSTRUCTION_SPEED_BASE = 0.75;
export const CONSTRUCTION_SPEED_SPAN = 0.5;

/**
 * The MONTHS REMAINING of ONE project (spec §5 — the construction time is
 * shown ONLY in months, never a percentage): the un-built share of the
 * build time divided by the country's monthly speed, rounded UP (a
 * partially-built month is still a month of waiting). This ONE function is
 * the definition the dashboard cards and the map's grid panel both read —
 * the number can never disagree between UI surfaces.
 */
export function projectMonthsRemaining(progress: number, buildMonths: number, speed: number): number {
  const remaining = Math.max(0, 1 - progress);
  if (speed <= 0) return Math.ceil(remaining * buildMonths);
  return Math.ceil((remaining * buildMonths) / speed);
}

/**
 * The monthly construction speed factor of a country (economic budget ↑ →
 * faster): the ONE place the budget pool touches construction.
 */
export function constructionSpeedFactorOf(state: GameState, countryId: string): number {
  const economic = state.government.countries[countryId]?.budget.shares.economic ?? 0.5;
  return CONSTRUCTION_SPEED_BASE + CONSTRUCTION_SPEED_SPAN * economic;
}

/**
 * The country's construction WORKFORCE pool (spec §4): a base plus a
 * per-million term. Running projects hold their workforce for the whole
 * build; the pool frees up as projects complete.
 */
export function workforceCapacityOf(state: GameState, countryId: string, config: StrategicResourcesConfig): number {
  const population = state.countries.countries[countryId]?.population ?? 0;
  return Math.round(
    config.construction.workforceBase + (population / 1_000_000) * config.construction.workforcePerMillion
  );
}

/** The workforce currently HELD by the country's running projects (§4). */
export function workforceUsedBy(state: GameState, countryId: string, config: StrategicResourcesConfig): number {
  const construction = state.economy.construction[countryId];
  if (construction === undefined) return 0;
  let total = 0;
  for (const project of construction.projects) {
    const def = config.buildings.find((candidate) => candidate.id === project.typeId);
    if (def !== undefined) total += def.workforce;
  }
  return total;
}

export type StartProjectResult =
  | { readonly ok: true; readonly project: BuildingProject }
  | {
      readonly ok: false;
      readonly reason:
        | 'unknown-type'
        | 'limit'
        | 'no-funds'
        | 'no-materials'
        | 'workforce'
        | 'occupied';
    };

/**
 * Starts ONE construction project (spec §1/§4): checks the type, the
 * concurrent-project CAPACITY (§6), the WORKFORCE pool (§4), the CELL (one
 * economic building per region — a cell holding a building or a project is
 * taken), the MONEY and the MATERIALS. The money AND the materials are
 * deducted ONCE, in full; the workforce is held (capacity check only) and
 * released on completion. Negative treasuries/stocks are unrepresentable —
 * every check comes first (spec §14). Cell OWNERSHIP (own country, valid
 * land) is validated by the caller against the live map model.
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
  // Construction materials (spec §4): industrial-goods units, stock-paid once.
  const materialsStock = state.economy.resources[countryId]?.stock.industrial ?? 0;
  if (materialsStock < def.materials) return { ok: false, reason: 'no-materials' };
  // Workforce (spec §4): the running projects' held workforce must fit.
  const used = workforceUsedBy(state, countryId, config);
  if (used + def.workforce > workforceCapacityOf(state, countryId, config)) {
    return { ok: false, reason: 'workforce' };
  }

  // ONE-TIME costs, paid in full, exactly once (spec §14).
  state.economy.treasury[countryId] = roundTo(treasury - def.cost, 4);
  const record = state.economy.resources[countryId]!;
  record.stock.industrial = Math.max(0, Math.round(materialsStock - def.materials));

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
 * money or resources again (the costs were paid once at start, spec §4).
 * Finished projects graduate into buildings on their OWN cell; extractive
 * types (oil, iron) receive the FINITE reserve their cell's land quality
 * supports (spec §8 — richer region, bigger reserve).
 */
export function stepProjects(
  state: GameState,
  mapModel: StrategicMapModel,
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
      buildings[project.id] = finishBuilding(project, mapModel, config);
      return false;
    });
  }
  return { completed };
}

/** The completed BUILDING record of ONE project — reserve sized by quality. */
function finishBuilding(
  project: BuildingProject,
  mapModel: StrategicMapModel,
  config: StrategicResourcesConfig
): BuildingRecord {
  const def = config.buildings.find((candidate) => candidate.id === project.typeId);
  // Military infrastructure holds NO extraction reserve (nothing extracts).
  if (def === undefined || def.resource === undefined || def.reserveUnits <= 0) {
    return { id: project.id, typeId: project.typeId, cellKey: project.cellKey };
  }
  const cellIndex = findGridCell(mapModel, project.cellKey);
  const quality = cellQualityOf(mapModel, cellIndex, def.resource, config);
  const capacity = reserveCapacityOf(def, quality, config);
  return {
    id: project.id,
    typeId: project.typeId,
    cellKey: project.cellKey,
    reserveRemaining: capacity,
    reserveCapacity: capacity
  };
}
