/**
 * Domestic baseline production (spec §3) — every country can produce SOME
 * of MOST resources from its own geography, in DIFFERENT amounts; rare
 * resources stay scarce where the land genuinely does not support them.
 *
 * NOT hand-made per-country numbers: derived from the LIVE map model —
 *   - the country's per-cell BIOME mix (climate: deserts grow oil-rich
 *     economies, grasslands grow food, forests grow wood …);
 *   - its per-cell TERRAIN mix (mountains carry iron/copper/gold/coal …);
 *   - its CITY count (a settled country works its land — tiny unsettled
 *     countries produce proportionally less).
 *
 * The weights live in economy.json (domesticBaseline) — data-driven and
 * controllable. Losing land/cities automatically reshapes the vector on
 * the next recompute (the model is the single source).
 *
 * Pure LEAF module: map model + config types + math only.
 */

import type { StrategicMapModel } from '../world/map/MapTypes';
import type { DomesticBaselineConfig, DomesticBaselineResourceDef } from './types';
import { roundTo } from '../utils/math';

/** Weighted suitability of a per-cell class mix against ONE weight map. */
function suitabilityOf(
  counts: Readonly<Record<string, number>>,
  totalCells: number,
  def: DomesticBaselineResourceDef,
  kind: 'biomes' | 'terrain'
): number {
  const neutral = kind === 'biomes' ? def.biomeNeutral : def.terrainNeutral;
  const weights = kind === 'biomes' ? def.biomes : def.terrain;
  if (weights === undefined) return neutral ?? 0.5; // class-neutral resource
  let sum = 0;
  for (const [classId, count] of Object.entries(counts)) {
    // A class missing from the map is simply absent; a class missing from
    // the weight map contributes 0 (the land genuinely does not support it).
    sum += (weights[classId] ?? 0) * count;
  }
  return sum / Math.max(1, totalCells);
}

/**
 * Monthly domestic baseline production of ONE country — derived ONLY from
 * its geography (biome/terrain mix of its own cells) and its city count.
 * Resources with zero potential (e.g. gold in flat countries) are absent
 * from the record — deposits remain their only source.
 */
export function countryBaselineProduction(
  model: StrategicMapModel,
  countryId: string,
  config: DomesticBaselineConfig
): Record<string, number> {
  const baseline: Record<string, number> = {};
  const country = model.countries[countryId];
  if (country === undefined) return baseline;

  // Per-cell class mix over the country's OWN land (ocean cells excluded).
  const biomeCounts: Record<string, number> = {};
  const terrainCounts: Record<string, number> = {};
  let landCells = 0;
  for (const cellIndex of country.cellIds) {
    if (cellIndex < 0 || cellIndex >= model.features.biomes.length) continue;
    const biome = model.features.biomes[cellIndex];
    if (biome !== 'ocean') {
      biomeCounts[biome] = (biomeCounts[biome] ?? 0) + 1;
      landCells += 1;
    }
    const terrain = model.features.terrain[cellIndex];
    if (terrain !== undefined) terrainCounts[terrain] = (terrainCounts[terrain] ?? 0) + 1;
  }
  if (landCells === 0) return baseline;

  const cityTerm =
    config.cityTermScale * Math.min(country.cityIds.length, config.cityTermMaxCities);

  for (const [resourceId, def] of Object.entries(config.resources)) {
    const biomeSuit = suitabilityOf(biomeCounts, landCells, def, 'biomes');
    const terrainSuit = suitabilityOf(terrainCounts, landCells, def, 'terrain');
    const geography = config.biomeWeight * biomeSuit + config.terrainWeight * terrainSuit;
    const amount = def.base * (cityTerm * (def.cityFactor ?? 1) + geography);
    if (amount > 0) baseline[resourceId] = roundTo(amount, 2);
  }
  return baseline;
}
