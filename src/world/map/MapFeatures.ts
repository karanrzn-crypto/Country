/**
 * Static geographic feature generation (Part 3 — map layers).
 *
 * Produces the per-cell FIELDS and the point/line features of the model:
 * biomes, temperature, terrain, roads, railways, sea routes and point sites
 * (ports / farms / factories / mines / military).
 *
 * Part-3 structure:
 * - `buildClimateFields` (exported) computes elevation / temperature /
 *   moisture ONCE — the generator needs elevation BEFORE placing cities
 *   (water-aware placement) and rivers; the same fields are then passed
 *   back in here, so every consumer shares ONE field source of truth.
 * - Rivers / lakes are built by MapRivers.buildRiverSystem and passed in as
 *   data — this module never re-derives water.
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
import type {
  BiomeId,
  MapCity,
  MapFeatures,
  MapLineFeature,
  MapPoint,
  MapRiver,
  MapLake,
  MapSite,
  TerrainId
} from './MapTypes';
import type { Cell, LatticeData } from './MapGeometry';
import { pointInRing } from './MapQueries';
import type { MapRing } from './MapTypes';

/** Tunable generation policy (module constants — one documented place). */
const ROAD_DIRT_MAX_POPULATION = 250_000;
const FACTORIES_PER_COUNTRY = 2;

export interface MapClimateFields {
  /** Normalized elevation 0..1 per cell (ocean cells included). */
  readonly elevation: readonly number[];
  readonly temperature: readonly number[];
  readonly moisture: readonly number[];
}

/**
 * THE climate fields of a seed — elevation, temperature, moisture per cell.
 * Deterministic and byte-stable per (seed, columns, rows): the RNG seeds and
 * call order are fixed so every consumer (generator, rivers, features) sees
 * the identical field values.
 */
export function buildClimateFields(seed: number, columns: number, rows: number): MapClimateFields {
  const cellCount = columns * rows;
  const rng = new Random((seed ^ 0x1a2b3c4d) >>> 0);
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
  return { elevation, temperature, moisture };
}

