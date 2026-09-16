import { describe, it, expect } from 'vitest';
import { buildBiomeLegend, biomeLegendSignature } from '../../../ui/biomeLegend';
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
 * Biome legend (Part 4): fully data-driven — only biomes present in the map
 * model get a row; labels/colors/order come from the theme (mapTheme.json);
 * swatch colors are EXACTLY the base colors the biome fill uses on the map.
 */
describe('biome legend builder', () => {
  it('lists only biomes present in the current map data', () => {
    const entries = buildBiomeLegend(model, theme);
    const present = new Set<string>(model.features.biomes);
    present.delete('ocean'); // ocean is water, not a legend biome
    expect(entries.length).toBe(present.size);
    for (const entry of entries) expect(present.has(entry.id)).toBe(true);
  });

  it('every entry color comes from the theme (exact match with the map)', () => {
    const palette = theme.layerColors.biomes as Record<string, string>;
    for (const entry of buildBiomeLegend(model, theme)) {
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
    const signatureA = biomeLegendSignature(buildBiomeLegend(a, theme));
    const signatureB = biomeLegendSignature(buildBiomeLegend(b, theme));
    expect(signatureA).not.toBe(signatureB);
    expect(signatureA).toBe(biomeLegendSignature(buildBiomeLegend(a, theme)));
  });
});
