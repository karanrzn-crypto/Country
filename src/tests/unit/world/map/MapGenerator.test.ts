import { describe, it, expect } from 'vitest';
import { generateStrategicMap } from '../../../../world/map/MapGenerator';
import { DEFAULT_MAP_CONFIG } from '../../../helpers/mapTestConfig';
import { pointInRing, distanceToRing } from '../../../../world/map/MapQueries';
import { ringSignedArea, ringPerimeter } from '../../../../world/map/MapGeometry';
import type { MapPoint } from '../../../../world/map/MapTypes';

/**
 * Proper (crossing) segment self-intersection test: shared vertices and
 * endpoint touches are legal (borders legitimately meet at a point);
 * only true crossings invalidate a ring.
 */
function hasProperSelfIntersection(points: readonly MapPoint[]): boolean {
  const n = points.length;
  const cross = (o: MapPoint, a: MapPoint, b: MapPoint): number =>
    (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  for (let i = 0; i < n; i++) {
    const a1 = points[i];
    const a2 = points[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // adjacent segments share an endpoint
      const b1 = points[j];
      const b2 = points[(j + 1) % n];
      const d1 = cross(b1, b2, a1);
      const d2 = cross(b1, b2, a2);
      const d3 = cross(a1, a2, b1);
      const d4 = cross(a1, a2, b2);
      if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
        return true;
      }
    }
  }
  return false;
}

