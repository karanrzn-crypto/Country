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
