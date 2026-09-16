/**
 * City Areas generator (Phase 2) — builds the spatial network from the
 * strategic-map geography, deterministically per seed.
 *
 * Topology produced per city (matching the spec's City A → Suburban →
 * Junction → Industrial → City B pattern):
 *  - one `urban_core` at the city position (footprint: inset city ring),
 *  - tier-dependent districts (residential/commercial/industrial/suburban)
 *    around the core, INSIDE the city ring,
 *  - one `agricultural` area on the farthest dry province cell (rural
 *    hinterland, connected to the core),
 *  - for every road line between two cities: a `junction` at the polyline
 *    midpoint with links halves — suburban/commercial district → junction —
 *    so inter-city routes pass through junction nodes, never city→city only,
 *  - railway lines connect the two city CORES directly (separate network
 *    kind, ready for future stations and capacity).
 *
 * Geometry sources: ONLY shared map geometry (city.areaRing, line polylines,
 * lattice quads) — no hand-tuned points. Deterministic: same model, same
 * network.
 */

import type { StrategicMapModel, MapPoint, MapRing } from '../map/MapTypes';
import { latticeQuad } from '../map/MapQueries';
import type { CityArea, CityAreaLink, CityAreaNetwork, CityAreaType } from './CityAreaTypes';

export interface CityAreaGenerationResult {
  network: CityAreaNetwork;
  warnings: readonly string[];
}

const DISTRICTS_BY_TIER: Readonly<Record<string, readonly CityAreaType[]>> = {
  capital: ['residential', 'commercial', 'industrial'],
  major: ['residential', 'commercial', 'industrial'],
  medium: ['residential', 'industrial'],
  small: ['residential', 'suburban'],
  settlement: ['suburban']
};

const DISTRICT_LABELS: Readonly<Record<CityAreaType, string>> = {
  urban_core: 'Core',
  residential: 'Residential',
  commercial: 'Commercial',
  industrial: 'Industrial',
  suburban: 'Suburbs',
  agricultural: 'Farmlands',
  junction: 'Junction',
  port_area: 'Harbor'
};

/** District anchor directions (unit circle, deterministic spread). */
const DISTRICT_DIRECTIONS: readonly MapPoint[] = [
  { x: 0.94, z: 0.34 },
  { x: -0.58, z: 0.81 },
  { x: -0.0, z: -1.0 }
];

/** Mean distance from the ring centroid to its points (radius proxy). */
function ringRadius(points: readonly MapPoint[], center: MapPoint): number {
  if (points.length === 0) return 0;
  let sum = 0;
  for (const point of points) {
    sum += Math.hypot(point.x - center.x, point.z - center.z);
  }
  return sum / points.length;
}

export function polygonCentroid(points: readonly MapPoint[]): MapPoint {
  if (points.length === 0) return { x: 0, z: 0 };
  let x = 0;
  let z = 0;
  for (const point of points) {
    x += point.x;
    z += point.z;
  }
  return { x: x / points.length, z: z / points.length };
}

/** Scales a polygon toward `center` (inset approximation). */
function insetPolygon(points: readonly MapPoint[], center: MapPoint, factor: number): MapPoint[] {
  return points.map((point) => ({
    x: center.x + (point.x - center.x) * factor,
    z: center.z + (point.z - center.z) * factor
  }));
}

/** Scaled polygon translated so its centroid sits at `anchor`. */
function shiftedPolygon(points: readonly MapPoint[], anchor: MapPoint, factor: number): MapPoint[] {
  // Scale around the ring centroid, then translate the centroid to the anchor.
  const center = polygonCentroid(points);
  const inner = insetPolygon(points, center, factor);
  const innerCenter = polygonCentroid(inner);
  const dx = anchor.x - innerCenter.x;
  const dz = anchor.z - innerCenter.z;
  return inner.map((point) => ({ x: point.x + dx, z: point.z + dz }));
}

function polylineLength(points: readonly MapPoint[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i += 1) {
    length += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  }
  return length;
}

function areaName(cityName: string, type: CityAreaType): string {
  return `${cityName} ${DISTRICT_LABELS[type]}`;
}

