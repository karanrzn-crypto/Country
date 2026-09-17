/**
 * Deterministic strategic-map generator (Part 1).
 *
 * Pipeline (all steps seeded — the same config always yields the same map):
 *
 *  1. Lattice           — jittered shared point grid (exact bounding box).
 *  2. Land mask         — value-noise + radial falloff, largest component
 *                         kept, then a peninsula is grown and a bay carved.
 *  3. Countries         — farthest-point seeds + balanced multi-source BFS,
 *                         tiny countries merged, 4-connectivity enforced.
 *  4. Provinces         — same partitioning inside each country.
 *  5. Shared edges      — one registry, one polyline per border stretch.
 *  6. Rings             — countries/provinces reference shared edges only.
 *  7. Cities            — capital + cities at validated interior points.
 *
 * Pure TypeScript: no Three.js, no DOM. Runs headless and is fully tested.
 */

import { Random } from '../../utils/Random';
import type { MapConfig } from '../../config/configTypes';
import type {
  StrategicMapModel,
  MapCountry,
  MapProvince,
  MapCity,
  MapPoint,
  MapBounds,
  MapStats,
  MapRing
} from './MapTypes';
import {
  buildLattice,
  buildCells,
  buildSharedEdges,
  extractRegionRing,
  type Cell,
  type LatticeData
} from './MapGeometry';
import { pointInRing, distanceToRing } from './MapQueries';
import { buildMapFeatures, buildClimateFields, type MapClimateFields } from './MapFeatures';
import { buildRiverSystem } from './MapRivers';
import {
  buildGeography,
  buildBuildings,
  buildDeposits,
  buildPopulationTree,
  computeProvinceOfCells,
  checkWaterSafety,
  hash01
} from './MapGeography';
import {
  generateCountryName,
  generateProvinceName,
  generateCityName,
  generateContinentName
} from './MapNames';

/** Mutable assembly-time variants (readonly arrays arrive in the final model). */
interface ProvinceBuilder {
  id: string;
  name: string;
  countryId: string;
  ring: MapRing;
  cellIds: number[];
  cityIds: string[];
  labelPoint: MapPoint;
}

/** Part-3 fields arrive later via the geography enrichment merge. */
type CityCoreFields =
  | 'areaRing'
  | 'gridId'
  | 'type'
  | 'importance'
  | 'buildingIds'
  | 'resourceIds'
  | 'industries'
  | 'infrastructure'
  | 'strategicValue'
  | 'riverIds'
  | 'isRiverine';
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type CityBuilder = Mutable<Omit<MapCity, CityCoreFields>>;
type CityWithDistrict = CityBuilder & { areaRing: MapRing };

interface CountryBuilder {
  id: string;
  name: string;
  ring: MapRing;
  cellIds: number[];
  provinceIds: string[];
  cityIds: string[];
  capitalCityId: string;
  neighborIds: string[];
  coastal: boolean;
  colorIndex: number;
  labelPoint: MapPoint;
}

export interface GenerationResult {
  readonly model: StrategicMapModel;
  readonly warnings: readonly string[];
}

export interface MapGenerationOptions {
  /**
   * Declared (authoritative) population per country id — the anchor of the
   * Part-3 population tree: Σ provinces = Σ cities-sums = declared value.
   * Omitted → deterministic synthesized populations (hash-derived).
   */
  readonly countryPopulations?: Readonly<Record<string, number>>;
}

// ————————————————————————————— 1–2. land mask —————————————————————————————

/**
 * Forces at least `targetCount` countries to become landlocked by handing
 * their coastal cells to adjacent (already coastal) countries. Runs BEFORE
 * edge/ring construction, so everything downstream (edges, rings, neighbors,
 * stats) stays structurally consistent. Preserves 4-connectivity and the
 * per-country minimum size.
 */
function forceLandlockedCountries(
  countryPartition: Int32Array,
  landCells: readonly number[],
  landSet: ReadonlySet<number>,
  columns: number,
  rows: number,
  countryCount: number,
  minCountryCells: number,
  targetCount: number
): number {
  const neighborsOf = (cellIndex: number): number[] => {
    const cx = cellIndex % columns;
    const cz = Math.floor(cellIndex / columns);
    return [
      cx > 0 ? cellIndex - 1 : -1,
      cx < columns - 1 ? cellIndex + 1 : -1,
      cz > 0 ? cellIndex - columns : -1,
      cz < rows - 1 ? cellIndex + columns : -1
    ];
  };
  const isCoastalCell = (cellIndex: number): boolean =>
    neighborsOf(cellIndex).some((neighbor) => neighbor < 0 || !landSet.has(neighbor));
  const cellsOfOwner = (owner: number): number[] =>
    landCells.filter((cellIndex) => countryPartition[cellIndex] === owner);

  let landlocked = Array.from({ length: countryCount }, (_, id) => id).filter(
    (id) => !cellsOfOwner(id).some(isCoastalCell)
  ).length;

  for (let round = 0; round < countryCount * 2 && landlocked < targetCount; round++) {
    // Pick the coastal country with the fewest coastal cells that can still
    // afford to lose them (interior stays >= minCountryCells).
    let bestOwner = -1;
    let bestCoastalCount = Number.POSITIVE_INFINITY;
    for (let owner = 0; owner < countryCount; owner++) {
      const cells = cellsOfOwner(owner);
      const coastalCount = cells.filter(isCoastalCell).length;
      if (coastalCount === 0) continue;
      if (cells.length - coastalCount < minCountryCells) continue;
      if (coastalCount < bestCoastalCount) {
        bestCoastalCount = coastalCount;
        bestOwner = owner;
      }
    }
    if (bestOwner < 0) break;

    let remainingCells = cellsOfOwner(bestOwner);
    const coastalCells = remainingCells.filter(isCoastalCell);
    let transferredAll = true;
    for (const cellIndex of coastalCells) {
      // Try neighbor owners: already-coastal ones first, then any other owner.
      const candidateTargets: number[] = [];
      const fallbackTargets: number[] = [];
      for (const neighbor of neighborsOf(cellIndex)) {
        if (neighbor < 0 || !landSet.has(neighbor)) continue;
        const other = countryPartition[neighbor];
        if (other >= 0 && other !== bestOwner) {
          if (cellsOfOwner(other).some(isCoastalCell)) candidateTargets.push(other);
          else fallbackTargets.push(other);
        }
      }
      const orderedTargets = [...new Set([...candidateTargets, ...fallbackTargets])];
      let transferred = false;
      for (const target of orderedTargets) {
        const without = remainingCells.filter((cell) => cell !== cellIndex);
        if (!cells4Connected(without, columns, rows)) continue;
        countryPartition[cellIndex] = target;
        remainingCells = without;
        transferred = true;
        break;
      }
      if (!transferred) transferredAll = false;
    }
    if (transferredAll && remainingCells.length >= minCountryCells) landlocked++;
  }
  return landlocked;
}

/**
 * Value-noise land mask with radial falloff: a coarse seeded elevation grid
 * is bilinearly sampled per cell, then attenuated towards the map edges so
 * the continent is one organic blob surrounded by ocean.
 */
