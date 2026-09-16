/**
 * Static geographic feature generation (Part 3 — map layers).
 *
 * Runs ONCE per seed at the end of the strategic-map generation, producing
 * the immutable `MapFeatures` section of the model: biomes, elevation,
 * temperature, terrain, rivers, lakes, roads, railways, sea routes and
 * point sites (ports / farms / factories / mines / military).
 *
 * Design rules honored here:
 * - Deterministic: every decision is seeded or explicitly tie-broken — the
 *   same config always yields byte-identical features (hash-tested).
 * - Single source of truth: features are part of StrategicMapModel, so
 *   renderer, labels, future simulations and tests all read the same data.
 * - No magic offsets: polylines derive from cell/city data with seeded
 *   organic jitter that is part of the DATA itself, not of a render hack.
 * - Real polygons later: rivers/lines/sites are plain data records; a future
 *   authoritative dataset can replace the generator without touching the
 *   renderer, state or UI.
 *
 * Pure TypeScript: no Three.js, no DOM.
 */

import { Random } from '../../utils/Random';
import { generateCityName } from './MapNames';
import type {
  BiomeId,
  MapCity,
  MapFeatures,
  MapLineFeature,
  MapPoint,
  MapRiver,
  MapSite,
  TerrainId
} from './MapTypes';
import type { Cell, LatticeData } from './MapGeometry';
import { pointInRing } from './MapQueries';
import type { MapRing } from './MapTypes';

/** Tunable generation policy (module constants — one documented place). */
const RIVER_MIN_ELEVATION = 0.68;
const RIVER_MIN_SEPARATION = 4; // Chebyshev cell distance between sources
const RIVER_MAX_COUNT = 7;
const RIVER_MAX_STEPS = 80;
const ROAD_DIRT_MAX_POPULATION = 250_000;
const FACTORIES_PER_COUNTRY = 2;

export interface MapFeaturesInput {
  readonly seed: number;
  readonly columns: number;
  readonly rows: number;
  readonly cellSize: number;
  readonly lattice: LatticeData;
  readonly cells: readonly Cell[];
  /** Land mask (true = land cell). */
  readonly land: readonly boolean[];
  /** Dense country owner index per land cell (matches country id `country_${owner}`). */
  readonly countryPartition: Int32Array;
  readonly countries: readonly {
    readonly id: string;
    readonly ring: MapRing;
    readonly cellIds: readonly number[];
    readonly capitalCityId: string;
    readonly cityIds: readonly string[];
    readonly coastal: boolean;
  }[];
  readonly cities: Readonly<Record<string, MapCity>>;
  /** Cities whose host cell touches the ocean (computed by the generator). */
  readonly coastalCityIds: readonly string[];
}

// ———————————————————————————— noise helpers ————————————————————————————

/** Seeded bilinear value-noise over a coarse grid (same technique as the land mask). */
function makeNoise(rng: Random, gridSize: number): (fx: number, fz: number) => number {
  const grid: number[] = [];
  for (let i = 0; i < (gridSize + 1) * (gridSize + 1); i++) grid.push(rng.next());
  return (fx: number, fz: number): number => {
    const gx = Math.min(gridSize - 1e-9, Math.max(0, fx * gridSize));
    const gz = Math.min(gridSize - 1e-9, Math.max(0, fz * gridSize));
    const x0 = Math.floor(gx);
    const z0 = Math.floor(gz);
    const x1 = Math.min(gridSize, x0 + 1);
    const z1 = Math.min(gridSize, z0 + 1);
    const tx = gx - x0;
    const tz = gz - z0;
    const s00 = grid[z0 * (gridSize + 1) + x0];
    const s10 = grid[z0 * (gridSize + 1) + x1];
    const s01 = grid[z1 * (gridSize + 1) + x0];
    const s11 = grid[z1 * (gridSize + 1) + x1];
    return (
      s00 * (1 - tx) * (1 - tz) + s10 * tx * (1 - tz) + s01 * (1 - tx) * tz + s11 * tx * tz
    );
  };
}

/** Fractal value noise: coarse base + fine detail (2 octaves). */
function fbm(rng: Random): (fx: number, fz: number) => number {
  const base = makeNoise(rng, 6);
  const detail = makeNoise(rng, 13);
  return (fx, fz) => base(fx, fz) * 0.72 + detail(fx, fz) * 0.28;
}

function minMaxNormalize(values: number[]): number[] {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const span = max - min || 1;
  return values.map((value) => (value - min) / span);
}

