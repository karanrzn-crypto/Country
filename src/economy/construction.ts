/**
 * Construction system (spec §4/§5/§6) — ONE-TIME resource costs with
 * RESERVED (secured) resources and a two-state project life:
 *
 *   start a project (free) → state = WAITING_FOR_RESOURCES
 *     → the securing pass moves units out of the FREE stockpile into the
 *       project's `secured` escrow (spec §5's reservation — no other
 *       project can ever spend the same units)
 *     → Required / Secured / Missing is visible per resource; the player
 *       buys the missing units on the market → the escrow fills
 *     → fully secured?  state = BUILDING → ONLY construction time
 *       (scaled by the economic budget, spec §14) finishes the project
 *     → the cost is consumed EXACTLY ONCE — a building project never
 *       draws resources again (spec §6)
 *
 * On completion the project becomes a production PLANT that boosts its
 * resource forever (spec §13: real simulation effects).
 *
 * Pure functions over GameState — the GovernmentSystem calls `stepProjects`
 * once per month per country; the command facade calls `startProject` and
 * (after every explicit purchase) `secureWaitingProjects`.
 * Leaf module: state types + config only.
 */

import type { GameState } from '../state/GameState';
import type { StrategicResourcesConfig, ProductionFactoryDef } from './types';
import type { ConstructionProject } from './resourceTypes';
import { roundTo } from '../utils/math';

/** Lower/upper construction-speed factor over the base rate (budget lever). */
export const CONSTRUCTION_SPEED_BASE = 0.75;
export const CONSTRUCTION_SPEED_SPAN = 0.5;

/**
 * The monthly construction speed factor of a country (economic budget ↑ →
 * faster, spec §14: the economic share really speeds up construction).
 */
export function constructionSpeedFactorOf(state: GameState, countryId: string): number {
  const economic = state.government.countries[countryId]?.budget.shares.economic ?? 0.5;
  return CONSTRUCTION_SPEED_BASE + CONSTRUCTION_SPEED_SPAN * economic;
}

export type StartProjectResult =
  | { readonly ok: true; readonly project: ConstructionProject }
  | { readonly ok: false; readonly reason: 'unknown-type' | 'limit' };

/**
 * Starts a construction project (spec §4/§6: starting is always possible —
 * an incomplete cost simply means the project WAITS for resources). Right
 * after starting, the securing pass runs so available free stock is reserved
 * immediately (oldest projects secure first).
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
  const def = config.productionFactories.find((candidate) => candidate.id === typeId);
  if (def === undefined) return { ok: false, reason: 'unknown-type' };
  const construction = state.economy.construction[countryId];
  if (construction === undefined) return { ok: false, reason: 'unknown-type' };
  if (construction.projects.length >= config.construction.maxProjects) {
    return { ok: false, reason: 'limit' };
  }
  const project: ConstructionProject = {
    id: newId(),
    typeId,
    cityId,
    startedMonth: month,
    status: 'waiting',
    progress: 0,
    secured: {}
  };
  construction.projects.push(project);
  secureWaitingProjects(state, countryId, config);
  return { ok: true, project };
}

/**
 * THE reservation pass (spec §5): every WAITING project — oldest first —
 * pulls its still-missing units out of the FREE stockpile into its escrow.
 * Reserved units are GONE from `stock` (one source of truth), so neither
 * another project, nor exports, nor military production can double-spend
 * them. A project whose every cost line is fully secured flips to BUILDING.
 *
 * Returns the projects that became `building` in this call.
 */
export function secureWaitingProjects(
  state: GameState,
  countryId: string,
  config: StrategicResourcesConfig
): ConstructionProject[] {
  const construction = state.economy.construction[countryId];
  const record = state.economy.resources[countryId];
  if (construction === undefined || record === undefined) return [];
  const funded: ConstructionProject[] = [];
  for (const project of construction.projects) {
    if (project.status !== 'waiting') continue;
    const def = config.productionFactories.find((candidate) => candidate.id === project.typeId);
    if (def === undefined) continue;
    let fullySecured = true;
    for (const [resourceId, cost] of Object.entries(def.cost)) {
      const required = Math.ceil(cost);
      const secured = Math.round(project.secured[resourceId] ?? 0);
      const missing = required - secured;
      if (missing <= 0) continue;
      const free = Math.floor(record.stock[resourceId] ?? 0);
      const take = Math.min(missing, free);
      if (take > 0) {
        // REAL units move stock → escrow (the reservation itself).
        record.stock[resourceId] = free - take;
        project.secured[resourceId] = secured + take;
      }
      if (secured + take < required) fullySecured = false;
    }
    if (fullySecured) {
      project.status = 'building';
      project.progress = 0;
      funded.push(project);
    } else {
      project.progress = securedFractionOf(def, project);
    }
  }
  return funded;
}