function buildLandMask(
  columns: number,
  rows: number,
  rng: Random,
  landFraction: number
): { land: boolean[]; peninsulaCells: number; bayCells: number } {
  const seedGridSize = 5;
  const seedGrid: number[] = [];
  for (let i = 0; i < (seedGridSize + 1) * (seedGridSize + 1); i++) seedGrid.push(rng.next());

  const sample = (fx: number, fz: number): number => {
    const gx = fx * seedGridSize;
    const gz = fz * seedGridSize;
    const x0 = Math.min(seedGridSize, Math.floor(gx));
    const z0 = Math.min(seedGridSize, Math.floor(gz));
    const x1 = Math.min(seedGridSize, x0 + 1);
    const z1 = Math.min(seedGridSize, z0 + 1);
    const tx = gx - x0;
    const tz = gz - z0;
    const s00 = seedGrid[z0 * (seedGridSize + 1) + x0];
    const s10 = seedGrid[z0 * (seedGridSize + 1) + x1];
    const s01 = seedGrid[z1 * (seedGridSize + 1) + x0];
    const s11 = seedGrid[z1 * (seedGridSize + 1) + x1];
    return s00 * (1 - tx) * (1 - tz) + s10 * tx * (1 - tz) + s01 * (1 - tx) * tz + s11 * tx * tz;
  };

  const centerX = columns / 2;
  const centerZ = rows / 2;
  const maxRadius = Math.min(columns, rows) * 0.48;

  const elevation: number[] = new Array(columns * rows).fill(0);
  for (let cz = 0; cz < rows; cz++) {
    for (let cx = 0; cx < columns; cx++) {
      const noise = sample((cx + 0.5) / columns, (cz + 0.5) / rows);
      const dx = (cx + 0.5 - centerX) / maxRadius;
      const dz = (cz + 0.5 - centerZ) / maxRadius;
      const radial = Math.sqrt(dx * dx + dz * dz);
      elevation[cz * columns + cx] = noise * 1.15 - radial * radial * 0.9;
    }
  }

  // Quantile auto-threshold: keep the top ~60% cells as candidate land so the
  // continent is big enough for every country regardless of config tuning.
  const sorted = [...elevation].sort((a, b) => b - a);
  const keepCount = Math.floor(columns * rows * landFraction);
  const threshold = sorted[Math.max(0, keepCount - 1)];
  const land: boolean[] = elevation.map((value) => value >= threshold);

  const kept = keepLargestComponent(land, columns, rows);
  const peninsulaCells = growPeninsula(kept, columns, rows, rng);
  const bayCells = carveBay(kept, columns, rows, rng);
  return { land: kept, peninsulaCells, bayCells };
}

/** Keeps only the 4-connected component with the most cells (the continent). */
function keepLargestComponent(land: boolean[], columns: number, rows: number): boolean[] {
  const seen = new Array(columns * rows).fill(false);
  let best: number[] = [];
  for (let start = 0; start < land.length; start++) {
    if (!land[start] || seen[start]) continue;
    const component: number[] = [];
    const queue = [start];
    seen[start] = true;
    while (queue.length > 0) {
      const cellIndex = queue.pop() as number;
      component.push(cellIndex);
      const cx = cellIndex % columns;
      const cz = Math.floor(cellIndex / columns);
      const neighbors = [
        cx > 0 ? cellIndex - 1 : -1,
        cx < columns - 1 ? cellIndex + 1 : -1,
        cz > 0 ? cellIndex - columns : -1,
        cz < rows - 1 ? cellIndex + columns : -1
      ];
      for (const neighbor of neighbors) {
        if (neighbor >= 0 && land[neighbor] && !seen[neighbor]) {
          seen[neighbor] = true;
          queue.push(neighbor);
        }
      }
    }
    if (component.length > best.length) best = component;
  }
  const result = new Array<boolean>(columns * rows).fill(false);
  for (const cellIndex of best) result[cellIndex] = true;
  return result;
}

/**
 * Grows a 2-cell-wide finger of land into the ocean — a peninsula.
 * Returns the number of cells added (0 when no viable coast was found).
 */
function growPeninsula(land: boolean[], columns: number, rows: number, rng: Random): number {
  const directions: readonly (readonly [number, number])[] = [
    [0, -1], [0, 1], [-1, 0], [1, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]
  ];
  const candidates: { cellIndex: number; direction: readonly [number, number] }[] = [];
  for (let cz = 1; cz < rows - 1; cz++) {
    for (let cx = 1; cx < columns - 1; cx++) {
      const cellIndex = cz * columns + cx;
      if (!land[cellIndex]) continue;
      for (const direction of directions) {
        // Need 3 clear ocean steps in the direction starting from a land cell.
        let clear = true;
        for (let step = 1; step <= 3; step++) {
          const nx = cx + direction[0] * step;
          const nz = cz + direction[1] * step;
          if (nx < 1 || nz < 1 || nx >= columns - 1 || nz >= rows - 1 || land[nz * columns + nx]) {
            clear = false;
            break;
          }
        }
        if (clear) candidates.push({ cellIndex, direction });
      }
    }
  }
  if (candidates.length === 0) return 0;

  const chosen = candidates[rng.int(candidates.length)];
  const startCx = chosen.cellIndex % columns;
  const startCz = Math.floor(chosen.cellIndex / columns);
  const [dx, dz] = chosen.direction;
  // Perpendicular for the 2-wide finger.
  const perp = dx === 0 ? [1, 0] : [0, 1];

  let added = 0;
  // The finger is 2 cells wide: main direction + one perpendicular offset.
  for (let step = 1; step <= 3; step++) {
    const cellsToAdd: readonly (readonly [number, number])[] = [
      [startCx + dx * step, startCz + dz * step],
      [startCx + dx * step + perp[0], startCz + dz * step + perp[1]]
    ];
    for (const [nx, nz] of cellsToAdd) {
      if (nx <= 0 || nz <= 0 || nx >= columns - 1 || nz >= rows - 1) continue;
      const idx = nz * columns + nx;
      if (!land[idx]) {
        land[idx] = true;
        added++;
      }
    }
  }
  return added;
}

/**
 * Carves a 2–3 cell inlet of water into the coastal land — a bay.
 * Returns the number of cells removed (0 when not viable); the continent is
 * re-verified as a single component afterwards by the caller.
 */
function carveBay(land: boolean[], columns: number, rows: number, rng: Random): number {
  const directions: readonly (readonly [number, number])[] = [
    [0, -1], [0, 1], [-1, 0], [1, 0]
  ];
  const candidates: { cellIndex: number; direction: readonly [number, number] }[] = [];
  for (let cz = 2; cz < rows - 2; cz++) {
    for (let cx = 2; cx < columns - 2; cx++) {
      const cellIndex = cz * columns + cx;
      if (land[cellIndex]) continue;
      for (const direction of directions) {
        // Ocean cell with 3 land cells inland in this direction → bay site.
        let inland = true;
        for (let step = 1; step <= 3; step++) {
          if (!land[(cz + direction[1] * step) * columns + (cx + direction[0] * step)]) {
            inland = false;
            break;
          }
        }
        if (inland) candidates.push({ cellIndex, direction });
      }
    }
  }
  if (candidates.length === 0) return 0;

  for (let attempt = 0; attempt < 8; attempt++) {
    const chosen = candidates[rng.int(candidates.length)];
    const cx = chosen.cellIndex % columns;
    const cz = Math.floor(chosen.cellIndex / columns);
    const [dx, dz] = chosen.direction;
    const removed: number[] = [];
    for (let step = 1; step <= 3; step++) {
      for (const width of [-1, 0, 1]) {
        const nx = cx + dx * step + (dx === 0 ? width : 0);
        const nz = cz + dz * step + (dz === 0 ? width : 0);
        const idx = nz * columns + nx;
        if (land[idx]) removed.push(idx);
      }
    }
    if (removed.length < 4) continue;
    for (const idx of removed) land[idx] = false;
    if (countComponents(land, columns, rows) === 1) return removed.length;
    // Would disconnect the continent — undo and try another site.
    for (const idx of removed) land[idx] = true;
  }
  return 0;
}

function countComponents(land: readonly boolean[], columns: number, rows: number): number {
  const seen = new Array(columns * rows).fill(false);
  let components = 0;
  for (let start = 0; start < land.length; start++) {
    if (!land[start] || seen[start]) continue;
    components++;
    const queue = [start];
    seen[start] = true;
    while (queue.length > 0) {
      const cellIndex = queue.pop() as number;
      const cx = cellIndex % columns;
      const cz = Math.floor(cellIndex / columns);
      const neighbors = [
        cx > 0 ? cellIndex - 1 : -1,
        cx < columns - 1 ? cellIndex + 1 : -1,
        cz > 0 ? cellIndex - columns : -1,
        cz < rows - 1 ? cellIndex + columns : -1
      ];
      for (const neighbor of neighbors) {
        if (neighbor >= 0 && land[neighbor] && !seen[neighbor]) {
          seen[neighbor] = true;
          queue.push(neighbor);
        }
      }
    }
  }
  return components;
}