// ———————————————————————————— field classification ————————————————————————————

export function classifyTerrain(elevation: number): TerrainId {
  if (elevation >= 0.8) return 'mountain';
  if (elevation >= 0.62) return 'hills';
  if (elevation <= 0.22) return 'valley';
  return 'plains';
}

export function classifyBiome(temperature: number, moisture: number): BiomeId {
  if (temperature < 0.2) return 'tundra';
  if (moisture < 0.24) return temperature > 0.6 ? 'desert' : 'drylands';
  if (moisture > 0.62) return temperature > 0.55 ? 'jungle' : 'forest';
  return 'grassland';
}

// ———————————————————————————— geometry helpers ————————————————————————————

/** Rebuilds the 4 lattice corner points of a cell (NW, NE, SE, SW). */
export function cellCornerPoints(
  cellIndex: number,
  latticePoints: readonly MapPoint[],
  columns: number
): [MapPoint, MapPoint, MapPoint, MapPoint] {
  const cx = cellIndex % columns;
  const cz = Math.floor(cellIndex / columns);
  const latticeColumns = columns + 1;
  const nw = cz * latticeColumns + cx;
  return [
    latticePoints[nw],
    latticePoints[nw + 1],
    latticePoints[nw + latticeColumns + 1],
    latticePoints[nw + latticeColumns]
  ];
}

function cellCentroidOf(cell: Cell, lattice: LatticeData): MapPoint {
  const [nw, ne, se, sw] = cell.corners.map((index) => lattice.points[index]);
  return { x: (nw.x + ne.x + se.x + sw.x) / 4, z: (nw.z + ne.z + se.z + sw.z) / 4 };
}

/** Nearest cell index for a world position (used to tag city-based sites). */
function cellIndexOf(position: MapPoint, columns: number, cellSize: number): number {
  const cx = Math.max(0, Math.floor(position.x / cellSize));
  const cz = Math.max(0, Math.floor(position.z / cellSize));
  return cz * columns + cx;
}

/** Deterministic organic midpoint: perpendicular jitter that is DATA, not a render hack. */
function jitteredMidpoint(
  a: MapPoint,
  b: MapPoint,
  rng: Random,
  amplitudeFraction = 0.12
): MapPoint {
  const mx = (a.x + b.x) / 2;
  const mz = (a.z + b.z) / 2;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const length = Math.hypot(dx, dz) || 1;
  const offset = (rng.next() * 2 - 1) * length * amplitudeFraction;
  return { x: mx + (-dz / length) * offset, z: mz + (dx / length) * offset };
}

// ———————————————————————————— graph helpers ————————————————————————————

/**
 * Deterministic Prim MST over weighted points. Tie-breaks compare ids, so
 * the spanning tree is a pure function of the input lists.
 */
