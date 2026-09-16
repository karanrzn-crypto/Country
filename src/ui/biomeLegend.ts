import type { StrategicMapModel } from '../world/map/MapTypes';
import type { MapThemeData } from '../data/types';

/**
 * Biome legend (Part 4) — a PURE data builder, no DOM.
 *
 * The legend is fully data-driven:
 * - WHICH biomes exist comes from the map model (model.features.biomes — the
 *   same State data the renderer draws);
 * - WHAT each entry looks like (color + label + order) comes from the theme
 *   (mapTheme.json);
 * - the UI only renders the returned rows, so biome info is never hardcoded
 *   in UI logic.
 */
export interface BiomeLegendEntry {
  readonly id: string;
  readonly label: string;
  /** Exact theme hex — the same base color the biome fill uses on the map. */
  readonly color: string;
}

/** Present land biomes in theme legend order (missing ids append sorted). */
export function buildBiomeLegend(model: StrategicMapModel, theme: MapThemeData): BiomeLegendEntry[] {
  const present = new Set<string>();
  for (const biome of model.features.biomes) {
    if (biome !== 'ocean') present.add(biome);
  }
  const palette = theme.layerColors.biomes as Readonly<Record<string, string>>;
  const labels = theme.layerColors.biomeLabels as Readonly<Record<string, string>>;
  const entries: BiomeLegendEntry[] = [];
  const used = new Set<string>();
  for (const id of theme.layerColors.biomeLegendOrder) {
    if (!present.has(id) || used.has(id)) continue;
    used.add(id);
    entries.push({ id, label: labels[id] ?? id, color: palette[id] ?? '#808080' });
  }
  // Robustness: a biome present in data but missing from the configured
  // order still gets a row — deterministic (sorted), never dropped.
  for (const id of [...present].sort()) {
    if (used.has(id)) continue;
    used.add(id);
    entries.push({ id, label: labels[id] ?? id, color: palette[id] ?? '#808080' });
  }
  return entries;
}

/** Stable signature of a legend's content (used to skip DOM rebuilds). */
export function biomeLegendSignature(entries: readonly BiomeLegendEntry[]): string {
  return entries.map((entry) => `${entry.id}:${entry.color}:${entry.label}`).join('|');
}
