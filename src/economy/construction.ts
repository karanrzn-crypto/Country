/**
 * Construction system (spec §4/§17) — buildings pay their resource cost
 * MONTH BY MONTH out of the REAL stockpile.
 *
 *   start a project (free) → every month it draws rate × cost per resource
 *     → resources available? consumed, progress advances
 *     → stock empty?  the project STALLS (Required/Owned/Missing shown)
 *     → the player buys the missing units on the market → work continues
 *
 * The monthly draw is scaled by the ECONOMIC BUDGET share (a real
 * construction-speed lever: 0.75× at a zero economic budget, 1.25× at a
 * full one). On completion the project becomes a production PLANT that
 * boosts its resource forever (spec §13: real simulation effects).
 *
 * Pure functions over GameState — the GovernmentSystem calls `stepProjects`
 * once per month per country; the command facade calls `startProject`.
 * Leaf module: state types + config only.
 */

import type { GameState } from '../state/GameState';
import type { StrategicResourcesConfig } from './types';
import type { ConstructionProject } from './resourceTypes';
import { roundTo } from '../utils/math';

/** Lower/upper construction-speed factor over the base rate (budget lever). */
export const CONSTRUCTION_SPEED_BASE = 0.75;
export const CONSTRUCTION_SPEED_SPAN = 0.5;

/** The monthly construction speed factor of a country (economic budget ↑ → faster). */
export function constructionSpeedFactorOf(state: GameState, countryId: string): number {
  const economic = state.government.countries[countryId]?.budget.shares.economic ?? 0.5;
  return CONSTRUCTION_SPEED_BASE + CONSTRUCTION_SPEED_SPAN * economic;
}

export type StartProjectResult =
  | { readonly ok: true; readonly project: ConstructionProject }
  | { readonly ok: false; readonly reason: 'unknown-type' | 'limit' };

/**
 * Starts a construction project (spec §4: starting is always possible —
 * the work itself only progresses while the resources hold out).
 * Deterministic id from country + month + type.
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
    progress: 0,
    paid: {}
  };
  construction.projects.push(project);
  return { ok: true, project };
}

/** Per-resource view of ONE project's Required / Owned / Missing numbers. */
export interface ProjectShortage {
  readonly resourceId: string;
  readonly required: number;
  readonly owned: number;
  readonly missing: number;
}

/** The Required/Owned/Missing triad of ONE project from the LIVE state. */
export function projectShortageOf(
  state: GameState,
  countryId: string,
  config: StrategicResourcesConfig,
  project: ConstructionProject
): ProjectShortage[] {
  const def = config.productionFactories.find((candidate) => candidate.id === project.typeId);
  const stock = state.economy.resources[countryId]?.stock ?? {};
  const rows: ProjectShortage[] = [];
  if (def === undefined) return rows;
  for (const [resourceId, cost] of Object.entries(def.cost)) {
    const required = Math.ceil(cost);
    const paid = Math.round(project.paid[resourceId] ?? 0);
    const remaining = Math.max(0, required - paid);
    const owned = Math.round(stock[resourceId] ?? 0);
    rows.push({
      resourceId,
      required,
      owned,
      missing: Math.max(0, remaining - owned)
    });
  }
  return rows;
}

export interface StepOutcome {
  /** Projects that completed this month (became plants). */
  readonly completed: ConstructionProject[];
}

/**
 * Advances EVERY project of ONE country by one month: draws the monthly
 * resource share from the stockpile (capped by availability), advances the
 * progress, completes fully-paid projects. Stalled projects simply make no
 * progress that month — never cancelled, never negative.
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
  const speed = constructionSpeedFactorOf(state, countryId);
  const fraction = Math.min(1, config.construction.monthlyRate * speed);
  const completed: ConstructionProject[] = [];

  for (const project of construction.projects) {
    const def = config.productionFactories.find((candidate) => candidate.id === project.typeId);
    if (def === undefined) continue;
    let totalCost = 0;
    let totalPaid = 0;
    for (const [resourceId, cost] of Object.entries(def.cost)) {
      const share = Math.ceil(cost * fraction);
      const available = Math.floor(record.stock[resourceId] ?? 0);
      const paid = Math.min(share, available);
      if (paid > 0) {
        record.stock[resourceId] = available - paid;
        project.paid[resourceId] = (project.paid[resourceId] ?? 0) + paid;
      }
      totalCost += Math.ceil(cost);
      totalPaid += Math.round(project.paid[resourceId] ?? 0);
    }
    project.progress = totalCost > 0 ? Math.min(1, roundTo(totalPaid / totalCost, 4)) : 1;
    if (totalCost > 0 && totalPaid >= totalCost) {
      project.progress = 1;
      completed.push(project);
    }
  }

  if (completed.length > 0) {
    // Completed projects graduate into plants (real production boosters).
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