function minimumSpanningTree(
  nodes: readonly { id: string; position: MapPoint }[]
): { a: string; b: string; distance: number }[] {
  if (nodes.length <= 1) return [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const inTree = new Set<string>([nodes[0].id]);
  const edges: { a: string; b: string; distance: number }[] = [];
  while (inTree.size < nodes.length) {
    let best: { a: string; b: string; distance: number } | null = null;
    for (const node of nodes) {
      if (inTree.has(node.id)) continue;
      for (const otherId of inTree) {
        const other = byId.get(otherId) as { id: string; position: MapPoint };
        const distance = Math.hypot(node.position.x - other.position.x, node.position.z - other.position.z);
        if (
          best === null ||
          distance < best.distance - 1e-9 ||
          (Math.abs(distance - best.distance) <= 1e-9 && node.id < best.b)
        ) {
          best = { a: otherId, b: node.id, distance };
        }
      }
    }
    if (best === null) break; // disconnected input — cannot happen for MST seeds
    edges.push(best);
    inTree.add(best.b);
  }
  return edges;
}

/** Greedy max-min spread over candidate cells (same policy as city placement). */
function spreadCells(
  candidates: readonly number[],
  count: number,
  centroids: readonly MapPoint[]
): number[] {
  if (candidates.length === 0 || count <= 0) return [];
  const chosen: number[] = [candidates[0]];
  while (chosen.length < count && chosen.length < candidates.length) {
    let bestCell = -1;
    let bestDistance = -1;
    for (const candidate of candidates) {
      if (chosen.includes(candidate)) continue;
      let nearest = Number.POSITIVE_INFINITY;
      for (const cellIndex of chosen) {
        const distance = Math.hypot(
          centroids[candidate].x - centroids[cellIndex].x,
          centroids[candidate].z - centroids[cellIndex].z
        );
        if (distance < nearest) nearest = distance;
      }
      if (nearest > bestDistance + 1e-9) {
        bestDistance = nearest;
        bestCell = candidate;
      }
    }
    if (bestCell < 0) break;
    chosen.push(bestCell);
  }
  return chosen;
}

// ———————————————————————————— main builder ————————————————————————————

export function buildMapFeatures(input: MapFeaturesInput): MapFeatures {
  const { seed, columns, rows, cellSize, lattice, cells, land, countryPartition, countries, cities } =
    input;
  const cellCount = columns * rows;
  const rng = new Random((seed ^ 0x1a2b3c4d) >>> 0);
  const nameRng = new Random((seed ^ 0x5f5f5f5f) >>> 0);

  // —— 1. elevation / temperature / moisture fields (per cell) ——
  const elevationNoise = fbm(rng);
  const temperatureNoise = fbm(rng);
  const moistureNoise = makeNoise(rng, 5);
  const rawElevation: number[] = new Array(cellCount);
  const rawTemperature: number[] = new Array(cellCount);
  const rawMoisture: number[] = new Array(cellCount);
  for (let cz = 0; cz < rows; cz++) {
    for (let cx = 0; cx < columns; cx++) {
      const cellIndex = cz * columns + cx;
      const fx = (cx + 0.5) / columns;
      const fz = (cz + 0.5) / rows;
      rawElevation[cellIndex] = elevationNoise(fx, fz);
      // Latitude gradient (north = colder) + noise, stored raw for normalization.
      rawTemperature[cellIndex] = 1 - Math.abs(fz - 0.5) * 1.4 + temperatureNoise(fx, fz) * 0.5 - 0.25;
      rawMoisture[cellIndex] = moistureNoise(fx, fz);
    }
  }
  const elevation = minMaxNormalize(rawElevation);
  const moisture = minMaxNormalize(rawMoisture);
  // Temperature: blend raw gradient with normalized noise, penalize altitude.
  const temperatureNorm = minMaxNormalize(rawTemperature);
  const temperature = elevation.map((elev, i) =>
    Math.max(0, Math.min(1, temperatureNorm[i] * 0.75 + moisture[i] * 0.1 - elev * 0.3 + 0.18))
  );

  // —— 2. terrain + biome classification ——
  const terrain: TerrainId[] = new Array(cellCount);
  const biomes: BiomeId[] = new Array(cellCount);
  const cellOwner: number[] = new Array(cellCount);
  for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
    cellOwner[cellIndex] = land[cellIndex] ? countryPartition[cellIndex] : -1;
    if (!land[cellIndex]) {
      terrain[cellIndex] = 'valley';
      biomes[cellIndex] = 'ocean';
      continue;
    }
    terrain[cellIndex] = classifyTerrain(elevation[cellIndex]);
    biomes[cellIndex] = classifyBiome(temperature[cellIndex], moisture[cellIndex]);
  }

  const centroids: MapPoint[] = cells.map((cell) => cellCentroidOf(cell, lattice));

  // —— 3. rivers: high sources descend greedily to the coast or an inland basin ——
  const riverNameUsed = new Set<string>();
  const rivers: MapRiver[] = [];
  const lakeCellSet = new Set<number>();
  const riverSources: number[] = [];
  const landCellsByElevation = Array.from({ length: cellCount }, (_, i) => i).filter(
    (cellIndex) => land[cellIndex] && elevation[cellIndex] >= RIVER_MIN_ELEVATION
  );
  landCellsByElevation.sort(
    (a, b) => elevation[b] - elevation[a] || a - b
  );
  for (const source of landCellsByElevation) {
    if (rivers.length >= RIVER_MAX_COUNT) break;
    const sx = source % columns;
    const sz = Math.floor(source / columns);
    const tooClose = riverSources.some((other) => {
      const ox = other % columns;
      const oz = Math.floor(other / columns);
      return Math.max(Math.abs(sx - ox), Math.abs(sz - oz)) < RIVER_MIN_SEPARATION;
    });
    if (tooClose) continue;

    const visited = new Set<number>([source]);
    const path: number[] = [source];
    let current = source;
    let mouth: number | null = null;
    for (let step = 0; step < RIVER_MAX_STEPS; step++) {
      const cx = current % columns;
      const cz = Math.floor(current / columns);
      const neighbors = [
        cx > 0 ? current - 1 : -1,
        cx < columns - 1 ? current + 1 : -1,
        cz > 0 ? current - columns : -1,
        cz < rows - 1 ? current + columns : -1
      ].filter((neighbor) => neighbor >= 0 && !visited.has(neighbor));
      const oceanNeighbor = neighbors.find((neighbor) => !land[neighbor]);
      if (oceanNeighbor !== undefined) {
        mouth = current; // river ends at its last land cell (the coast)
        break;
      }
      if (neighbors.length === 0) break;
      // Lowest neighbor wins; deterministic tie-break by cell index.
      let best = -1;
      let bestElevation = Number.POSITIVE_INFINITY;
      for (const neighbor of neighbors) {
        const neighborElevation = elevation[neighbor];
        if (neighborElevation < bestElevation - 1e-9 || (Math.abs(neighborElevation - bestElevation) <= 1e-9 && neighbor < best)) {
          bestElevation = neighborElevation;
          best = neighbor;
        }
      }
      if (best < 0 || bestElevation >= elevation[current] - 1e-9) {
        // Inland basin — the river ends in a small lake.
        lakeCellSet.add(current);
        break;
      }
      visited.add(best);
      path.push(best);
      current = best;
    }
    if (path.length < 3) continue; // too short to read as a river
    riverSources.push(source);

    const polyline: MapPoint[] = path.map((cellIndex, index) => {
      const centroid = centroids[cellIndex];
      if (index === 0 || index === path.length - 1) return centroid;
      const jitter = cellSize * 0.18;
      return {
        x: centroid.x + (rng.next() * 2 - 1) * jitter,
        z: centroid.z + (rng.next() * 2 - 1) * jitter
      };
    });
    rivers.push({
      id: `river_${rivers.length}`,
      name: generateCityName(nameRng, riverNameUsed),
      cells: path,
      polyline,
      mouthCell: mouth
    });
  }

  // —— 4. roads (MST over ALL cities) + railways (MST over capitals) + sea routes ——
  const cityList = Object.values(cities);
  const lines: MapLineFeature[] = [];

  const roadEdges = minimumSpanningTree(
    cityList.map((city) => ({ id: city.id, position: city.position }))
  );
  for (const edge of roadEdges) {
    const a = cities[edge.a];
    const b = cities[edge.b];
    const kind =
      a.isCapital && b.isCapital
        ? 'highway'
        : a.isCapital || b.isCapital
          ? 'secondary'
          : Math.min(a.population, b.population) < ROAD_DIRT_MAX_POPULATION
            ? 'dirt'
            : 'secondary';
    lines.push({
      id: `line_road_${lines.length}`,
      kind,
      cityA: a.id,
      cityB: b.id,
      polyline: [a.position, jitteredMidpoint(a.position, b.position, rng), b.position]
    });
  }

  const capitals = cityList.filter((city) => city.isCapital);
  const railEdges = minimumSpanningTree(
    capitals.map((city) => ({ id: city.id, position: city.position }))
  );
  for (const edge of railEdges) {
    const a = cities[edge.a];
    const b = cities[edge.b];
    lines.push({
      id: `line_rail_${lines.length}`,
      kind: 'railway',
      cityA: a.id,
      cityB: b.id,
      polyline: [a.position, jitteredMidpoint(a.position, b.position, rng, 0.08), b.position]
    });
  }

  const coastalCitySet = new Set(input.coastalCityIds);
  const ports = [...coastalCitySet].sort();
  const linkedSeaPairs = new Set<string>();
  for (const cityId of ports) {
    const from = cities[cityId];
    let bestId: string | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const otherId of ports) {
      if (otherId === cityId) continue;
      const other = cities[otherId];
      if (other.countryId === from.countryId) continue;
      const pairKey = cityId < otherId ? `${cityId}|${otherId}` : `${otherId}|${cityId}`;
      if (linkedSeaPairs.has(pairKey)) continue;
      const distance = Math.hypot(
        from.position.x - other.position.x,
        from.position.z - other.position.z
      );
      if (distance < bestDistance - 1e-9 || (Math.abs(distance - bestDistance) <= 1e-9 && otherId < (bestId ?? ''))) {
        bestDistance = distance;
        bestId = otherId;
      }
    }
    if (bestId === null) continue;
    const other = cities[bestId];
    linkedSeaPairs.add(cityId < bestId ? `${cityId}|${bestId}` : `${bestId}|${cityId}`);
    lines.push({
      id: `line_sea_${lines.length}`,
      kind: 'seaRoute',
      cityA: from.id,
      cityB: other.id,
      polyline: [from.position, other.position]
    });
  }

  // —— 5. sites: ports, resources (mines/oil), farms, factories, military ——
  const sites: MapSite[] = [];
  const pushSite = (
    kind: MapSite['kind'],
    countryId: string,
    position: MapPoint,
    cellIndex: number,
    resourceId: string | null,
    cityId: string | null
  ): void => {
    sites.push({
      id: `site_${sites.length}`,
      kind,
      resourceId,
      countryId,
      cityId,
      cellIndex,
      position
    });
  };

  for (const country of countries) {
    const capital = cities[country.capitalCityId];

    // Ports: coastal capitals + up to two other coastal cities per coastal country.
    if (country.coastal) {
      const coastalCities = country.cityIds
        .map((cityId) => cities[cityId])
        .filter((city) => coastalCitySet.has(city.id))
        .sort((a, b) => b.population - a.population || a.id.localeCompare(b.id));
      for (const city of coastalCities.slice(0, 3)) {
        pushSite('port', country.id, city.position, cellIndexOf(city.position, columns, cellSize), null, city.id);
      }
    }

    // Extractive resources: spread candidates, kind follows the local terrain.
    const targetResourceCount = Math.max(2, Math.min(5, Math.ceil(country.cellIds.length / 10)));
    const resourceCandidates = [...country.cellIds].sort(
      (a, b) => elevation[b] - elevation[a] || a - b
    );
    const chosenCells = spreadCells(resourceCandidates, targetResourceCount, centroids);
    for (const cellIndex of chosenCells) {
      const terrainClass = terrain[cellIndex];
      const biomeClass = biomes[cellIndex];
      let kind: MapSite['kind'] | null = null;
      let resourceId: string | null = null;
      if (terrainClass === 'mountain') {
        kind = 'mine';
        resourceId = rng.next() < 0.7 ? 'iron' : 'gold';
      } else if (terrainClass === 'hills') {
        kind = 'mine';
        resourceId = 'coal';
      } else if (biomeClass === 'desert' || biomeClass === 'drylands') {
        kind = 'oil';
        resourceId = 'oil';
      } else if (biomeClass === 'tundra') {
        kind = 'mine';
        resourceId = 'iron';
      }
      if (kind === null) continue;
      const position = centroids[cellIndex];
      if (!pointInRing(position, country.ring.points)) continue; // never outside the country
      pushSite(kind, country.id, position, cellIndex, resourceId, null);
    }

    // Farms: grassland cells, spread for readability.
    const grassCells = country.cellIds.filter((cellIndex) => biomes[cellIndex] === 'grassland');
    const farmCount = Math.max(1, Math.min(3, Math.ceil(country.cellIds.length / 14)));
    for (const cellIndex of spreadCells(grassCells, farmCount, centroids)) {
      const position = centroids[cellIndex];
      if (!pointInRing(position, country.ring.points)) continue;
      pushSite('farm', country.id, position, cellIndex, null, null);
    }

    // Factories: the largest non-capital cities.
    const factoryCities = country.cityIds
      .map((cityId) => cities[cityId])
      .filter((city) => !city.isCapital)
      .sort((a, b) => b.population - a.population || a.id.localeCompare(b.id))
      .slice(0, FACTORIES_PER_COUNTRY);
    for (const city of factoryCities) {
      pushSite('factory', country.id, city.position, cellIndexOf(city.position, columns, cellSize), null, city.id);
    }

    // Military: a base at the capital, an airbase at the biggest other city.
    pushSite('base', country.id, capital.position, cellIndexOf(capital.position, columns, cellSize), null, capital.id);
    const airbaseCity =
      factoryCities[0] ??
      country.cityIds.map((cityId) => cities[cityId]).sort((a, b) => b.population - a.population)[0];
    if (airbaseCity !== undefined) {
      pushSite('airbase', country.id, airbaseCity.position, cellIndexOf(airbaseCity.position, columns, cellSize), null, airbaseCity.id);
    }
  }

  return {
    biomes,
    elevation,
    temperature,
    moisture,
    terrain,
    cellOwner,
    rivers,
    lakeCells: [...lakeCellSet].sort((a, b) => a - b),
    lines,
    sites
  };
}
