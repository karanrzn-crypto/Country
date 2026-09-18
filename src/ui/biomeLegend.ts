import type { StrategicMapModel } from '../world/map/MapTypes';
import type { MapThemeData } from '../data/types';
import {
  biomeBaseColor,
  rampGradientStops,
  rgbToHex,
  economyTintRGB,
  rgb,
  lerpColor,
  ECONOMY_CONSTRUCTION_LIGHTEN,
  type GradientStopHex
} from '../rendering/map/MapSurface';

/**
 * Map legends (biomes + elevation) — PURE data builders, no DOM.
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

/**
 * The elevation legend as ONE continuous gradient (Low → High): sampled
 * from the very same ramp function the terrain surface paints with, so the
 * bar's colors ARE the map's colors at every elevation.
 */
export interface ElevationLegendData {
  readonly stops: readonly GradientStopHex[];
  readonly lowLabel: string;
  readonly highLabel: string;
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
 * The elevation legend: ONE simple continuous gradient bar from the lowest
 * ground (blue) to the highest (red) — sampled from THE SAME central ramp
 * the terrain surface paints with (rampGradientStops → rampColorAt), so
 * legend and map are identical by construction.
 */
export function buildElevationLegend(theme: MapThemeData): ElevationLegendData {
  const legend = theme.layerColors.elevationLegend;
  return {
    stops: rampGradientStops(theme, legend.samples),
    lowLabel: legend.lowLabel,
    highLabel: legend.highLabel
  };
}

/** A config building (id + Persian name) — the economy legend's input. */
export interface EconomyLegendBuilding {
  readonly id: string;
  readonly name: string;
}

/**
 * The ECONOMY legend (spec §3) — one row per economic building (THE SAME
 * `economyTintRGB` definition the economy fill layer paints with: active
 * colors + the pale under-construction variant) plus the explicit
 * «در حال ساخت» and «بدون ساختمان اقتصادی» rows, so the player can read
 * every colored region on the map at a glance.
 */
export function buildEconomyLegend(
  buildings: readonly EconomyLegendBuilding[],
  theme: MapThemeData
): MapLegendEntry[] {
  const entries: MapLegendEntry[] = [];
  for (const building of buildings) {
    const color = economyTintRGB(building.id, false, theme);
    if (color === null) continue; // theme defines no color for this type
    entries.push({ id: building.id, label: building.name, color: rgbToHex(color) });
  }
  // The under-construction row: the pale variant of a NEUTRAL base — the
  // map shows each type's own pale color, the legend communicates the state.
  const pale = rgbToHex(lerpColor(rgb('#8a8a7a'), { r: 1, g: 1, b: 1 }, ECONOMY_CONSTRUCTION_LIGHTEN));
  entries.push({ id: 'under-construction', label: 'در حال ساخت (رنگ کم‌رنگ)', color: pale });
  entries.push({ id: 'no-building', label: 'بدون ساختمان اقتصادی', color: '#e6e1d3' });
  return entries;
}

/** CSS linear-gradient stops for the elevation bar (same sampled colors). */
export function elevationGradientCss(stops: readonly GradientStopHex[]): string {
  const parts = stops.map((stop) => `${stop.color} ${(stop.at * 100).toFixed(2)}%`);
  return `linear-gradient(to right, ${parts.join(', ')})`;
}

/** Stable signature of a legend's content (used to skip DOM rebuilds). */
export function legendSignature(entries: readonly MapLegendEntry[]): string {
  return entries.map((entry) => `${entry.id}:${entry.color}:${entry.label}`).join('|');
}

/** Stable signature of the elevation legend (gradient stops + labels). */
export function elevationLegendSignature(data: ElevationLegendData): string {
  return (
    data.stops.map((stop) => `${stop.at.toFixed(4)}:${stop.color}`).join('|') +
    `#${data.lowLabel}#${data.highLabel}`
  );
}
