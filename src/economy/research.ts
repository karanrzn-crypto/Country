/**
 * Resource research (spec §11/§12/§13) — mine branches with LEVELS.
 *
 *   RESOURCE RESEARCH — Mines: Oil · Iron · Coal · Copper · Food · Wood
 *
 * Unlocking level N for a resource branch (a one-time money cost, spec §10:
 * money backs government costs) lets the country upgrade ITS mines of that
 * resource to level N. A level-2 mine REALLY produces 1.5× (the recompute
 * pass multiplies the deposit output — spec §13: research is never just a
 * badge). Level 3+ slots exist in the config for future expansion.
 *
 * Pure functions over GameState — the command facade calls `unlockMineLevel`
 * and `upgradeMine`. Leaf module: state types + config only.
 */

import type { GameState } from '../state/GameState';
import type { StrategicResourcesConfig } from './types';

/** Highest mine level defined by the config (multipliers table size). */
export function maxMineLevel(config: StrategicResourcesConfig): number {
  const levels = Object.keys(config.mineLevels.multipliers)
    .map((key) => Number.parseInt(key, 10))
    .filter((value) => Number.isFinite(value));
  return levels.length > 0 ? Math.max(...levels) : 1;
}

/** The country's UNLOCKED mine level for ONE resource branch (absent = 1). */
export function unlockedMineLevelOf(state: GameState, countryId: string, resourceId: string): number {
  return state.economy.research[countryId]?.mineLevels[resourceId] ?? 1;
}

/** Money cost of unlocking the NEXT level of ONE branch (undefined = maxed). */
export function researchCostOf(
  config: StrategicResourcesConfig,
  resourceId: string,
  countryId: string,
  state: GameState
): number | undefined {
  const next = unlockedMineLevelOf(state, countryId, resourceId) + 1;
  return config.research.levels[String(next)];
}

export type UnlockResult =
  | { readonly ok: true; readonly level: number }
  | { readonly ok: false; readonly reason: 'unknown-resource' | 'max-level' | 'insufficient-funds' };

/**
 * Unlocks the NEXT mine level of ONE resource branch for a country:
 * checks the money, deducts it, raises the unlocked level. The upgrade
 * itself happens per-mine (upgradeMine) — research only opens the door.
 */
export function unlockMineLevel(
  state: GameState,
  countryId: string,
  config: StrategicResourcesConfig,
  resourceId: string
): UnlockResult {
  if (!config.resources.some((resource) => resource.id === resourceId)) {
    return { ok: false, reason: 'unknown-resource' };
  }
  const current = unlockedMineLevelOf(state, countryId, resourceId);
  const cost = config.research.levels[String(current + 1)];
  if (cost === undefined) return { ok: false, reason: 'max-level' };
  const treasury = state.economy.treasury[countryId] ?? 0;
  if (treasury < cost) return { ok: false, reason: 'insufficient-funds' };
  state.economy.treasury[countryId] = Math.round((treasury - cost) * 10000) / 10000;
  const research = (state.economy.research[countryId] ??= { mineLevels: {} });
  research.mineLevels[resourceId] = current + 1;
  return { ok: true, level: current + 1 };
}

export type UpgradeResult =
  | { readonly ok: true; readonly level: number }
  | {
      readonly ok: false;
      readonly reason: 'unknown-deposit' | 'not-owner' | 'research-required' | 'max-level';
    };

/**
 * Upgrades ONE mine (deposit) by one level (spec §12/§15): the mine must
 * belong to the country, the country must have UNLOCKED the target level
 * through research, and a multiplier must exist for it. The production
 * effect becomes real at the next recompute (immediately for the player —
 * the facade recomputes after a successful upgrade).
 */
export function upgradeMine(
  state: GameState,
  countryId: string,
  config: StrategicResourcesConfig,
  depositId: string,
  depositCountryId: string,
  depositResourceId: string
): UpgradeResult {
  if (depositCountryId !== countryId) return { ok: false, reason: 'not-owner' };
  const current = state.economy.mines[depositId] ?? 1;
  const unlocked = unlockedMineLevelOf(state, countryId, depositResourceId);
  if (current + 1 > unlocked) return { ok: false, reason: 'research-required' };
  const multiplier = config.mineLevels.multipliers[String(current + 1)];
  if (multiplier === undefined) return { ok: false, reason: 'max-level' };
  state.economy.mines[depositId] = current + 1;
  return { ok: true, level: current + 1 };
}