/** Collects water cells (lakes + river centerlines) for dry-cell selection. */
function collectWaterCells(model: StrategicMapModel): Set<number> {
  const water = new Set<number>();
  for (const lake of model.features.lakes) {
    for (const cell of lake.cells) water.add(cell);
  }
  for (const river of model.features.rivers) {
    for (const cell of river.cells) water.add(cell);
  }
  return water;
}

/** Builds the complete City Areas network for the map (columns = cell grid stride). */
export function buildCityAreaNetwork(model: StrategicMapModel, columns: number): CityAreaGenerationResult {
  const warnings: string[] = [];
  const areas: Record<string, CityArea> = {};
  const links: Record<string, CityAreaLink> = {};
  const waterCells = collectWaterCells(model);
  // Visual spacing only (junction footprint size) — geometry truth comes
  // from the shared lattice, never from this approximation.
  const spacing = model.lattice.length > 1 ? Math.abs(model.lattice[1].x - model.lattice[0].x) || 1 : 1;

  const addArea = (area: CityArea): void => {
    if (areas[area.id] !== undefined) {
      warnings.push(`duplicate area id "${area.id}" — skipped`);
      return;
    }
    areas[area.id] = area;
  };

  const addLink = (
    id: string,
    kind: CityAreaLink['kind'],
    a: string,
    b: string,
    path: readonly MapPoint[],
    capacity: number
  ): void => {
    if (a === b || areas[a] === undefined || areas[b] === undefined) return;
    if (links[id] !== undefined) return;
    const length = polylineLength(path);
    if (length <= 1e-6) return;
    links[id] = { id, kind, a, b, path: [...path], length, capacity, condition: 1 };
  };

  // ———————————————————————————————— per-city urban areas ————————————————
  for (const countryId of model.countryOrder) {
    const country = model.countries[countryId];
    for (const cityId of country.cityIds) {
      const city = model.cities[cityId];
      const ring: MapRing = city.areaRing;
      const ringPoints = ring.points;
      if (ringPoints.length < 3) {
        warnings.push(`city "${cityId}" has a degenerate area ring — core only`);
      }
      const center = city.position;
      const radius = ringRadius(ringPoints, center);
      const districts = DISTRICTS_BY_TIER[city.type] ?? DISTRICTS_BY_TIER.small;

      // —— urban core ——
      addArea({
        id: `area_${cityId}_core`,
        countryId: city.countryId,
        provinceId: city.provinceId,
        cityId,
        name: areaName(city.name, 'urban_core'),
        type: 'urban_core',
        position: { ...center },
        footprint: insetPolygon(ringPoints, center, 0.45),
        population: Math.round(city.population * 0.4),
        capacity: Math.round(city.population * 0.55),
        development: 0.6 + city.importance * 0.35,
        buildings: [...city.buildingIds],
        controlledBy: city.countryId,
        transportHub: false
      });

      // —— districts ——
      districts.forEach((type, index) => {
        const direction = DISTRICT_DIRECTIONS[index % DISTRICT_DIRECTIONS.length];
        const anchor: MapPoint = {
          x: center.x + direction.x * radius * 0.55,
          z: center.z + direction.z * radius * 0.55
        };
        const share = type === 'residential' ? 0.35 : type === 'commercial' ? 0.08 : type === 'industrial' ? 0.05 : 0.12;
        addArea({
          id: `area_${cityId}_${type}`,
          countryId: city.countryId,
          provinceId: city.provinceId,
          cityId,
          name: areaName(city.name, type),
          type,
          position: anchor,
          footprint: shiftedPolygon(ringPoints, anchor, 0.3),
          population: Math.round(city.population * share),
          capacity: Math.round(city.population * (share + 0.08)),
          development: 0.3 + city.importance * 0.3,
          buildings: [],
          controlledBy: city.countryId,
          transportHub: false
        });
        addLink(
          `link_${cityId}_core_${type}`,
          'road',
          `area_${cityId}_core`,
          `area_${cityId}_${type}`,
          [{ x: center.x, z: center.z }, anchor],
          city.population
        );
      });

      // —— agricultural hinterland: farthest dry cell of the province ——
      const province = model.provinces[city.provinceId];
      let bestCell = -1;
      let bestDistance = -1;
      let bestAnchor: MapPoint = { ...center };
      for (const cellIndex of province.cellIds) {
        if (waterCells.has(cellIndex)) continue;
        const quad = latticeQuad(model.lattice, cellIndex, columns);
        const centroid = polygonCentroid(quad);
        const distance = Math.hypot(centroid.x - center.x, centroid.z - center.z);
        if (distance > bestDistance) {
          bestDistance = distance;
          bestCell = cellIndex;
          bestAnchor = centroid;
        }
      }
      if (bestCell >= 0 && bestDistance > radius * 0.5) {
        const quad = latticeQuad(model.lattice, bestCell, columns);
        addArea({
          id: `area_${cityId}_agr_${bestCell}`,
          countryId: city.countryId,
          provinceId: city.provinceId,
          cityId,
          name: areaName(city.name, 'agricultural'),
          type: 'agricultural',
          position: bestAnchor,
          footprint: insetPolygon(quad, bestAnchor, 0.55),
          population: 900,
          capacity: 2_400,
          development: 0.25,
          buildings: [],
          controlledBy: city.countryId,
          transportHub: false
        });
        addLink(
          `link_${cityId}_core_agr${bestCell}`,
          'road',
          `area_${cityId}_core`,
          `area_${cityId}_agr_${bestCell}`,
          [{ x: center.x, z: center.z }, bestAnchor],
          Math.round(city.population * 0.2)
        );
      }
    }
  }

  // ———————————————————————— inter-city roads via junctions ————————————
  for (const line of model.features.lines) {
    if (line.cityA === null || line.cityB === null) continue;
    if (line.kind !== 'highway' && line.kind !== 'secondary') continue;
    const cityA = model.cities[line.cityA];
    const cityB = model.cities[line.cityB];
    if (cityA === undefined || cityB === undefined) continue;
    const polyline = line.polyline;
    if (polyline.length < 2) continue;

    const mid = Math.floor((polyline.length - 1) / 2);
    const midPoint = midpointOnSegment(polyline[mid], polyline[mid + 1] ?? polyline[mid]);
    const junctionId = `junction_${line.id}`;
    const junctionHalf = Math.max(0.12, spacing * 0.18);
    addArea({
      id: junctionId,
      countryId: cityA.countryId,
      provinceId: cityA.provinceId,
      cityId: null,
      name: `${cityA.name}–${cityB.name} Junction`,
      type: 'junction',
      position: midPoint,
      footprint: squareAround(midPoint, junctionHalf),
      population: 0,
      capacity: 0,
      development: 0.5,
      buildings: [],
      controlledBy: cityA.countryId,
      transportHub: true
    });

    // Anchor area of a city for road travel: commercial if present, else
    // suburban, else the core (the "suburban area" of the spec pattern).
    const anchorAreaOf = (cityId: string): string => {
      if (areas[`area_${cityId}_commercial`] !== undefined) return `area_${cityId}_commercial`;
      if (areas[`area_${cityId}_suburban`] !== undefined) return `area_${cityId}_suburban`;
      return `area_${cityId}_core`;
    };

    const firstHalf = polyline.slice(0, mid + 1).concat([midPoint]);
    const secondHalf = [midPoint].concat(polyline.slice(mid + 1));
    addLink(`link_${line.id}_a`, 'road', anchorAreaOf(line.cityA), junctionId, firstHalf, cityA.population);
    addLink(`link_${line.id}_b`, 'road', junctionId, anchorAreaOf(line.cityB), secondHalf, cityB.population);
  }

  // ————————————————————————————— railway backbone ————————————————————————
  for (const line of model.features.lines) {
    if (line.cityA === null || line.cityB === null) continue;
    if (line.kind !== 'railway') continue;
    if (areas[`area_${line.cityA}_core`] === undefined || areas[`area_${line.cityB}_core`] === undefined) continue;
    addLink(
      `link_${line.id}_rail`,
      'railway',
      `area_${line.cityA}_core`,
      `area_${line.cityB}_core`,
      [...line.polyline],
      0
    );
  }

  return { network: { areas, links }, warnings };
}

function midpointOnSegment(a: MapPoint, b: MapPoint): MapPoint {
  return { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
}

function squareAround(center: MapPoint, half: number): MapPoint[] {
  return [
    { x: center.x - half, z: center.z - half },
    { x: center.x + half, z: center.z - half },
    { x: center.x + half, z: center.z + half },
    { x: center.x - half, z: center.z + half }
  ];
}