export interface MapFeaturesInput {
  readonly seed: number;
  readonly columns: number;
  readonly rows: number;
  readonly cellSize: number;
  readonly lattice: LatticeData;
  readonly cells: readonly Cell[];
  /** Land mask (true = land cell). */
  readonly land: readonly boolean[];
  /** Prebuilt climate fields (buildClimateFields) — never re-derived here. */
  readonly fields: MapClimateFields;
  /** Prebuilt water network (MapRivers.buildRiverSystem). */
  readonly rivers: readonly MapRiver[];
  readonly lakes: readonly MapLake[];
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

// ———————————————————— field classification ————————————————————

/**
 * Terrain classification thresholds (elevation is min-max normalized 0..1;
 * relief = max elevation difference to land neighbors). Tuned against the
 * default generator so every class appears on a typical continent:
 * lowland ~6%, valley ~9%, plains ~40%, plateau+hills ~28%, mountain ~13%,
 * highMountain ~4%.
 */
export const TERRAIN_THRESHOLDS = {
  lowlandBelow: 0.2,
  valleyBelow: 0.3,
  plateauFrom: 0.55,
  mountainFrom: 0.76,
  highMountainFrom: 0.88,
  plateauMaxRelief: 0.1
} as const;

/**
 * Classifies one land cell into a terrain class. `relief` is the max
 * elevation difference to the cell's land neighbors (0 for isolated cells) —
 * elevated + flat ground reads as a plateau even below the mountain band.
 */
export function classifyTerrain(elevation: number, relief: number): TerrainId {
  const t = TERRAIN_THRESHOLDS;
  if (elevation >= t.highMountainFrom) return 'highMountain';
  if (elevation >= t.mountainFrom) return 'mountain';
  if (elevation >= t.plateauFrom && elevation < t.mountainFrom && relief < t.plateauMaxRelief) {
    return 'plateau';
  }
  if (elevation >= t.plateauFrom) return 'hills';
  if (elevation <= t.lowlandBelow) return 'lowland';
  if (elevation <= t.valleyBelow) return 'valley';
  return 'plains';
}

export function classifyBiome(temperature: number, moisture: number): BiomeId {
  if (temperature < 0.2) return 'tundra';
  if (moisture < 0.24) return temperature > 0.6 ? 'desert' : 'drylands';
  if (moisture > 0.62) return temperature > 0.55 ? 'jungle' : 'forest';
  return 'grassland';
}

// ———————————————————— geometry helpers ————————————————————

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
export function cellIndexOf(position: MapPoint, columns: number, cellSize: number): number {
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

// ———————————————————— graph helpers ————————————————————

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

// ———————————————————— main builder ————————————————————

export function buildMapFeatures(input: MapFeaturesInput): MapFeatures {
  const { seed, columns, rows, cellSize, lattice, cells, land, countryPartition, countries, cities, fields } =
    input;
  const { elevation, temperature, moisture } = fields;
  const cellCount = columns * rows;
  const rng = new Random((seed ^ 0x77c25f1b) >>> 0);

  const centroids: MapPoint[] = cells.map((cell) => cellCentroidOf(cell, lattice));

  // —— 1. terrain + biome classification (from the SHARED climate fields) ——
  // Local relief per land cell: max elevation difference to LAND neighbors
  // (ocean neighbors excluded — coasts are not automatically mountains).
  const localRelief: number[] = new Array(cellCount).fill(0);
  for (let cz = 0; cz < rows; cz++) {
    for (let cx = 0; cx < columns; cx++) {
      const cellIndex = cz * columns + cx;
      if (!land[cellIndex]) continue;
      let maxDiff = 0;
      for (const [dx, dz] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1]
      ] as const) {
        const nx = cx + dx;
        const nz = cz + dz;
        if (nx < 0 || nx >= columns || nz < 0 || nz >= rows) continue;
        const neighbor = nz * columns + nx;
        if (!land[neighbor]) continue;
        maxDiff = Math.max(maxDiff, Math.abs(elevation[cellIndex] - elevation[neighbor]));
      }
      localRelief[cellIndex] = maxDiff;
    }
  }
  const terrain: TerrainId[] = new Array(cellCount);
  const biomes: BiomeId[] = new Array(cellCount);
  const cellOwner: number[] = new Array(cellCount);
  for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
    cellOwner[cellIndex] = land[cellIndex] ? countryPartition[cellIndex] : -1;
    if (!land[cellIndex]) {
      terrain[cellIndex] = 'lowland'; // sea floor — never rendered as land terrain
      biomes[cellIndex] = 'ocean';
      continue;
    }
    terrain[cellIndex] = classifyTerrain(elevation[cellIndex], localRelief[cellIndex]);
    biomes[cellIndex] = classifyBiome(temperature[cellIndex], moisture[cellIndex]);
  }

  // —— 2. roads (MST over ALL cities) + railways (MST over capitals) + sea routes ——
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

  // —— 3. sites: ports, resources (mines/oil), farms, factories, military ——
  // Lake cells are water: sites never target them.
  const lakeCellSet = new Set<number>();
  for (const lake of input.lakes) for (const cellIndex of lake.cells) lakeCellSet.add(cellIndex);
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
    const resourceCandidates = [...country.cellIds]
      .filter((cellIndex) => !lakeCellSet.has(cellIndex))
      .sort((a, b) => elevation[b] - elevation[a] || a - b);
    const usedResourceCells = new Set<number>();
    const chosenCells = spreadCells(resourceCandidates, targetResourceCount, centroids);
    for (const cellIndex of chosenCells) {
      usedResourceCells.add(cellIndex);
      const terrainClass = terrain[cellIndex];
      const biomeClass = biomes[cellIndex];
      let kind: MapSite['kind'] | null = null;
      let resourceId: string | null = null;
      if (terrainClass === 'mountain') {
        kind = 'mine';
        // Mountain ores: iron dominates, copper and gold are rarer (deterministic pick).
        const pick = rng.next();
        resourceId = pick < 0.55 ? 'iron' : pick < 0.8 ? 'copper' : 'gold';
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

    // Oil derricks: a DEDICATED desert/drylands pass — the elevation-first
    // spread above skews to mountains, so without this pass oil can vanish
    // from whole maps. Sites never share a cell with the main pass.
    const desertCells = country.cellIds.filter(
      (cellIndex) =>
        (biomes[cellIndex] === 'desert' || biomes[cellIndex] === 'drylands') &&
        !lakeCellSet.has(cellIndex) &&
        !usedResourceCells.has(cellIndex)
    );
    const oilCount = Math.max(0, Math.min(3, Math.ceil(desertCells.length / 5)));
    for (const cellIndex of spreadCells(desertCells, oilCount, centroids)) {
      const position = centroids[cellIndex];
      if (!pointInRing(position, country.ring.points)) continue;
      pushSite('oil', country.id, position, cellIndex, 'oil', null);
    }

    // Farms: grassland cells, spread for readability.
    const grassCells = country.cellIds.filter(
      (cellIndex) => biomes[cellIndex] === 'grassland' && !lakeCellSet.has(cellIndex)
    );
    const farmCount = Math.max(1, Math.min(3, Math.ceil(country.cellIds.length / 14)));
    for (const cellIndex of spreadCells(grassCells, farmCount, centroids)) {
      const position = centroids[cellIndex];
      if (!pointInRing(position, country.ring.points)) continue;
      pushSite('farm', country.id, position, cellIndex, null, null);
    }

    // Lumber camps: forest cells → wood production sites (same pattern as farms).
    const forestCells = country.cellIds.filter(
      (cellIndex) => biomes[cellIndex] === 'forest' && !lakeCellSet.has(cellIndex)
    );
    const lumberCount = Math.max(0, Math.min(3, Math.ceil(forestCells.length / 10)));
    for (const cellIndex of spreadCells(forestCells, lumberCount, centroids)) {
      const position = centroids[cellIndex];
      if (!pointInRing(position, country.ring.points)) continue;
      pushSite('lumber', country.id, position, cellIndex, 'wood', null);
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
    provinceOf: [],
    gridIds: [],
    rivers: input.rivers,
    lakes: input.lakes,
    lines,
    sites,
    deposits: [],
    buildings: []
  };
}