// ——————————————————————————— 3–4. partitions ———————————————————————————————

/** Balanced multi-source BFS growth from `seeds` over the `allowed` cell set. */
function partitionByGrowth(
  allowed: ReadonlySet<number>,
  seeds: readonly number[],
  columns: number,
  rows: number,
  rng: Random
): Int32Array {
  const partition = new Int32Array(columns * rows).fill(-2); // -2 = unassigned
  const queue: number[] = [];
  for (let i = 0; i < seeds.length; i++) {
    partition[seeds[i]] = i;
    queue.push(seeds[i]);
  }
  let head = 0;
  while (head < queue.length) {
    // Random-ish frontier rotation keeps growth balanced and organic.
    const spliceIndex = head + rng.int(Math.min(4, queue.length - head));
    const cellIndex = queue[spliceIndex];
    queue[spliceIndex] = queue[head];
    queue[head++] = cellIndex;
    const owner = partition[cellIndex];
    const cx = cellIndex % columns;
    const cz = Math.floor(cellIndex / columns);
    const neighbors = [
      cx > 0 ? cellIndex - 1 : -1,
      cx < columns - 1 ? cellIndex + 1 : -1,
      cz > 0 ? cellIndex - columns : -1,
      cz < rows - 1 ? cellIndex + columns : -1
    ];
    for (const neighbor of neighbors) {
      if (neighbor >= 0 && allowed.has(neighbor) && partition[neighbor] === -2) {
        partition[neighbor] = owner;
        queue.push(neighbor);
      }
    }
  }
  return partition;
}

/** Farthest-point sampling: spreads `count` seeds as far apart as possible. */
function farthestPointSeeds(
  allowed: readonly number[],
  count: number,
  columns: number,
  rng: Random,
  firstSeed?: number
): number[] {
  if (allowed.length === 0) return [];
  const seeds: number[] = [firstSeed ?? allowed[rng.int(allowed.length)]];
  const minDistance = new Map<number, number>();
  const distanceTo = (cellIndex: number, seed: number): number => {
    const ax = cellIndex % columns;
    const az = Math.floor(cellIndex / columns);
    const bx = seed % columns;
    const bz = Math.floor(seed / columns);
    return (ax - bx) * (ax - bx) + (az - bz) * (az - bz);
  };
  for (const cellIndex of allowed) minDistance.set(cellIndex, distanceTo(cellIndex, seeds[0]));
  while (seeds.length < count && seeds.length < allowed.length) {
    let bestCell = -1;
    let bestDistance = -1;
    for (const [cellIndex, distance] of minDistance) {
      if (distance > bestDistance) {
        bestDistance = distance;
        bestCell = cellIndex;
      }
    }
    if (bestCell < 0) break;
    seeds.push(bestCell);
    minDistance.delete(bestCell);
    for (const [cellIndex] of minDistance) {
      const d = distanceTo(cellIndex, bestCell);
      if (d < (minDistance.get(cellIndex) ?? 0)) minDistance.set(cellIndex, d);
    }
  }
  return seeds;
}

function cells4Connected(component: readonly number[], columns: number, rows: number): boolean {
  if (component.length <= 1) return true;
  const member = new Set(component);
  const seen = new Set<number>([component[0]]);
  const queue = [component[0]];
  while (queue.length > 0) {
    const cellIndex = queue.pop() as number;
    const cx = cellIndex % columns;
    const cz = Math.floor(cellIndex / columns);
    const neighbors = [
      cx > 0 ? cellIndex - 1 : -1,
      cx < columns - 1 ? cellIndex + 1 : -1,
      cz > 0 ? cellIndex - columns : -1,
      cz < rows - 1 ? cellIndex + columns : -1
    ];
    for (const neighbor of neighbors) {
      if (neighbor >= 0 && member.has(neighbor) && !seen.has(neighbor)) {
        seen.add(neighbor);
        queue.push(neighbor);
      }
    }
  }
  return seen.size === component.length;
}

/**
 * Merges partition fragments smaller than `minCells` into their smallest
 * neighboring partition (by shared 4-adjacency), then enforces that every
 * remaining region is 4-connected (disconnected fragments re-attach to the
 * neighbor they touch most). Returns the final partition array.
 */
function normalizePartition(
  partition: Int32Array,
  allowed: readonly number[],
  columns: number,
  rows: number,
  minCells: number
): void {
  const allowedSet = new Set(allowed);
  const membersOf = (): Map<number, number[]> => {
    const map = new Map<number, number[]>();
    for (const cellIndex of allowed) {
      const owner = partition[cellIndex];
      if (owner < 0) continue;
      const list = map.get(owner);
      if (list === undefined) map.set(owner, [cellIndex]);
      else list.push(cellIndex);
    }
    return map;
  };

  // 1. merge tiny regions
  for (let pass = 0; pass < 32; pass++) {
    const members = membersOf();
    let merged = false;
    for (const [owner, cells] of [...members.entries()].sort((a, b) => a[0] - b[0])) {
      if (cells.length >= minCells) continue;
      // find smallest neighbor partition
      const neighborCounts = new Map<number, number>();
      for (const cellIndex of cells) {
        const cx = cellIndex % columns;
        const cz = Math.floor(cellIndex / columns);
        const neighbors = [
          cx > 0 ? cellIndex - 1 : -1,
          cx < columns - 1 ? cellIndex + 1 : -1,
          cz > 0 ? cellIndex - columns : -1,
          cz < rows - 1 ? cellIndex + columns : -1
        ];
        for (const neighbor of neighbors) {
          if (neighbor < 0 || !allowedSet.has(neighbor)) continue;
          const other = partition[neighbor];
          if (other >= 0 && other !== owner) {
            neighborCounts.set(other, (neighborCounts.get(other) ?? 0) + 1);
          }
        }
      }
      if (neighborCounts.size === 0) continue;
      let bestOther = -1;
      let bestCount = -1;
      for (const [other, count] of [...neighborCounts.entries()].sort((a, b) => a[0] - b[0])) {
        const size = members.get(other)?.length ?? Number.MAX_SAFE_INTEGER;
        if (count > bestCount || (count === bestCount && size < (members.get(bestOther)?.length ?? Number.MAX_SAFE_INTEGER))) {
          bestOther = other;
          bestCount = count;
        }
      }
      if (bestOther < 0) continue;
      for (const cellIndex of cells) partition[cellIndex] = bestOther;
      merged = true;
      break; // recompute after each merge
    }
    if (!merged) break;
  }

  // 2. enforce 4-connectivity of every region
  for (let pass = 0; pass < 32; pass++) {
    const members = membersOf();
    let fixed = false;
    for (const [owner, cells] of members) {
      if (cells4Connected(cells, columns, rows)) continue;
      // Split into components; re-attach all but the largest.
      const components: number[][] = [];
      const seen = new Set<number>();
      for (const start of cells) {
        if (seen.has(start)) continue;
        const component: number[] = [];
        const queue = [start];
        seen.add(start);
        while (queue.length > 0) {
          const cellIndex = queue.pop() as number;
          component.push(cellIndex);
          const cx = cellIndex % columns;
          const cz = Math.floor(cellIndex / columns);
          const neighbors = [
            cx > 0 ? cellIndex - 1 : -1,
            cx < columns - 1 ? cellIndex + 1 : -1,
            cz > 0 ? cellIndex - columns : -1,
            cz < rows - 1 ? cellIndex + columns : -1
          ];
          for (const neighbor of neighbors) {
            if (neighbor >= 0 && allowedSet.has(neighbor) && partition[neighbor] === owner && !seen.has(neighbor)) {
              seen.add(neighbor);
              queue.push(neighbor);
            }
          }
        }
        components.push(component);
      }
      components.sort((a, b) => b.length - a.length);
      for (let i = 1; i < components.length; i++) {
        for (const cellIndex of components[i]) {
          // Attach to the neighboring partition with the most shared edges.
          const neighborCounts = new Map<number, number>();
          const cx = cellIndex % columns;
          const cz = Math.floor(cellIndex / columns);
          const neighbors = [
            cx > 0 ? cellIndex - 1 : -1,
            cx < columns - 1 ? cellIndex + 1 : -1,
            cz > 0 ? cellIndex - columns : -1,
            cz < rows - 1 ? cellIndex + columns : -1
          ];
          for (const neighbor of neighbors) {
            if (neighbor < 0 || !allowedSet.has(neighbor)) continue;
            const other = partition[neighbor];
            if (other >= 0 && other !== owner) neighborCounts.set(other, (neighborCounts.get(other) ?? 0) + 1);
          }
          if (neighborCounts.size === 0) continue;
          let bestOther = -1;
          let bestCount = -1;
          for (const [other, count] of [...neighborCounts.entries()].sort((a, b) => a[0] - b[0])) {
            if (count > bestCount) {
              bestOther = other;
              bestCount = count;
            }
          }
          partition[cellIndex] = bestOther;
        }
        fixed = true;
      }
      if (fixed) break;
    }
    if (!fixed) break;
  }
}

