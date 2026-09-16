import { describe, it, expect } from 'vitest';
import { buildBiomeLegend, buildElevationLegend, elevationGradientCss, elevationLegendSignature, legendSignature } from '../../../ui/biomeLegend';
import type { ElevationLegendData } from '../../../ui/biomeLegend';
import { parseTerrainRamp, rampColorAt, rgbToHex, rgb } from '../../../rendering/map/MapSurface';
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

describe('elevation legend builder (one continuous gradient, same color source)', () => {
  it('gradient stops are sampled from THE SAME canonical ramp the map paints', () => {
    const data = buildElevationLegend(theme);
    const ramp = parseTerrainRamp(theme);
    expect(data.stops.length).toBe(theme.layerColors.elevationLegend.samples);
    expect(data.stops[0].at).toBe(0);
    expect(data.stops[data.stops.length - 1].at).toBe(1);
    for (const stop of data.stops) {
      // Legend color flows through the SAME rampColorAt the surface paints.
      expect(stop.color).toBe(rgbToHex(rampColorAt(ramp, stop.at)));
    }
  });

  it('the bar spans blue (Low) → red (High) continuously', () => {
    const data = buildElevationLegend(theme);
    const first = rgb(data.stops[0].color);
    const last = rgb(data.stops[data.stops.length - 1].color);
    expect(first.b).toBeGreaterThan(first.r); // blue low end
    expect(last.r).toBeGreaterThan(last.b); // red high end
    for (let i = 1; i < data.stops.length; i++) {
      expect(data.stops[i].at).toBeGreaterThan(data.stops[i - 1].at);
    }
  });

  it('labels come from the theme', () => {
    const data = buildElevationLegend(theme);
    expect(data.lowLabel).toBe(theme.layerColors.elevationLegend.lowLabel);
    expect(data.highLabel).toBe(theme.layerColors.elevationLegend.highLabel);
  });

  it('CSS gradient is built from the sampled stop colors', () => {
    const data = buildElevationLegend(theme);
    const css = elevationGradientCss(data.stops);
    expect(css.startsWith('linear-gradient(to right,')).toBe(true);
    for (const stop of [data.stops[0], data.stops[data.stops.length - 1]]) {
      expect(css).toContain(`${stop.color} ${(stop.at * 100).toFixed(2)}%`);
    }
  });

  it('signature covers stops and labels (DOM rebuild gate)', () => {
    const data = buildElevationLegend(theme);
    expect(elevationLegendSignature(data)).toBe(elevationLegendSignature(data));
    const changed: ElevationLegendData = {
      ...data,
      lowLabel: 'Bottom'
    };
    expect(elevationLegendSignature(changed)).not.toBe(elevationLegendSignature(data));
  });
});
