/**
 * The ECONOMIC AI of ONE country (spec §6) — the PURE decision of WHAT to
 * build next; the GovernmentSystem owns WHEN (monthly chance, affordability
 * margin, project cap) and WHERE (a free cell of the country's own land —
 * one economic building per region, spec §1).
 *
 * The priority follows the country's REAL economic state (spec §6 — never
 * random, never filling every region):
 *
 *   ۱. NEED FIRST — the largest UNCOVERED shortage wins (the record's
 *      post-trade deficit: imports were already tried and could not cover
 *      it). A food shortage → مزرعه, an oil shortage → میدان نفتی, iron →
 *      معدن آهن, industrial → کارخانه. Ties resolve by config resource
 *      order (deterministic).
 *   ۲. NO urgent need — develop the strongest good that is not ALREADY in
 *      surplus (redundant capacity would be irrational; the next-best good
 *      diversifies the economy, spec §5/§12).
 *   ۳. EVERYTHING in surplus — reinforce the strongest (export depth,
 *      spec §5/§7).
 *
 * Leaf module: state types + config only. Unit-testable without a system.
 */

import type { GameState } from '../state/GameState';
import type { StrategicResourcesConfig } from './types';
import { resourceDisplayStatusOf } from './resources';

/**
 * The building type id the country should build next (null when the state
 * or the config gives nothing to build on — the caller simply skips).
 */
export function aiBuildingTypeId(
  state: GameState,
  countryId: string,
  config: StrategicResourcesConfig
): string | null {
  const record = state.economy.resources[countryId];
  if (record === undefined) return null;

  // ۱. NEED (spec §6: کمبود → اولویت ساخت سازندهٔ همان کالا) — the largest
  //    uncovered deficit across the config's resources.
  let neededResource: string | null = null;
  let worst = 0;
  for (const resource of config.resources) {
    const uncovered = record.shortage[resource.id] ?? 0;
    if (uncovered > worst) {
      worst = uncovered;
      neededResource = resource.id;
    }
  }
  if (neededResource !== null) {
    const needDef = config.buildings.find((candidate) => candidate.resource === neededResource);
    if (needDef !== undefined) return needDef.id;
  }

  // ۲. NO urgent need — develop the STRONGEST produced good that is NOT
  //    already in surplus (a surplus good needs no more capacity — building
  //    its kind again would be irrational; the next-best good diversifies
  //    the economy and deepens world trade, spec §5/§6/§12). Deterministic:
  //    ties resolve by config resource order.
  let bestResource: string | null = null;
  let bestAmount = -1;
  for (const resource of config.resources) {
    const amount = record.production[resource.id] ?? 0;
    if (amount <= bestAmount) continue;
    if (resourceDisplayStatusOf(record, resource.id, config.displayStatus) === 'surplus') continue;
    bestAmount = amount;
    bestResource = resource.id;
  }
  if (bestResource !== null) {
    const bestDef = config.buildings.find((candidate) => candidate.resource === bestResource);
    if (bestDef !== undefined) return bestDef.id;
  }

  // ۳. EVERY good already surplus — reinforce the strongest (export depth,
  //    spec §5: the specialization surplus feeds world trade).
  let strongest: string | null = null;
  let strongestOutput = 0;
  for (const [resourceId, amount] of Object.entries(record.production)) {
    if (amount > strongestOutput) {
      strongestOutput = amount;
      strongest = resourceId;
    }
  }
  if (strongest === null) return null;
  return config.buildings.find((candidate) => candidate.resource === strongest)?.id ?? null;
}