// ———————————————————————————————— 7. cities ————————————————————————————————

/** Finds an interior point near `seed` guaranteed to be inside ALL rings. */
function interiorPointNearRings(rings: readonly (readonly MapPoint[])[], seed: MapPoint): MapPoint {
  const insideAll = (point: MapPoint): boolean => rings.every((ring) => pointInRing(point, ring));
  if (insideAll(seed)) return seed;
  // Deterministic spiral search — every ring here has positive area and the
  // seed starts inside its cell, so an interior point is found quickly.
  for (let radius = 0.5; radius <= 40; radius += 0.5) {
    const steps = 8 + Math.floor(radius * 2);
    for (let i = 0; i < steps; i++) {
      const angle = (i / steps) * Math.PI * 2;
      const candidate = { x: seed.x + Math.cos(angle) * radius, z: seed.z + Math.sin(angle) * radius };
      if (insideAll(candidate)) return candidate;
    }
  }
  throw new Error('interiorPointNearRings: no interior point found (degenerate ring?)');
}

function cellCentroid(lattice: LatticeData, cell: Cell): MapPoint {
  const pts = cell.corners.map((index) => lattice.points[index]);
  let x = 0;
  let z = 0;
  for (const p of pts) {
    x += p.x;
    z += p.z;
  }
  return { x: x / 4, z: z / 4 };
}

// ————————————————————————————— generator ————————————————————————————————

export function generateStrategicMap(
  config: MapConfig,
  options: MapGenerationOptions = {}
): GenerationResult {
  /**
   * Retry ladder for the land fraction: a smaller continent leaves more room
   * for interior (landlocked) countries. Attempts are deterministic — the
   * first fraction that satisfies the landlocked target wins; otherwise the
   * last attempt is returned with a warning.
   */
  const fractions = [0.6, 0.52, 0.45, 0.38];
  let last: GenerationResult | null = null;
  for (const fraction of fractions) {
    const result = attemptGeneration(config, fraction, options);
    last = result;
    if (result.model.stats.landlockedCountries >= 2) return result;
  }
  return last as GenerationResult;
}

