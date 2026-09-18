/**
 * Region quality · country potential · diminishing returns (spec §2/§3/§7/§15).
 *
 * THE three balance levers that make PLACE and PROFILE matter:
 *
 *  - CELL QUALITY (§3): every grid cell carries its own land quality per
 *    good — the same biome/terrain weight tables the domestic baseline uses
 *    (ONE geography, ONE truth), applied to a SINGLE cell instead of the
 *    country average. An excellent farm belt vs a barren desert plateau.
 *  - COUNTRY POTENTIAL (§2/§15): the country's specialization rank per good
 *    maps to an output multiplier — an oil field in an oil-poor country
 *    yields far less than in an oil-rich one. Building somewhere never
 *    erases the country's economic profile.
 *  - DIMINISHING RETURNS (§7): the k-th building of one type in a country
 *    yields less than the first — stacking farms never scales linearly.
 *
 * Pure LEAF module: map model + config + math only. No state mutation.
 */

import type { StrategicMapModel } from '../world/map/MapTypes';
import type {
  StrategicResourcesConfig,
  DomesticBaselineResourceDef,
  BuildingDef
} from './types';
import { countryBaselineProduction } from './domesticBaseline';
import { roundTo } from '../utils/math';

/** Persian labels of the quality tiers (spec §3 — عالی/خوب/متوسط/ضعیف). */
export type QualityLabel = 'عالی' | 'خوب' | 'متوسط' | 'ضعیف';

/**
 * The land quality of ONE grid cell for ONE good (spec §3): the cell's own
 * biome/terrain mix against the resource's weight tables — 0..1. Uses the
 * SAME tables as the country baseline (one geography, one truth); a cell
 * missing from the map reads neutral 0.5.
 */
export function cellQualityOf(
  model: StrategicMapModel,
  cellIndex: number,
  resourceId: string,
  config: StrategicResourcesConfig
): number {
  const def = config.domesticBaseline.resources[resourceId];
  if (def === undefined || cellIndex < 0 || cellIndex >= model.features.biomes.length) return 0.5;
  const biome = model.features.biomes[cellIndex];
  const terrain = model.features.terrain[cellIndex];
  const biomeSuit = suitOf(biome === 'ocean' ? null : biome, def, 'biomes', def.biomeNeutral ?? 0.5);
  const terrainSuit = suitOf(terrain ?? null, def, 'terrain', def.terrainNeutral ?? 0.5);
  const quality =
    config.domesticBaseline.biomeWeight * biomeSuit + config.domesticBaseline.terrainWeight * terrainSuit;
  return Math.min(1, Math.max(0, roundTo(quality, 4)));
}

/** One class weight lookup (null/missing class → the neutral weight). */
function suitOf(
  classId: string | null,
  def: DomesticBaselineResourceDef,
  kind: 'biomes' | 'terrain',
  neutral: number
): number {
  const weights = kind === 'biomes' ? def.biomes : def.terrain;
  if (weights === undefined) return neutral;
  if (classId === null) return neutral;
  return weights[classId] ?? 0;
}

/** The Persian quality label of ONE 0..1 quality (config thresholds). */
export function qualityLabelOf(quality: number, config: StrategicResourcesConfig): QualityLabel {
  if (quality >= config.cellQuality.excellent) return 'عالی';
  if (quality >= config.cellQuality.good) return 'خوب';
  if (quality >= config.cellQuality.fair) return 'متوسط';
  return 'ضعیف';
}

/**
 * The SPECIALIZATION RANKS of ONE country (spec §4/§15): resourceId →
 * 0-based rank (0 = the country's strongest good). Derived from the SAME
 * raw geography baseline the specialized production amplifies — ties
 * resolve by config resource order (deterministic).
 */
export function specializationRankingOf(
  model: StrategicMapModel,
  countryId: string,
  config: StrategicResourcesConfig
): Record<string, number> {
  const raw = countryBaselineProduction(model, countryId, config.domesticBaseline);
  const ranked = config.resources
    .map((resource, index) => ({ id: resource.id, index, amount: raw[resource.id] ?? 0 }))
    .sort((a, b) => b.amount - a.amount || a.index - b.index);
  const ranks: Record<string, number> = {};
  ranked.forEach((entry, rank) => {
    ranks[entry.id] = rank;
  });
  return ranks;
}

/**
 * The country's resource POTENTIAL multiplier for ONE good (spec §2/§15):
 * the specialization rank reads `potentialByRank` — best good ≈ 1.35, the
 * weakest ≈ 0.6. Unknown ranks fall back to the last entry (never > 1.35).
 */
export function countryPotentialFactor(
  model: StrategicMapModel,
  countryId: string,
  resourceId: string,
  config: StrategicResourcesConfig
): number {
  const ranks = specializationRankingOf(model, countryId, config);
  const rank = ranks[resourceId] ?? config.resources.length - 1;
  const table = config.specialization.potentialByRank;
  if (table.length === 0) return 1;
  return table[Math.min(rank, table.length - 1)] ?? 1;
}

/**
 * The DIMINISHING multiplier of the k-th building of one type (spec §7):
 * index 0 (the first) → 1; every further building loses `step`, floored at
 * `min`. Moderate by design (spec §7 — نه افراطی).
 */
export function diminishingFactorOf(index: number, config: StrategicResourcesConfig): number {
  const { step, min } = config.diminishingReturns;
  return Math.max(min, roundTo(1 - step * Math.max(0, index), 4));
}

/**
 * The EXTRACTION RESERVE a building starts with on ONE cell (spec §8):
 * richer regions hold bigger reserves (0.5..1.0 × the type's base reserve).
 */
export function reserveCapacityOf(
  def: BuildingDef,
  quality: number,
  config: StrategicResourcesConfig
): number {
  void config;
  return Math.round(def.reserveUnits * (0.5 + 0.5 * Math.min(1, Math.max(0, quality))));
}

/**
 * The ESTIMATED monthly output of ONE building on ONE cell — the number
 * the build preview shows BEFORE construction (spec §3):
 * base × quality × potential × economy level × diminishing.
 */
export function estimatedBuildingOutputOf(
  def: BuildingDef,
  quality: number,
  potential: number,
  levelFactor: number,
  diminishingIndex: number,
  config: StrategicResourcesConfig
): number {
  return Math.max(
    0,
    Math.round(def.output * quality * potential * levelFactor * diminishingFactorOf(diminishingIndex, config))
  );
}
