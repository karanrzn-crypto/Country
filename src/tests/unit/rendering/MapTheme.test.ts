import { describe, it, expect } from 'vitest';
import mapThemeJson from '../../../data/mapTheme.json';
import type { MapThemeData } from '../../../data/types';
import {
  MAP_LAYER_ORDER,
  DEFAULT_LAYER_VISIBILITY,
  isKnownMapLayer
} from '../../../world/map/MapLayers';

const theme = mapThemeJson as unknown as MapThemeData;

/**
 * Readability + layer-registry contract for the strategic map:
 * - city/country labels must be big enough to READ during gameplay;
 * - the city-district boundary must be a first-class toggleable layer that
 *   renders BETWEEN province and country borders (never confused with them).
 */
describe('map theme readability floors', () => {
  it('label tiers meet readable screen sizes', () => {
    expect(theme.labels.tiers.country.screenPx).toBeGreaterThanOrEqual(18);
    expect(theme.labels.tiers.capital.screenPx).toBeGreaterThanOrEqual(15);
    expect(theme.labels.tiers.province.screenPx).toBeGreaterThanOrEqual(12);
    expect(theme.labels.tiers.majorCity.screenPx).toBeGreaterThanOrEqual(12);
    expect(theme.labels.tiers.city.screenPx).toBeGreaterThanOrEqual(12);
  });

  it('city labels appear early enough to matter (not only at maximum zoom)', () => {
    expect(theme.labels.tiers.city.maxViewHeight).toBeGreaterThanOrEqual(110);
    expect(theme.labels.tiers.capital.maxViewHeight).toBeGreaterThanOrEqual(280);
  });

  it('markers are visible at strategic zoom levels', () => {
    expect(theme.cityRadius).toBeGreaterThanOrEqual(1);
    expect(theme.capitalRadius).toBeGreaterThan(theme.cityRadius);
  });

  it('has city-district styling that is clearly NOT a country border', () => {
    expect(theme.cityAreaStroke).toBeDefined();
    expect(theme.cityAreaOpacity).toBeGreaterThan(0);
    expect(theme.cityAreaOpacity).toBeLessThanOrEqual(0.8);
    expect(theme.cityAreaStroke.toLowerCase()).not.toBe(theme.countryBorderStroke.toLowerCase());
  });
});

describe('map layer registry', () => {
  it('includes the cityAreas layer in a sane render position', () => {
    const provinceIndex = MAP_LAYER_ORDER.indexOf('provinceBorders');
    const cityAreaIndex = MAP_LAYER_ORDER.indexOf('cityAreas');
    const countryIndex = MAP_LAYER_ORDER.indexOf('countryBorders');
    expect(cityAreaIndex).toBeGreaterThan(provinceIndex);
    expect(cityAreaIndex).toBeLessThan(countryIndex);
  });

  it('has default visibility for every registered layer', () => {
    for (const layerId of MAP_LAYER_ORDER) {
      expect(DEFAULT_LAYER_VISIBILITY[layerId]).toBe(true);
      expect(isKnownMapLayer(layerId)).toBe(true);
    }
  });
});
