import type { StrategicMapModel } from '../world/map/MapTypes';
import type { MapThemeData } from '../data/types';
import {
  biomeBaseColor,
  parseTerrainRamp,
  rampColorAt,
  rgbToHex,
  TERRAIN_LEGEND_SAMPLE
} from '../rendering/map/MapSurface';

/**
 * Map legends (biomes + terrain) — PURE data builders, no DOM.
 *
 * Both builders are fully data-driven and consume THE SAME central color
 * definitions the land-surface renderer uses (MapSurface):
 * - WHICH entries exist comes from the map model (model.features — the same
 *   State data the renderer draws);
 * - WHAT each entry looks like (color + label + order) comes from the theme
 *   (mapTheme.json) via the shared accessors — a legend swatch can never
 *   drift from what the map actually paints;
 * - the UI only renders the returned rows, so biome/terrain info is never
 *   hardcoded in UI logic.
 */
export interface MapLegendEntry {
  readonly id: string;
  readonly label: string;
  /** Exact display color — the same definition the map surface paints. */
  readonly color: string;
}

/** Present land biomes in theme legend order (missing ids append sorted). */
export function buildBiomeLegend(model: StrategicMapModel, theme: MapThemeData): MapLegendEntry[] {
  const present = new Set<string>();
  for (const biome of model.features.biomes) {
    if (biome !== 'ocean') present.add(biome);
  }
  const labels = theme.layerColors.biomeLabels as Readonly<Record<string, string>>;
  const entries: MapLegendEntry[] = [];
  const used = new Set<string>();
  for (const id of theme.layerColors.biomeLegendOrder) {
    if (!present.has(id) || used.has(id)) continue;
    used.add(id);
    // Central definition: same accessor the renderer's surface uses.
    entries.push({ id, label: labels[id] ?? id, color: rgbToHex(biomeBaseColor(theme, id)) });
  }
  // Robustness: a biome present in data but missing from the configured
  // order still gets a row — deterministic (sorted), never dropped.
  for (const id of [...present].sort()) {
    if (used.has(id)) continue;
    used.add(id);
    entries.push({ id, label: labels[id] ?? id, color: rgbToHex(biomeBaseColor(theme, id)) });
  }
  return entries;
}

/**
 * Present LAND terrain classes in theme legend order (missing ids append
 * sorted). Swatch color = the canonical elevation ramp sampled at the
 * class's representative elevation — exactly what the terrain surface
 * paints there (flat ground is unshaded, so colors match 1:1).
 */
export function buildTerrainLegend(model: StrategicMapModel, theme: MapThemeData): MapLegendEntry[] {
  const present = new Set<string>();
  const biomes = model.features.biomes;
  const terrain = model.features.terrain;
  for (let index = 0; index < terrain.length; index++) {
    if (biomes[index] === 'ocean') continue; // sea floor classes are not land terrain
    present.add(terrain[index]);
  }
  const labels = theme.layerColors.terrainLabels as Readonly<Record<string, string>>;
  const ramp = parseTerrainRamp(theme);
  const entries: MapLegendEntry[] = [];
  const used = new Set<string>();
  for (const id of theme.layerColors.terrainLegendOrder) {
    if (!present.has(id) || used.has(id)) continue;
    used.add(id);
    const sample = TERRAIN_LEGEND_SAMPLE[id as keyof typeof TERRAIN_LEGEND_SAMPLE] ?? 0.5;
    entries.push({ id, label: labels[id] ?? id, color: rgbToHex(rampColorAt(ramp, sample)) });
  }
  for (const id of [...present].sort()) {
    if (used.has(id)) continue;
    used.add(id);
    const sample = TERRAIN_LEGEND_SAMPLE[id as keyof typeof TERRAIN_LEGEND_SAMPLE] ?? 0.5;
    entries.push({ id, label: labels[id] ?? id, color: rgbToHex(rampColorAt(ramp, sample)) });
  }
  return entries;
}

/** Stable signature of a legend's content (used to skip DOM rebuilds). */
export function legendSignature(entries: readonly MapLegendEntry[]): string {
  return entries.map((entry) => `${entry.id}:${entry.color}:${entry.label}`).join('|');
}