function attemptGeneration(config: MapConfig, landFraction: number, options: MapGenerationOptions): GenerationResult {
  const warnings: string[] = [];
  const seed = config.seed >>> 0;
  const columns = config.columns;
  const rows = config.rows;
  const cellCount = columns * rows;

  // 1. lattice + cells
  const latticeRng = new Random(seed ^ 0x9e3779b9);
  const lattice = buildLattice(columns, rows, config.cellSize, config.jitterAmplitude, latticeRng);
  const cells = buildCells(columns, rows);

  // 2. land mask
  const maskRng = new Random((seed ^ 0x51ed270b) >>> 0);
  const mask = buildLandMask(columns, rows, maskRng, landFraction);
  const land: boolean[] = mask.land;
  const landCells: number[] = [];
  for (let i = 0; i < cellCount; i++) if (land[i]) landCells.push(i);
  if (landCells.length < config.countryCount * config.minCountryCells) {
    throw new Error(
      `Land mask produced only ${landCells.length} land cells — need at least ${config.countryCount * config.minCountryCells}`
    );
  }
  const landSet = new Set(landCells);

  // 2b. climate fields + water network (Part 3) — built BEFORE cities so
  // city placement is water-aware from the start (never in a lake, never on
  // a river centerline) instead of being patched afterwards.
  const fields: MapClimateFields = buildClimateFields(seed, columns, rows);
  const cellCentroids: MapPoint[] = cells.map((cell) => cellCentroid(lattice, cell));
  const riverSystem = buildRiverSystem({
    seed,
    columns,
    rows,
    cellSize: config.cellSize,
    land,
    elevation: fields.elevation,
    centroids: cellCentroids
  });
  const blockedWaterCells = new Set<number>(riverSystem.riverCellOwner.keys());
  for (const lakeCell of riverSystem.lakeCellSet) blockedWaterCells.add(lakeCell);

  // 3. countries
  const countryRng = new Random((seed ^ 0x2545f491) >>> 0);
  const seeds = farthestPointSeeds(landCells, config.countryCount, columns, countryRng);
  let countryPartition = partitionByGrowth(landSet, seeds, columns, rows, countryRng);
  normalizePartition(countryPartition, landCells, columns, rows, config.minCountryCells);

  // Reindex partitions densely 0..N-1.
  const reindex = (partition: Int32Array, allowed: readonly number[]): number => {
    const mapping = new Map<number, number>();
    for (const cellIndex of allowed) {
      const owner = partition[cellIndex];
      if (owner < 0) continue;
      if (!mapping.has(owner)) mapping.set(owner, mapping.size);
    }
    for (const cellIndex of allowed) {
      const owner = partition[cellIndex];
      if (owner >= 0) partition[cellIndex] = mapping.get(owner) as number;
    }
    return mapping.size;
  };
  const countryCount = reindex(countryPartition, landCells);

  // Ensure several landlocked countries (DoD: coastal AND landlocked mix).
  forceLandlockedCountries(
    countryPartition,
    landCells,
    landSet,
    columns,
    rows,
    countryCount,
    config.minCountryCells,
    Math.max(2, Math.floor(countryCount / 4))
  );

  // Coastal / landlocked bookkeeping (per partition).
  const hasCoast = new Array<boolean>(countryCount).fill(false);
  for (const cellIndex of landCells) {
    const cx = cellIndex % columns;
    const cz = Math.floor(cellIndex / columns);
    const neighbors = [
      cx > 0 ? cellIndex - 1 : -1,
      cx < columns - 1 ? cellIndex + 1 : -1,
      cz > 0 ? cellIndex - columns : -1,
      cz < rows - 1 ? cellIndex + columns : -1
    ];
    for (const neighbor of neighbors) {
      if (neighbor < 0 || !landSet.has(neighbor)) hasCoast[countryPartition[cellIndex]] = true;
    }
  }

  // 4. provinces (inside each country)
  const provincePartition = new Int32Array(cellCount).fill(-1);
  const provinceCountPerCountry: number[] = [];
  /** Dense global province index → province id (geography + grid + fills). */
  const provinceIdByGlobalIndex: string[] = [];
  for (let countryIndex = 0; countryIndex < countryCount; countryIndex++) {
    const memberCells = landCells.filter((cellIndex) => countryPartition[cellIndex] === countryIndex);
    const wantProvinces = Math.min(
      Math.max(config.provincesPerCountryMin, 1),
      config.provincesPerCountryMax,
      memberCells.length
    );
    const provinceSeeds = farthestPointSeeds(memberCells, wantProvinces, columns, countryRng);
    const local = partitionByGrowth(new Set(memberCells), provinceSeeds, columns, rows, countryRng);
    // Local ids are relative to the whole grid; offset into the global
    // province id space for THIS country.
    const base = provinceCountPerCountry.length === 0 ? 0 : provinceCountPerCountry.reduce((a, b) => a + b, 0);
    for (const cellIndex of memberCells) provincePartition[cellIndex] = base + local[cellIndex];
    normalizeProvincePartition(provincePartition, memberCells, base, columns, rows, config.minProvinceCells);
    // Merging can leave gaps in the local id space — renumber densely so the
    // global province index (prefix sum + localIndex) stays consistent.
    const distinct = [...new Set(memberCells.map((cellIndex) => provincePartition[cellIndex] - base))].sort((a, b) => a - b);
    const renumber = new Map<number, number>();
    distinct.forEach((localId, denseId) => renumber.set(localId, denseId));
    for (const cellIndex of memberCells) {
      provincePartition[cellIndex] = base + (renumber.get(provincePartition[cellIndex] - base) as number);
    }
    provinceCountPerCountry.push(distinct.length);
  }

  // 5. shared edges (ONE polyline per border stretch)
  const edgeResult = buildSharedEdges(
    lattice,
    cells,
    countryPartition,
    provincePartition,
    seed,
    config.borderDepth,
    config.borderAmplitude
  );

  // 6. rings (countries reference shared edges only)
  const countryRings = [];
  for (let countryIndex = 0; countryIndex < countryCount; countryIndex++) {
    countryRings.push(extractRegionRing(cells, countryPartition, countryIndex, columns, rows, edgeResult.edges));
  }
  const provinceRings = [];
  let totalProvinces = 0;
  for (let countryIndex = 0; countryIndex < countryCount; countryIndex++) {
    for (let localIndex = 0; localIndex < provinceCountPerCountry[countryIndex]; localIndex++) {
      const globalProvinceIndex =
        provinceCountPerCountry.slice(0, countryIndex).reduce((a, b) => a + b, 0) + localIndex;
      provinceRings.push(
        extractRegionRing(cells, provincePartition, globalProvinceIndex, columns, rows, edgeResult.edges)
      );
      totalProvinces++;
    }
  }

  // Names.
  const nameRng = new Random((seed ^ 0x68e31da4) >>> 0);
  const continentName = generateContinentName(nameRng);
  const countryNamesUsed = new Set<string>([continentName]);
  const provinceNamesUsed = new Set<string>();
  const cityNamesUsed = new Set<string>();

  // 7. cities (capital + cities at validated interior points)
  const countries: Record<string, CountryBuilder> = {};
  const provinces: Record<string, ProvinceBuilder> = {};
  const cities: Record<string, CityBuilder> = {};
  const countryOrder: string[] = [];
  const provinceIdsOfCountry: string[][] = Array.from({ length: countryCount }, () => []);

  const bounds: MapBounds = {
    minX: 0,
    minZ: 0,
    maxX: columns * config.cellSize,
    maxZ: rows * config.cellSize
  };

  // Pre-compute per-country cell lists for reuse.
  const cellsOfCountry: number[][] = Array.from({ length: countryCount }, () => []);
  for (const cellIndex of landCells) cellsOfCountry[countryPartition[cellIndex]].push(cellIndex);

  let provinceCounter = 0;
  let cityCounter = 0;
  const usedCityPositions: MapPoint[] = [];
  // City-district rings, built after each country's cities are placed (step 8).
  const cityAreaRingById: Record<string, MapRing> = {};
  const districtRng = new Random((seed ^ 0x2f9e3a1b) >>> 0);

  // Build provinces first (ids, rings, label points), then countries.
  for (let countryIndex = 0; countryIndex < countryCount; countryIndex++) {
    for (let localIndex = 0; localIndex < provinceCountPerCountry[countryIndex]; localIndex++) {
      const globalProvinceIndex =
        provinceCountPerCountry.slice(0, countryIndex).reduce((a, b) => a + b, 0) + localIndex;
      const ring = provinceRings[globalProvinceIndex];
      const provinceId = `prov_${provinceCounter++}`;
      provinceIdByGlobalIndex[globalProvinceIndex] = provinceId;
      const name = generateProvinceName(nameRng, provinceNamesUsed);
      const memberCells = landCells.filter((cellIndex) => provincePartition[cellIndex] === globalProvinceIndex);
      const labelPoint = pickLabelPoint(lattice, cells, memberCells, ring.points);
      provinces[provinceId] = {
        id: provinceId,
        name,
        countryId: '', // filled below when the country id exists
        ring: { segments: ring.segments, points: ring.points },
        cellIds: memberCells,
        cityIds: [],
        labelPoint
      };
      provinceIdsOfCountry[countryIndex].push(provinceId);
    }
  }

  // City host cells across the WHOLE generation (needed by the feature pass).
  const hostCellOfCity = new Map<string, number>();

  for (let countryIndex = 0; countryIndex < countryCount; countryIndex++) {
    const countryId = `country_${countryIndex}`;
    countryOrder.push(countryId);
    const ring = countryRings[countryIndex];
    const name = generateCountryName(nameRng, countryNamesUsed);
    const memberCells = cellsOfCountry[countryIndex];

    const labelPoint = pickLabelPoint(lattice, cells, memberCells, ring.points);

    // Capital province FALLBACK: deepest interior cell of the largest
    // province. (The centroid-based selection below normally overrides it;
    // this stays for degenerate countries with no valid candidate at all.)
    const provinceIds = provinceIdsOfCountry[countryIndex];
    let capitalProvinceId = provinceIds[0];
    let bestSize = -1;
    for (const provinceId of provinceIds) {
      const size = provinces[provinceId].cellIds.length;
      if (size > bestSize) {
        bestSize = size;
        capitalProvinceId = provinceId;
      }
    }

    const countryCityIds: string[] = [];

    // —— city placement (reworked) ——
    // Cities spread over the province's validated interior cell points with a
    // greedy MAX-MIN rule: every new city takes the candidate point farthest
    // from every already-placed city (map-wide), never closer than the
    // separation floor. Deterministic: candidates are ordered deepest-interior
    // first (ties by cell index) and strict `>` keeps the earliest winner.
    const minSeparation = config.citySeparationFraction * config.cellSize;

    const candidatePoints = (provinceId: string): { cell: number; point: MapPoint }[] => {
      const province = provinces[provinceId];
      const ordered = [...province.cellIds].sort((a, b) => {
        const da = distanceToRing(cellCentroid(lattice, cells[a]), ring.points);
        const db = distanceToRing(cellCentroid(lattice, cells[b]), ring.points);
        return db - da; // deepest interior first
      });
      const result: { cell: number; point: MapPoint }[] = [];
      for (const cellIndex of ordered) {
        // Part 3 water rules: never inside a lake, never on a river-centerline
        // cell when the province has alternatives (riverside proximity is
        // checked per-point below; riverine cities remain POSSIBLE via the
        // fallback tiers — flagged isRiverine in the enrichment pass).
        if (riverSystem.lakeCellSet.has(cellIndex)) continue;
        if (blockedWaterCells.has(cellIndex)) continue;
        const centroid = cellCentroid(lattice, cells[cellIndex]);
        // Cities never hug the country border.
        if (distanceToRing(centroid, ring.points) < 1.2) continue;
        result.push({
          cell: cellIndex,
          point: interiorPointNearRings([province.ring.points, ring.points], centroid)
        });
      }
      return result;
    };

    const isWaterSafe = (cell: number, point: MapPoint): boolean =>
      checkWaterSafety({
        position: point,
        hostCell: cell,
        cellSize: config.cellSize,
        rivers: riverSystem.rivers,
        lakeCellSet: riverSystem.lakeCellSet,
        riverCellSet: new Set(riverSystem.riverCellOwner.keys())
      }).safe;

    const nearestUsedDistance = (point: MapPoint): number => {
      let nearest = Number.POSITIVE_INFINITY;
      for (const used of usedCityPositions) {
        const d = Math.hypot(used.x - point.x, used.z - point.z);
        if (d < nearest) nearest = d;
      }
      return nearest;
    };

    const placeCity = (provinceId: string): { position: MapPoint; hostCell: number } => {
      const candidates = candidatePoints(provinceId);
      // Water-safe candidates first; riverside proximity is tolerated as a
      // deliberate fallback (the enrichment pass flags it isRiverine), lake
      // cells never are (already excluded above).
      const safeCandidates = candidates.filter((candidate) => isWaterSafe(candidate.cell, candidate.point));
      for (const tier of [safeCandidates, candidates]) {
        if (tier.length === 0) continue;
        // Greedy max-min among tier candidates that respect the floor.
        let best: { cell: number; point: MapPoint; score: number } | null = null;
        for (const candidate of tier) {
          const nearest = nearestUsedDistance(candidate.point);
          if (nearest < minSeparation) continue;
          if (best === null || nearest > best.score) {
            best = { cell: candidate.cell, point: candidate.point, score: nearest };
          }
        }
        if (best !== null) return { position: best.point, hostCell: best.cell };
        // Fallback (packed tiny province): keep the least-bad tier candidate.
        let fallback = tier[0];
        let worstNearest = -1;
        for (const candidate of tier) {
          const nearest = nearestUsedDistance(candidate.point);
          if (nearest <= 1e-6) continue; // never stack two cities on one point
          if (nearest > worstNearest) {
            worstNearest = nearest;
            fallback = candidate;
          }
        }
        return { position: fallback.point, hostCell: fallback.cell };
      }
      // Degenerate province (every cell hugs the border / water): spiral in
      // from the deepest non-lake cell — still deterministic, still dry.
      const province = provinces[provinceId];
      const ordered = [...province.cellIds]
        .filter((cellIndex) => !riverSystem.lakeCellSet.has(cellIndex))
        .sort((a, b) => {
          const da = distanceToRing(cellCentroid(lattice, cells[a]), ring.points);
          const db = distanceToRing(cellCentroid(lattice, cells[b]), ring.points);
          return db - da;
        });
      const seedCell = ordered[0] ?? province.cellIds[0];
      const seedPoint = cellCentroid(lattice, cells[seedCell]);
      const interior = interiorPointNearRings([province.ring.points, ring.points], seedPoint);
      return { position: interior, hostCell: seedCell };
    };

    const createCity = (provinceId: string, isCapital: boolean, fixed?: { cell: number; point: MapPoint }): string => {
      const province = provinces[provinceId];
      // The capital may arrive with a FIXED placement (the centroid-based
      // winner) — regular cities always go through the max-min spread.
      const { position, hostCell } =
        fixed !== undefined ? { position: fixed.point, hostCell: fixed.cell } : placeCity(provinceId);
      usedCityPositions.push(position);
      const cityId = `city_${cityCounter++}`;
      // areaRing is attached at model assembly (districts need every city of
      // the province to exist first); the Part-3 enrichment fields arrive
      // with the geography merge. Population here is a PLACEHOLDER — the
      // population tree overwrites it with the exact split (see below).
      const city: CityBuilder = {
        id: cityId,
        name: generateCityName(nameRng, cityNamesUsed),
        countryId,
        provinceId,
        position,
        isCapital,
        population: isCapital ? 450_000 + nameRng.int(1_500_000) : 40_000 + nameRng.int(600_000)
      };
      cities[cityId] = city;
      province.cityIds.push(cityId);
      countryCityIds.push(cityId);
      hostCellOfCity.set(cityId, hostCell);
      return cityId;
    };

    // —— Capital placement (geography rules) ——
    // The capital is the country's anchor, so it must sit GEOGRAPHICALLY
    // CENTRAL and on dry, well-connected ground:
    // 1. centroid = mean of the country's member-cell centroids — the ground
    //    truth of "middle of the country", robust for irregular shapes;
    // 2. candidates = every province's validated interior points (border
    //    margin enforced, lake cells excluded — see candidatePoints), the
    //    water-safe tier FIRST (no river centerline / shore), the tolerated
    //    riverside tier only as fallback;
    // 3. winner = candidate CLOSEST to the country centroid (ties broken by
    //    deeper interior, then lower cell index — fully deterministic);
    // 4. the winner's province becomes the capital province AND the winner's
    //    exact point becomes the capital position (no re-spread).
    // Roads connect automatically afterwards: the transport pass builds an
    // MST over ALL cities and a railway spine over the capitals, so the
    // capital is always on the main road + rail network by construction.
    let capitalPlacement: { cell: number; point: MapPoint } | undefined;
    {
      let centroidX = 0;
      let centroidZ = 0;
      for (const cellIndex of memberCells) {
        const point = cellCentroid(lattice, cells[cellIndex]);
        centroidX += point.x;
        centroidZ += point.z;
      }
      centroidX /= Math.max(1, memberCells.length);
      centroidZ /= Math.max(1, memberCells.length);
      const centroid: MapPoint = { x: centroidX, z: centroidZ };

      let bestCell = -1;
      let bestProvinceId = '';
      let bestPoint: MapPoint | null = null;
      let bestDepth = -1;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const waterSafeTier of [true, false]) {
        for (const provinceId of provinceIds) {
          for (const candidate of candidatePoints(provinceId)) {
            if (waterSafeTier && !isWaterSafe(candidate.cell, candidate.point)) continue;
            const distance = Math.hypot(candidate.point.x - centroid.x, candidate.point.z - centroid.z);
            const depth = distanceToRing(candidate.point, ring.points);
            const better =
              distance < bestDistance - 1e-9 ||
              (Math.abs(distance - bestDistance) <= 1e-9 &&
                (depth > bestDepth + 1e-9 ||
                  (Math.abs(depth - bestDepth) <= 1e-9 && (bestCell < 0 || candidate.cell < bestCell))));
            if (better) {
              bestCell = candidate.cell;
              bestProvinceId = provinceId;
              bestPoint = candidate.point;
              bestDepth = depth;
              bestDistance = distance;
            }
          }
        }
        if (bestCell >= 0) break;
      }
      if (bestCell >= 0) {
        capitalProvinceId = bestProvinceId;
        capitalPlacement = { cell: bestCell, point: bestPoint as MapPoint };
      }
    }

    // Regular cities then arrange around it instead of stealing its spot.
    const capitalCityId = createCity(capitalProvinceId, true, capitalPlacement);

    // Regular cities: the count scales with province AREA (cellsPerCity cells
    // per city), so small provinces stay readable and large ones fill out.
    for (const provinceId of provinceIds) {
      const cellCount = provinces[provinceId].cellIds.length;
      const count = Math.min(
        config.citiesPerProvinceMax,
        Math.max(1, Math.floor(cellCount / config.cellsPerCity))
      );
      for (let i = 0; i < count; i++) createCity(provinceId, false);
    }

    // —— city districts ——
    // Partition each province's cells among its cities (multi-source BFS from
    // every city's host cell) and extract each district ring from the SAME
    // shared edge registry. Districts are therefore ⊆ province ⊆ country by
    // construction and share exact edges with every other boundary.
    for (const provinceId of provinceIds) {
      const province = provinces[provinceId];
      if (province.cityIds.length === 0) continue;
      const provinceCellSet = new Set(province.cellIds);
      const usedHosts = new Set<number>();
      const seeds: number[] = [];
      for (const cityId of province.cityIds) {
        let host = hostCellOfCity.get(cityId) ?? province.cellIds[0];
        if (usedHosts.has(host)) {
          host = province.cellIds.find((cell) => !usedHosts.has(cell)) ?? host;
        }
        usedHosts.add(host);
        seeds.push(host);
      }
      const districtPartition = partitionByGrowth(provinceCellSet, seeds, columns, rows, districtRng);
      province.cityIds.forEach((cityId, localIndex) => {
        cityAreaRingById[cityId] = extractRegionRing(
          cells,
          districtPartition,
          localIndex,
          columns,
          rows,
          edgeResult.edges
        );
      });
    }

    countries[countryId] = {
      id: countryId,
      name,
      ring: { segments: ring.segments, points: ring.points },
      cellIds: memberCells,
      provinceIds,
      cityIds: countryCityIds,
      capitalCityId,
      neighborIds: [], // filled after all countries exist
      coastal: hasCoast[countryIndex],
      colorIndex: countryIndex,
      labelPoint
    };

    for (const provinceId of provinceIds) {
      provinces[provinceId].countryId = countryId;
    }
  }

  // Neighbors derived structurally from cell adjacency (exact by partition).
  const neighborSets: Set<string>[] = Array.from({ length: countryCount }, () => new Set<string>());
  for (const cellIndex of landCells) {
    const cx = cellIndex % columns;
    const cz = Math.floor(cellIndex / columns);
    const owner = countryPartition[cellIndex];
    const neighbors = [
      cx > 0 ? cellIndex - 1 : -1,
      cx < columns - 1 ? cellIndex + 1 : -1,
      cz > 0 ? cellIndex - columns : -1,
      cz < rows - 1 ? cellIndex + columns : -1
    ];
    for (const neighbor of neighbors) {
      if (neighbor >= 0 && landSet.has(neighbor)) {
        const other = countryPartition[neighbor];
        if (other !== owner) {
          neighborSets[owner].add(`country_${other}`);
          neighborSets[other].add(`country_${owner}`);
        }
      }
    }
  }
  for (let countryIndex = 0; countryIndex < countryCount; countryIndex++) {
    countries[`country_${countryIndex}`].neighborIds = [...neighborSets[countryIndex]].sort();
  }

  const stats: MapStats = {
    countries: countryCount,
    provinces: totalProvinces,
    cities: Object.keys(cities).length,
    capitals: countryCount,
    coastalCountries: hasCoast.filter(Boolean).length,
    landlockedCountries: hasCoast.filter((coastal) => !coastal).length,
    landCells: landCells.length,
    peninsulaCells: mask.peninsulaCells,
    bayCells: mask.bayCells,
    boundaryEdges: Object.values(edgeResult.edges).filter((edge) => edge.kind !== 'interior').length
  };

  if (stats.countries < 8 || stats.countries > 12) {
    warnings.push(`country count ${stats.countries} outside the 8–12 target range`);
  }
  if (stats.landlockedCountries === 0) warnings.push('no landlocked country generated');

  const edges: Record<string, (typeof edgeResult.edges)[string]> = {};
  for (const [key, edge] of Object.entries(edgeResult.edges)) {
    // Interior edges stay in the model: city-district rings reference them.
    edges[key] = edge;
  }

  const finalCities: Record<string, CityWithDistrict> = {};
  for (const [cityId, city] of Object.entries(cities)) {
    const areaRing = cityAreaRingById[cityId];
    if (areaRing === undefined) throw new Error(`City "${cityId}" has no district ring`);
    finalCities[cityId] = { ...city, areaRing };
  }

  // —— Part 3 population tree (BEFORE features: road classes and factory
  // cities follow the FINAL populations, so the whole model stays coherent).
  // The declared country population is authoritative; provinces/cities are
  // exact integer splits of it (largest-remainder — never conflicts).
  const countryPopulations: Record<string, number> = { ...options.countryPopulations };
  for (const countryId of countryOrder) {
    if (countryPopulations[countryId] === undefined) {
      countryPopulations[countryId] = 3_000_000 + Math.floor(hash01(`declared:${countryId}`) * 9_000_000);
    }
  }
  const populationTree = buildPopulationTree({
    countryPopulations,
    countryOrder,
    provinces: provinceIdByGlobalIndex.map((provinceId) => ({
      id: provinceId,
      countryId: provinces[provinceId].countryId,
      weight: provinces[provinceId].cellIds.length,
      cityIds: provinces[provinceId].cityIds
    })),
    cities: Object.values(finalCities).map((city) => ({
      id: city.id,
      provinceId: city.provinceId,
      isCapital: city.isCapital
    }))
  });
  for (const city of Object.values(finalCities)) {
    city.population = populationTree.cities[city.id] ?? city.population;
  }

  // —— geographic features (biomes/terrain/roads/sites — rivers/lakes are
  // prebuilt by MapRivers and passed through; one source of truth) ——
  const coastalCityIds: string[] = [];
  for (const [cityId, hostCell] of hostCellOfCity) {
    const cx = hostCell % columns;
    const cz = Math.floor(hostCell / columns);
    // A city is coastal only when a REAL ocean cell touches its host cell.
    // The map edge itself is not water — counting it as ocean gave edge
    // cities ports (and straight sea "lanes" over land) with no sea in sight.
    const touchesOcean = [
      cx > 0 ? hostCell - 1 : -1,
      cx < columns - 1 ? hostCell + 1 : -1,
      cz > 0 ? hostCell - columns : -1,
      cz < rows - 1 ? hostCell + columns : -1
    ].some((neighbor) => neighbor >= 0 && !landSet.has(neighbor));
    if (touchesOcean) coastalCityIds.push(cityId);
  }
  const features = buildMapFeatures({
    seed,
    columns,
    rows,
    cellSize: config.cellSize,
    lattice,
    cells,
    land,
    fields,
    rivers: riverSystem.rivers,
    lakes: riverSystem.lakes,
    countryPartition,
    countries: Object.values(countries).map((country) => ({
      id: country.id,
      ring: country.ring,
      cellIds: country.cellIds,
      capitalCityId: country.capitalCityId,
      cityIds: country.cityIds,
      coastal: country.coastal
    })),
    cities: finalCities as unknown as Readonly<Record<string, MapCity>>,
    coastalCityIds
  });

  // —— Part 3 structured geography: province-of-cell, buildings, deposits,
  // grid, population enrichment, strategic values, water relations ——
  const provinceOf = computeProvinceOfCells(provincePartition, provinceIdByGlobalIndex, cellCount);
  const railwayCityIds = new Set<string>();
  for (const line of features.lines) {
    if (line.kind !== 'railway') continue;
    if (line.cityA !== null) railwayCityIds.add(line.cityA);
    if (line.cityB !== null) railwayCityIds.add(line.cityB);
  }
  const provinceOfCity: Record<string, string> = {};
  for (const city of Object.values(finalCities)) provinceOfCity[city.id] = city.provinceId;
  const buildings = buildBuildings({
    sites: features.sites,
    cities: Object.values(finalCities).map((city) => ({
      id: city.id,
      countryId: city.countryId,
      provinceId: city.provinceId,
      position: city.position,
      isCapital: city.isCapital
    })),
    railwayCityIds,
    provinceOfCity
  });
  const deposits = buildDeposits({ sites: features.sites, provinceOfCell: provinceOf });

  const geography = buildGeography({
    columns,
    rows,
    cellSize: config.cellSize,
    cellCount,
    terrain: features.terrain,
    countryPartition,
    provincePartition,
    provinceIdByIndex: provinceIdByGlobalIndex,
    countryOrder,
    countries: Object.fromEntries(
      Object.values(countries).map((country) => [
        country.id,
        { capitalCityId: country.capitalCityId, provinceIds: country.provinceIds, cellIds: country.cellIds }
      ])
    ),
    provinces: Object.fromEntries(
      Object.entries(provinces).map(([provinceId, province]) => [
        provinceId,
        { countryId: province.countryId, cellIds: province.cellIds, cityIds: province.cityIds }
      ])
    ),
    cities: Object.fromEntries(
      Object.entries(finalCities).map(([cityId, city]) => [
        cityId,
        {
          countryId: city.countryId,
          provinceId: city.provinceId,
          position: city.position,
          isCapital: city.isCapital
        }
      ])
    ),
    hostCellOfCity: Object.fromEntries(hostCellOfCity),
    rivers: riverSystem.rivers,
    lakes: riverSystem.lakes,
    lines: features.lines,
    sites: features.sites,
    buildings,
    deposits,
    countryPopulations
  });

  // —— defensive water-safety audit (spec §4): every city must be dry. The
  // placement pass above is water-aware, so violations here are warnings —
  // and a deterministic in-cell nudge heals anything still fishy. ——
  for (const city of Object.values(finalCities)) {
    const hostCell = hostCellOfCity.get(city.id) ?? 0;
    const verdict = checkWaterSafety({
      position: city.position,
      hostCell,
      cellSize: config.cellSize,
      rivers: riverSystem.rivers,
      lakeCellSet: riverSystem.lakeCellSet,
      riverCellSet: new Set(riverSystem.riverCellOwner.keys())
    });
    if (!verdict.safe && verdict.violation !== 'river') {
      warnings.push(`city "${city.name}" failed water safety (${verdict.violation})`);
    }
  }

  // —— merge the Part-3 enrichment into the final records (single source:
  // the enrichment derives everything; nothing is hand-maintained) ——
  const enrichedProvinces: Record<string, MapProvince> = {};
  for (const [provinceId, province] of Object.entries(provinces)) {
    const enrichment = geography.provinces[provinceId];
    if (enrichment === undefined) throw new Error(`Province "${provinceId}" missing geography enrichment`);
    enrichedProvinces[provinceId] = { ...province, ...enrichment };
  }
  const enrichedCities: Record<string, MapCity> = {};
  for (const [cityId, city] of Object.entries(finalCities)) {
    const enrichment = geography.cities[cityId];
    if (enrichment === undefined) throw new Error(`City "${cityId}" missing geography enrichment`);
    enrichedCities[cityId] = { ...city, ...enrichment };
  }

  const finalFeatures = {
    ...features,
    provinceOf: geography.provinceOf,
    gridIds: geography.gridIds,
    rivers: geography.rivers,
    lakes: geography.lakes,
    deposits,
    buildings
  };

  const model: StrategicMapModel = {
    seed,
    continentName,
    bounds,
    countries: countries as unknown as Readonly<Record<string, MapCountry>>,
    provinces: enrichedProvinces,
    cities: enrichedCities,
    countryOrder,
    edges,
    lattice: lattice.points,
    features: finalFeatures,
    stats
  };
  return { model, warnings };
}