/** Σ secured / Σ cost of ONE project (0..1, informational for waiting). */
function securedFractionOf(def: ProductionFactoryDef, project: ConstructionProject): number {
  let totalCost = 0;
  let totalSecured = 0;
  for (const [resourceId, cost] of Object.entries(def.cost)) {
    totalCost += Math.ceil(cost);
    totalSecured += Math.round(project.secured[resourceId] ?? 0);
  }
  return totalCost > 0 ? Math.min(1, roundTo(totalSecured / totalCost, 4)) : 1;
}

/** Per-resource view of ONE project's Required / Secured / Missing numbers. */
export interface ProjectShortage {
  readonly resourceId: string;
  readonly required: number;
  readonly secured: number;
  readonly missing: number;
}

/** The Required/Secured/Missing triad of ONE project from the LIVE state. */
export function projectShortageOf(
  _state: GameState,
  _countryId: string,
  config: StrategicResourcesConfig,
  project: ConstructionProject
): ProjectShortage[] {
  const def = config.productionFactories.find((candidate) => candidate.id === project.typeId);
  const rows: ProjectShortage[] = [];
  if (def === undefined) return rows;
  for (const [resourceId, cost] of Object.entries(def.cost)) {
    const required = Math.ceil(cost);
    const secured = Math.round(project.secured[resourceId] ?? 0);
    rows.push({
      resourceId,
      required,
      secured,
      missing: Math.max(0, required - secured)
    });
  }
  return rows;
}

/**
 * Reserved (secured) units of ONE country across ALL its projects:
 * resourceId → Σ secured. `stock` already excludes them physically — this
 * view exists for the UI's free/reserved display (spec §5).
 */
export function reservedResourcesOf(
  state: GameState,
  countryId: string
): Record<string, number> {
  const reserved: Record<string, number> = {};
  for (const project of state.economy.construction[countryId]?.projects ?? []) {
    for (const [resourceId, amount] of Object.entries(project.secured)) {
      reserved[resourceId] = (reserved[resourceId] ?? 0) + Math.round(amount);
    }
  }
  return reserved;
}

export interface StepOutcome {
  /** Projects that completed this month (became plants). */
  readonly completed: ConstructionProject[];
}

/**
 * Advances EVERY project of ONE country by one month:
 *  1. the securing pass runs first (units produced/imported this month may
 *     complete a waiting project's escrow — never the reverse);
 *  2. BUILDING projects advance by TIME ONLY (speed = economic budget
 *     lever) and consume NOTHING (spec §6: one-time cost);
 *  3. finished projects graduate into plants (real production boosters).
 * Waiting projects simply wait — never cancelled, never negative.
 */
export function stepProjects(
  state: GameState,
  countryId: string,
  config: StrategicResourcesConfig,
  month: number
): StepOutcome {
  const construction = state.economy.construction[countryId];
  const record = state.economy.resources[countryId];
  if (construction === undefined || record === undefined) return { completed: [] };

  secureWaitingProjects(state, countryId, config);

  const speed = constructionSpeedFactorOf(state, countryId);
  const completed: ConstructionProject[] = [];
  for (const project of construction.projects) {
    if (project.status !== 'building') continue;
    const def = config.productionFactories.find((candidate) => candidate.id === project.typeId);
    if (def === undefined) continue;
    project.progress = Math.min(1, roundTo(project.progress + speed / def.buildMonths, 4));
    if (project.progress >= 1) completed.push(project);
  }

  if (completed.length > 0) {
    const plants = (state.economy.plants[countryId] ??= {});
    construction.projects = construction.projects.filter((project) => {
      if (!completed.includes(project)) return true;
      plants[project.id] = { id: project.id, typeId: project.typeId, cityId: project.cityId };
      void month;
      return false;
    });
  }
  return { completed };
}