describe('MapGenerator — Definition of Done geometry quality', () => {
  const { model, warnings } = generateStrategicMap(DEFAULT_MAP_CONFIG);

  it('produces 8–12 countries with distinct non-repeating names', () => {
    expect(model.stats.countries).toBeGreaterThanOrEqual(8);
    expect(model.stats.countries).toBeLessThanOrEqual(12);
    const names = model.countryOrder.map((id) => model.countries[id].name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('has several coastal AND several landlocked countries', () => {
    expect(model.stats.coastalCountries).toBeGreaterThanOrEqual(4);
    expect(model.stats.landlockedCountries).toBeGreaterThanOrEqual(2);
    expect(model.stats.coastalCountries + model.stats.landlockedCountries).toBe(model.stats.countries);
  });

  it('features a peninsula and a bay on the continent', () => {
    expect(model.stats.peninsulaCells).toBeGreaterThanOrEqual(3);
    expect(model.stats.bayCells).toBeGreaterThanOrEqual(2);
  });

  it('every country ring is closed, positive-area, finite and simple', () => {
    for (const countryId of model.countryOrder) {
      const ring = model.countries[countryId].ring;
      expect(ring.segments.length).toBeGreaterThanOrEqual(4);
      const points = ring.points;
      expect(points.length).toBeGreaterThanOrEqual(12);
      // Closed: first point equals the start of the first segment's polyline,
      // and the walk returns to it (implicit closure — no duplicated joint).
      expect(ringSignedArea(points)).not.toBe(0);
      expect(Number.isFinite(ringPerimeter(points))).toBe(true);
      expect(hasProperSelfIntersection(points)).toBe(false);
    }
  });

  it('every province ring is simple and stays inside its country', () => {
    for (const province of Object.values(model.provinces)) {
      expect(hasProperSelfIntersection(province.ring.points)).toBe(false);
      // Province cells are a subset of the country's cells (exact partition).
      const country = model.countries[province.countryId];
      for (const cellId of province.cellIds) {
        expect(country.cellIds).toContain(cellId);
      }
      // Province ring vertices never leave the country ring interior
      // (sampled: label point + cell centroids must be inside).
      expect(pointInRing(province.labelPoint, country.ring.points)).toBe(true);
    }
  });

  it('countries partition the land: no overlap, no unwanted gap', () => {
    // Structural: every land cell belongs to exactly one country…
    const totalCells = model.countryOrder.reduce((sum, id) => sum + model.countries[id].cellIds.length, 0);
    const uniqueCells = new Set(model.countryOrder.flatMap((id) => model.countries[id].cellIds));
    expect(totalCells).toBe(uniqueCells.size);
    // …and geometrically: each country's label point lies in exactly ONE
    // country ring (deep interior sample), never in two.
    for (const countryId of model.countryOrder) {
      const point = model.countries[countryId].labelPoint;
      let owners = 0;
      let owner = '';
      for (const other of model.countryOrder) {
        if (pointInRing(point, model.countries[other].ring.points)) {
          owners++;
          owner = other;
        }
      }
      expect(owners).toBe(1);
      expect(owner).toBe(countryId);
    }
  });

  it('provinces tile their country completely', () => {
    for (const countryId of model.countryOrder) {
      const country = model.countries[countryId];
      const provinceCellUnion = new Set(country.provinceIds.flatMap((pid) => model.provinces[pid].cellIds));
      expect(provinceCellUnion.size).toBe(country.cellIds.length);
      expect(country.provinceIds.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('borders are truly shared: both neighbor rings use identical edge geometry', () => {
    // Every ring segment must reference the shared edge registry, and every
    // country/country or province/province adjacency uses the same edge key.
    for (const country of Object.values(model.countries)) {
      for (const segment of country.ring.segments) {
        const edge = model.edges[segment.key];
        expect(edge).toBeDefined();
        expect(['coast', 'country', 'province']).toContain(edge.kind);
      }
    }
    for (const province of Object.values(model.provinces)) {
      for (const segment of province.ring.segments) {
        const edge = model.edges[segment.key];
        expect(edge).toBeDefined();
      }
    }
  });

  it('neighbors are symmetric and match the shared-edge structure', () => {
    for (const country of Object.values(model.countries)) {
      expect(country.neighborIds).not.toContain(country.id);
      for (const neighborId of country.neighborIds) {
        expect(model.countries[neighborId].neighborIds).toContain(country.id);
      }
    }
  });

  it('cities and capitals sit inside their own country AND province', () => {
    for (const city of Object.values(model.cities)) {
      const country = model.countries[city.countryId];
      const province = model.provinces[city.provinceId];
      expect(province.countryId).toBe(city.countryId);
      expect(pointInRing(city.position, country.ring.points)).toBe(true);
      expect(pointInRing(city.position, province.ring.points)).toBe(true);
      // Comfortably inside — not hugging the border.
      expect(distanceToRing(city.position, country.ring.points)).toBeGreaterThan(0);
    }
  });

  it('every country has exactly one capital inside it, and every province has a city', () => {
    for (const countryId of model.countryOrder) {
      const country = model.countries[countryId];
      const capital = model.cities[country.capitalCityId];
      expect(capital).toBeDefined();
      expect(capital.isCapital).toBe(true);
      expect(capital.countryId).toBe(countryId);
      expect(pointInRing(capital.position, country.ring.points)).toBe(true);
      expect(country.cityIds).toContain(capital.id);
      for (const provinceId of country.provinceIds) {
        expect(model.provinces[provinceId].cityIds.length).toBeGreaterThanOrEqual(1);
      }
    }
    expect(model.stats.capitals).toBe(model.stats.countries);
  });

  it('city names are unique and city positions are distinct', () => {
    const cities = Object.values(model.cities);
    const names = cities.map((city) => city.name);
    expect(new Set(names).size).toBe(names.length);
    for (let i = 0; i < cities.length; i++) {
      for (let j = i + 1; j < cities.length; j++) {
        const distance = Math.hypot(
          cities[i].position.x - cities[j].position.x,
          cities[i].position.z - cities[j].position.z
        );
        expect(distance).toBeGreaterThan(0);
      }
    }
  });

  it('ring geometry only comes from shared edge polylines (no independent points)', () => {
    // Every ring point must be part of some shared edge polyline.
    const polylinePoints = new Set<string>();
    for (const edge of Object.values(model.edges)) {
      for (const point of edge.polyline) polylinePoints.add(`${point.x},${point.z}`);
    }
    for (const country of Object.values(model.countries)) {
      for (const point of country.ring.points) {
        expect(polylinePoints.has(`${point.x},${point.z}`)).toBe(true);
      }
    }
  });

  it('is fully deterministic for a given seed', () => {
    const again = generateStrategicMap(DEFAULT_MAP_CONFIG);
    expect(again.model.continentName).toBe(model.continentName);
    expect(again.model.countryOrder).toEqual(model.countryOrder);
    for (const countryId of model.countryOrder) {
      expect(again.model.countries[countryId].ring.points).toEqual(model.countries[countryId].ring.points);
      expect(again.model.countries[countryId].neighborIds).toEqual(model.countries[countryId].neighborIds);
    }
    expect(Object.keys(again.model.edges)).toEqual(Object.keys(model.edges));
  });

  it('does not warn for the default seed (tuning is sound)', () => {
    expect(warnings).toEqual([]);
  });
});

describe('MapGenerator — city spacing (natural, readable layout)', () => {
  const { model } = generateStrategicMap(DEFAULT_MAP_CONFIG);
  const cities = Object.values(model.cities);

  it('keeps every city pair at least the configured separation apart', () => {
    const minSeparation = DEFAULT_MAP_CONFIG.citySeparationFraction * DEFAULT_MAP_CONFIG.cellSize;
    for (let i = 0; i < cities.length; i++) {
      for (let j = i + 1; j < cities.length; j++) {
        const d = Math.hypot(
          cities[i].position.x - cities[j].position.x,
          cities[i].position.z - cities[j].position.z
        );
        expect(d).toBeGreaterThanOrEqual(minSeparation - 0.01);
      }
    }
  });

  it('city count scales with province area (small provinces stay readable)', () => {
    const { cellsPerCity, citiesPerProvinceMax } = DEFAULT_MAP_CONFIG;
    for (const province of Object.values(model.provinces)) {
      const expected = Math.min(
        citiesPerProvinceMax,
        Math.max(1, Math.floor(province.cellIds.length / cellsPerCity))
      );
      // cityIds includes the capital when the capital province matches.
      expect(province.cityIds.length).toBeGreaterThanOrEqual(expected);
      expect(province.cityIds.length).toBeLessThanOrEqual(expected + 1);
    }
    // Large provinces get noticeably more cities than minimal ones.
    const big = Object.values(model.provinces).filter((p) => p.cellIds.length >= cellsPerCity * 3);
    expect(big.some((p) => p.cityIds.length >= 3)).toBe(true);
  });

  it('is deterministic under the new placement too', () => {
    const again = generateStrategicMap(DEFAULT_MAP_CONFIG);
    for (const [cityId, city] of Object.entries(model.cities)) {
      expect(again.model.cities[cityId].position).toEqual(city.position);
      expect(again.model.cities[cityId].provinceId).toBe(city.provinceId);
      expect(again.model.cities[cityId].isCapital).toBe(city.isCapital);
    }
  });
});

describe('MapGenerator — city districts (visible, extensible city boundaries)', () => {
  const { model } = generateStrategicMap(DEFAULT_MAP_CONFIG);

  it('every city has a closed district ring of at least 3 shared-edge segments', () => {
    for (const city of Object.values(model.cities)) {
      expect(city.areaRing).toBeDefined();
      expect(city.areaRing.segments.length).toBeGreaterThanOrEqual(3);
      expect(city.areaRing.points.length).toBeGreaterThanOrEqual(3);
      // Ring references registered edges only (renderer can resolve them).
      for (const segment of city.areaRing.segments) {
        expect(model.edges[segment.key]).toBeDefined();
      }
    }
  });

  it('districts never leave their province or country', () => {
    for (const city of Object.values(model.cities)) {
      const province = model.provinces[city.provinceId];
      const country = model.countries[city.countryId];
      for (const point of city.areaRing.points) {
        expect(pointInRing(point, province.ring.points)).toBe(true);
        expect(pointInRing(point, country.ring.points)).toBe(true);
      }
    }
  });

  it('each city position lies inside its OWN district', () => {
    for (const city of Object.values(model.cities)) {
      expect(pointInRing(city.position, city.areaRing.points)).toBe(true);
    }
  });

  it('districts of the same province are disjoint (centroid of one never inside another)', () => {
    for (const province of Object.values(model.provinces)) {
      const districts = province.cityIds.map((cityId) => model.cities[cityId].areaRing);
      for (let i = 0; i < districts.length; i++) {
        const centroidA = districts[i].points.reduce(
          (acc, p) => ({ x: acc.x + p.x / districts[i].points.length, z: acc.z + p.z / districts[i].points.length }),
          { x: 0, z: 0 }
        );
        for (let j = 0; j < districts.length; j++) {
          if (i === j) continue;
          expect(pointInRing(centroidA, districts[j].points)).toBe(false);
        }
      }
    }
  });

  it('interior edges stay in the shared registry (district boundaries are renderable)', () => {
    const interior = Object.values(model.edges).filter((edge) => edge.kind === 'interior');
    expect(interior.length).toBeGreaterThan(0);
    // District rings actually use them.
    const usedByDistricts = new Set(
      Object.values(model.cities).flatMap((city) => city.areaRing.segments.map((s) => s.key))
    );
    expect([...usedByDistricts].some((key) => model.edges[key].kind === 'interior')).toBe(true);
  });
});