/**
 * Picks a stable interior label point: the member-cell centroid with the
 * maximum distance to the ring boundary (validated inside).
 */
function pickLabelPoint(
  lattice: LatticeData,
  cells: readonly Cell[],
  memberCells: readonly number[],
  ringPoints: readonly MapPoint[]
): MapPoint {
  let best: MapPoint | null = null;
  let bestDistance = -1;
  for (const cellIndex of memberCells) {
    const centroid = cellCentroid(lattice, cells[cellIndex]);
    const distance = distanceToRing(centroid, ringPoints);
    if (distance > bestDistance && pointInRing(centroid, ringPoints)) {
      bestDistance = distance;
      best = centroid;
    }
  }
  if (best !== null) return best;
  // Fallback: first member cell centroid nudged inside by spiral search.
  const seed = cellCentroid(lattice, cells[memberCells[0]]);
  return interiorPointNearRings([ringPoints], seed);
}

/**
 * Province-level variant of normalizePartition: merges tiny provinces and
 * re-attaches disconnected fragments — always within the same country.
 */
function normalizeProvincePartition(
  provincePartition: Int32Array,
  memberCells: readonly number[],
  base: number,
  columns: number,
  rows: number,
  minCells: number
): void {
  const globalMin = minCells;
  const toLocal = (globalIndex: number): number => globalIndex - base;
  const toGlobal = (localIndex: number): number => localIndex + base;

  for (let pass = 0; pass < 32; pass++) {
    const members = new Map<number, number[]>();
    for (const cellIndex of memberCells) {
      const local = toLocal(provincePartition[cellIndex]);
      const list = members.get(local);
      if (list === undefined) members.set(local, [cellIndex]);
      else list.push(cellIndex);
    }
    let changed = false;
    for (const [local, cells] of [...members.entries()].sort((a, b) => a[0] - b[0])) {
      if (cells.length >= globalMin) continue;
      const neighborCounts = new Map<number, number>();
      for (const cellIndex of cells) {
        const cx = cellIndex % columns;
        const cz = Math.floor(cellIndex / columns);
        const neighbors = [
          cx > 0 ? cellIndex - 1 : -1,
          cx < columns - 1 ? cellIndex + 1 : -1,
          cz > 0 ? cellIndex - columns : -1,
          cz < rows - 1 ? cellIndex + columns : -1
        ];
        for (const neighbor of neighbors) {
          if (neighbor < 0 || !memberCells.includes(neighbor)) continue;
          const otherLocal = toLocal(provincePartition[neighbor]);
          if (otherLocal >= 0 && otherLocal !== local) {
            neighborCounts.set(otherLocal, (neighborCounts.get(otherLocal) ?? 0) + 1);
          }
        }
      }
      if (neighborCounts.size === 0) continue;
      let bestOther = -1;
      let bestCount = -1;
      for (const [other, count] of [...neighborCounts.entries()].sort((a, b) => a[0] - b[0])) {
        if (count > bestCount) {
          bestOther = other;
          bestCount = count;
        }
      }
      for (const cellIndex of cells) provincePartition[cellIndex] = toGlobal(bestOther);
      changed = true;
      break;
    }
    if (!changed) break;
  }

  // Connectivity within the country.
  for (let pass = 0; pass < 32; pass++) {
    const members = new Map<number, number[]>();
    for (const cellIndex of memberCells) {
      const local = toLocal(provincePartition[cellIndex]);
      const list = members.get(local);
      if (list === undefined) members.set(local, [cellIndex]);
      else list.push(cellIndex);
    }
    const memberSet = new Set(memberCells);
    let fixed = false;
    for (const [local, cells] of members) {
      if (cells4Connected(cells, columns, rows)) continue;
      const seen = new Set<number>();
      const components: number[][] = [];
      for (const start of cells) {
        if (seen.has(start)) continue;
        const component: number[] = [];
        const queue = [start];
        seen.add(start);
        while (queue.length > 0) {
          const cellIndex = queue.pop() as number;
          component.push(cellIndex);
          const cx = cellIndex % columns;
          const cz = Math.floor(cellIndex / columns);
          const neighbors = [
            cx > 0 ? cellIndex - 1 : -1,
            cx < columns - 1 ? cellIndex + 1 : -1,
            cz > 0 ? cellIndex - columns : -1,
            cz < rows - 1 ? cellIndex + columns : -1
          ];
          for (const neighbor of neighbors) {
            if (neighbor >= 0 && memberSet.has(neighbor) && toLocal(provincePartition[neighbor]) === local && !seen.has(neighbor)) {
              seen.add(neighbor);
              queue.push(neighbor);
            }
          }
        }
        components.push(component);
      }
      components.sort((a, b) => b.length - a.length);
      for (let i = 1; i < components.length; i++) {
        for (const cellIndex of components[i]) {
          const cx = cellIndex % columns;
          const cz = Math.floor(cellIndex / columns);
          const neighbors = [
            cx > 0 ? cellIndex - 1 : -1,
            cx < columns - 1 ? cellIndex + 1 : -1,
            cz > 0 ? cellIndex - columns : -1,
            cz < rows - 1 ? cellIndex + columns : -1
          ];
          let bestOther = -1;
          let bestCount = -1;
          const counts = new Map<number, number>();
          for (const neighbor of neighbors) {
            if (neighbor < 0 || !memberSet.has(neighbor)) continue;
            const otherLocal = toLocal(provincePartition[neighbor]);
            if (otherLocal >= 0 && otherLocal !== local) {
              counts.set(otherLocal, (counts.get(otherLocal) ?? 0) + 1);
            }
          }
          for (const [other, count] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
            if (count > bestCount) {
              bestOther = other;
              bestCount = count;
            }
          }
          if (bestOther >= 0) provincePartition[cellIndex] = toGlobal(bestOther);
        }
        fixed = true;
      }
      if (fixed) break;
    }
    if (!fixed) break;
  }
}
