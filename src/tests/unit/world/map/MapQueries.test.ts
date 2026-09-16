import { describe, it, expect } from 'vitest';
import { generateStrategicMap } from '../../../../world/map/MapGenerator';
import { DEFAULT_MAP_CONFIG } from '../../../helpers/mapTestConfig';
import {
  pointInRing,
  pickAt,
  clampCamera,
  countryAt,
  provinceAt,
  distanceToRing
} from '../../../../world/map/MapQueries';

describe('MapQueries (pure geometry, renderer-free)', () => {
  const { model } = generateStrategicMap(DEFAULT_MAP_CONFIG);

  it('pointInRing classifies inside/outside/boundary correctly', () => {
    const square = [
      { x: 0, z: 0 },
      { x: 10, z: 0 },
      { x: 10, z: 10 },
      { x: 0, z: 10 }
    ];
    expect(pointInRing({ x: 5, z: 5 }, square)).toBe(true);
    expect(pointInRing({ x: 15, z: 5 }, square)).toBe(false);
    expect(pointInRing({ x: -5, z: -5 }, square)).toBe(false);
    // Boundary counts as inside.
    expect(pointInRing({ x: 0, z: 5 }, square)).toBe(true);
  });

  it('every country label point resolves via countryAt', () => {
    for (const countryId of model.countryOrder) {
      const country = model.countries[countryId];
      expect(countryAt(model, country.labelPoint)).toBe(countryId);
    }
  });

  it('every province label point resolves via provinceAt and countryAt', () => {
    for (const province of Object.values(model.provinces)) {
      expect(provinceAt(model, province.labelPoint)).toBe(province.id);
      expect(countryAt(model, province.labelPoint)).toBe(province.countryId);
    }
  });

  it('pickAt prioritizes city → province → country', () => {
    // Find an isolated city (nearest other city is far away) for exact hits.
    const cities = Object.values(model.cities);
    const isolated = cities.find((city) =>
      cities.every(
        (other) =>
          other.id === city.id ||
          Math.hypot(other.position.x - city.position.x, other.position.z - city.position.z) > 4
      )
    );
    expect(isolated).toBeDefined();
    const city = isolated as (typeof cities)[number];

    // Exact position hits the city and cascades up the hierarchy.
    const cityPick = pickAt(model, city.position, 1.5);
    expect(cityPick.cityId).toBe(city.id);
    expect(cityPick.provinceId).toBe(city.provinceId);
    expect(cityPick.countryId).toBe(city.countryId);

    // Ocean: outside every country.
    const oceanPoint = { x: model.bounds.minX - 50, z: model.bounds.minZ - 50 };
    const oceanPick = pickAt(model, oceanPoint, 2);
    expect(oceanPick).toEqual({ cityId: null, provinceId: null, countryId: null });
  });

  it('pick radius pulls nearby cities to the cursor', () => {
    const cities = Object.values(model.cities);
    const isolated = cities.find((city) =>
      cities.every(
        (other) =>
          other.id === city.id ||
          Math.hypot(other.position.x - city.position.x, other.position.z - city.position.z) > 6
      )
    );
    expect(isolated).toBeDefined();
    const city = isolated as (typeof cities)[number];
    const offset = { x: city.position.x + 1.5, z: city.position.z };
    const pick = pickAt(model, offset, 3);
    expect(pick.cityId).toBe(city.id);
    const miss = pickAt(model, offset, 0.5);
    expect(miss.cityId).toBeNull();
  });

  it('clampCamera keeps zoom within bounds and the view on the map', () => {
    const bounds = model.bounds;
    const view = { x: 10_000, z: -10_000, viewHeight: 1, aspect: 1.6 };
    const clamped = clampCamera(view, bounds, 26, 260);
    expect(clamped.viewHeight).toBe(26); // zoom-in clamp
    expect(clamped.x).toBeGreaterThanOrEqual(bounds.minX - 100);
    expect(clamped.x).toBeLessThanOrEqual(bounds.maxX + 100);
    expect(clamped.z).toBeGreaterThanOrEqual(bounds.minZ - 100);
    expect(clamped.z).toBeLessThanOrEqual(bounds.maxZ + 100);

    const tooFar = clampCamera({ x: 150, z: 100, viewHeight: 10_000, aspect: 1.6 }, bounds, 26, 260);
    expect(tooFar.viewHeight).toBe(260); // zoom-out clamp

    // Center stays on the map (small margin allowed at tight zoom).
    const inside = clampCamera({ x: -999, z: 999, viewHeight: 40, aspect: 1.6 }, bounds, 26, 260);
    expect(inside.x).toBeGreaterThan(bounds.minX - 5);
    expect(inside.x).toBeLessThan(bounds.maxX + 5);
    expect(inside.z).toBeGreaterThan(bounds.minZ - 5);
    expect(inside.z).toBeLessThan(bounds.maxZ + 5);
  });

  it('clampCamera progressively re-centers as the view zooms out', () => {
    const bounds = { minX: 0, minZ: 0, maxX: 300, maxZ: 200 };
    // Near zoom: no pull — the cursor keeps full control.
    const near = clampCamera({ x: 40, z: 40, viewHeight: 40, aspect: 1.6 }, bounds, 26, 260);
    expect(near.x).toBeCloseTo(40, 5);
    // Fully zoomed out: the map is always framed (no corner fling possible).
    const far = clampCamera({ x: 470, z: 20, viewHeight: 260, aspect: 1.6 }, bounds, 26, 260);
    expect(far.x).toBeCloseTo(150, 0);
    expect(far.z).toBeCloseTo(100, 0);
    // Mid zoom-out: partial pull between the clamped position and the center.
    const mid = clampCamera({ x: 200, z: 60, viewHeight: 200, aspect: 1.6 }, bounds, 26, 260);
    expect(mid.x).toBeGreaterThan(150);
    expect(mid.x).toBeLessThan(200);
  });

  it('distanceToRing measures from a point to the polygon outline', () => {
    const square = [
      { x: 0, z: 0 },
      { x: 10, z: 0 },
      { x: 10, z: 10 },
      { x: 0, z: 10 }
    ];
    expect(distanceToRing({ x: 5, z: 5 }, square)).toBeCloseTo(5, 6);
    expect(distanceToRing({ x: 5, z: 12 }, square)).toBeCloseTo(2, 6);
    expect(distanceToRing({ x: -3, z: 5 }, square)).toBeCloseTo(3, 6);
  });
});
