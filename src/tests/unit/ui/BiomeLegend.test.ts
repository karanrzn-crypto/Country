import { describe, it, expect } from 'vitest';
import { buildBiomeLegend, buildTerrainLegend, legendSignature } from '../../../ui/biomeLegend';
import { parseTerrainRamp, rampColorAt, rgbToHex, TERRAIN_LEGEND_SAMPLE } from '../../../rendering/map/MapSurface';
import { generateStrategicMap } from '../../../world/map/MapGenerator';
import { DEFAULT_MAP_CONFIG } from '../../helpers/mapTestConfig';
import themeJson from '../../../data/mapTheme.json';
import type { MapThemeData } from '../../../data/types';
import type { StrategicMapModel } from '../../../world/map/MapTypes';

const theme = themeJson as unknown as MapThemeData;
const { model } = generateStrategicMap(DEFAULT_MAP_CONFIG);

/** Minimal synthetic model for legend filtering cases. */
function modelWithBiomes(biomes: readonly string[]): StrategicMapModel {
  const features = {
    ...model.features,
    biomes
  } as unknown as StrategicMapModel['features'];
  return { ...model, features } as StrategicMapModel;
}

/**
 * Map legends: fully data-driven — only entries present in the map model get
 * a row; labels/colors/order come from the theme (mapTheme.json) through the
 * SAME central accessors the land surface paints with, so a legend swatch is
 * by construction the color the map shows.
 */
describe('biome legend builder', () => {
  it('lists only biomes present in the current map data', () => {
    const entries = buildBiomeLegend(model, theme);
    const present = new Set<string>(model.features.biomes);
    present.delete('ocean'); // ocean is water, not a legend biome
    expect(entries.length).toBe(present.size);
    for (const entry of entries) expect(present.has(entry.id)).toBe(true);
  });

  it('every entry color is the EXACT theme base color the map paints', () => {
    const palette = theme.layerColors.biomes as Record<string, string>;
    for (const entry of buildBiomeLegend(model, theme)) {
      // Legend color flows through the central accessor + exact sRGB roundtrip.
      expect(entry.color).toBe(palette[entry.id]);
    }
  });

  it('labels come from the theme, never hardcoded in UI', () => {
    const labels = theme.layerColors.biomeLabels as Record<string, string>;
    for (const entry of buildBiomeLegend(model, theme)) {
      expect(entry.label).toBe(labels[entry.id] ?? entry.id);
    }
  });

  it('follows the configured legend order', () => {
    const entries = buildBiomeLegend(model, theme);
    const order = theme.layerColors.biomeLegendOrder;
    const indexes = entries.map((entry) => order.indexOf(entry.id));
    const sorted = [...indexes].sort((a, b) => a - b);
    expect(indexes).toEqual(sorted);
  });

  it('filters out biomes absent from the data (synthetic model)', () => {
    const synthetic = modelWithBiomes(['ocean', 'ocean', 'forest', 'forest', 'desert']);
    const entries = buildBiomeLegend(synthetic, theme);
    expect(entries.map((entry) => entry.id)).toEqual(['forest', 'desert']); // theme order
  });

  it('appends data biomes missing from the configured order (deterministic)', () => {
    const partialTheme = {
      ...theme,
      layerColors: {
        ...theme.layerColors,
        biomeLegendOrder: ['forest']
      }
    } as unknown as MapThemeData;
    const synthetic = modelWithBiomes(['ocean', 'jungle', 'forest']);
    const entries = buildBiomeLegend(synthetic, partialTheme);
    expect(entries.map((entry) => entry.id)).toEqual(['forest', 'jungle']); // ordered first, then sorted append
  });

  it('signature changes when content changes (DOM rebuild gate)', () => {
    const a = modelWithBiomes(['ocean', 'forest']);
    const b = modelWithBiomes(['ocean', 'forest', 'desert']);
    const signatureA = legendSignature(buildBiomeLegend(a, theme));
    const signatureB = legendSignature(buildBiomeLegend(b, theme));
    expect(signatureA).not.toBe(signatureB);
    expect(signatureA).toBe(legendSignature(buildBiomeLegend(a, theme)));
  });
});

describe('terrain legend builder', () => {
  it('lists only terrain classes present on LAND cells of the model', () => {
    const entries = buildTerrainLegend(model, theme);
    const present = new Set<string>();
    for (let i = 0; i < model.features.terrain.length; i++) {
      if (model.features.biomes[i] === 'ocean') continue;
      present.add(model.features.terrain[i]);
    }
    expect(entries.length).toBe(present.size);
    for (const entry of entries) expect(present.has(entry.id)).toBe(true);
  });

  it('swatch color = the canonical ramp sampled at the class representative', () => {
    const ramp = parseTerrainRamp(theme);
    for (const entry of buildTerrainLegend(model, theme)) {
      const sample = TERRAIN_LEGEND_SAMPLE[entry.id as keyof typeof TERRAIN_LEGEND_SAMPLE] ?? 0.5;
      expect(entry.color).toBe(rgbToHex(rampColorAt(ramp, sample)));
    }
  });

  it('low ground swatch is distinct from high mountain swatch (relief readable)', () => {
    const entries = buildTerrainLegend(model, theme);
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const low = byId.get('lowland');
    const high = byId.get('highMountain');
    expect(low).toBeDefined();
    expect(high).toBeDefined();
    expect(low?.color.toLowerCase()).not.toBe(high?.color.toLowerCase());
  });

  it('labels come from the theme terrainLabels', () => {
    const labels = theme.layerColors.terrainLabels as Record<string, string>;
    for (const entry of buildTerrainLegend(model, theme)) {
      expect(entry.label).toBe(labels[entry.id] ?? entry.id);
    }
  });
});
