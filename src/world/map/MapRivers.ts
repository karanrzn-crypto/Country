/**
 * MapRivers — the Part-3 water network builder.
 *
 * Replaces the preview greedy rivers with a REAL drainage network built on
 * the classic priority-flood (fill-sinks) algorithm, deterministic end to
 * end:
 *
 *   1. Priority-flood  — land cells are flooded from the sea in ascending
 *                        elevation order (binary heap, deterministic ties).
 *                        Every cell gets `filled` = the water-surface level
 *                        of its depression (≥ own elevation) and a PARENT
 *                        (the neighbor it was flooded from) — the drainage
 *                        tree. EVERY cell therefore drains to the ocean:
 *                        no dead ends, ever.
 *   2. Lakes           — connected components where `filled − elevation` is
 *                        a real depth are lake records: the depression is
 *                        submerged up to its spill level, depth is real,
 *                        and the tree's exit edge IS the natural outlet.
 *   3. Flow accumulation — cells in DESCENDING filled order push their
 *                        upstream count into their parent (topological —
 *                        filled[parent] ≤ filled[child] by construction).
 *   4. Channel tracing — cells with accumulation ≥ threshold form channels.
 *                        Walks start at channel HEADS (no channel upstream)
 *                        and follow the tree downhill: longest networks
 *                        claim junctions first (main stems), later walks end
 *                        at claimed cells as TRIBUTARIES (mouthType 'river').
 *                        Walks never climb (filled is non-increasing along
 *                        the tree) and always reach the sea or a confluence.
 *   5. Geometry        — ONE cached jittered point per cell, shared: a
 *                        tributary's last polyline point IS the parent's
 *                        point at the confluence cell → continuous
 *                        confluence geometry by construction.
 *
 * The river `elevations` profile is the WATER-SURFACE (filled) profile —
 * non-increasing by construction, physically the hydraulic grade line.
 *
 * Pure TypeScript: no Three.js, no DOM, seeded and byte-identical per seed.
 */

import { Random } from '../../utils/Random';
import { generateCityName } from './MapNames';
import type { MapLake, MapPoint, MapRiver } from './MapTypes';

/** Tunable network policy (module constants — one documented place). */
const EPSILON = 1e-6; // flat-terrain drainage increment (filled surface)
const LAKE_MIN_DEPTH = 0.02; // submerged depth that counts as a real lake
const SOURCE_MIN_ELEVATION = 0.3; // channel heads start above this (original)
const NAVIGABLE_MIN_CELLS = 12;
const MAX_MAIN_RIVERS = 7;
const MAX_TRIBUTARIES = 10;
const MIN_MAIN_CELLS = 6;
const MIN_TRIBUTARY_CELLS = 3;
const POLYLINE_JITTER = 0.18; // fraction of cellSize (matches map jitter style)

export interface RiverSystemInput {
  readonly seed: number;
  readonly columns: number;
  readonly rows: number;
  readonly cellSize: number;
  /** Land mask (true = land cell). */
  readonly land: readonly boolean[];
  /** Normalized per-cell elevation 0..1. */
  readonly elevation: readonly number[];
  /** Per-cell centroid (world space). */
  readonly centroids: readonly MapPoint[];
}

export interface RiverSystem {
  readonly rivers: readonly MapRiver[];
  readonly lakes: readonly MapLake[];
  /** Cells covered by lakes (city placement + queries). */
  readonly lakeCellSet: ReadonlySet<number>;
  /** Cell → river id + path index (confluences, geometry, queries). */
  readonly riverCellOwner: ReadonlyMap<number, { readonly riverId: string; readonly pathIndex: number }>;
}

interface LakeBuilder {
  id: string;
  name: string;
  cells: number[];
  position: MapPoint;
  areaCells: number;
  depth: number;
  importance: number;
  inflowRiverIds: string[];
  outflowRiverIds: string[];
  provinceIds: string[];
  cityIds: string[];
}

interface RiverBuilder {
  id: string;
  name: string;
  cells: number[];
  sourceCell: number;
  mouthCell: number | null;
  mouthType: 'ocean' | 'lake' | 'river';
  parentRiverId: string | null;
  elevations: number[];
  length: number;
}

/** Minimal deterministic binary min-heap over (value, cellIndex). */
class MinHeap {
  private readonly values: number[] = [];
  private readonly cells: number[] = [];

  get size(): number {
    return this.values.length;
  }

  push(value: number, cellIndex: number): void {
    this.values.push(value);
    this.cells.push(cellIndex);
    let i = this.values.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.values[parent] <= this.values[i]) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): { value: number; cellIndex: number } | null {
    if (this.values.length === 0) return null;
    const value = this.values[0];
    const cellIndex = this.cells[0];
    const lastValue = this.values.pop() as number;
    const lastCell = this.cells.pop() as number;
    if (this.values.length > 0) {
      this.values[0] = lastValue;
      this.cells[0] = lastCell;
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        const right = left + 1;
        let smallest = i;
        if (left < this.values.length && this.values[left] < this.values[smallest]) smallest = left;
        if (right < this.values.length && this.values[right] < this.values[smallest]) smallest = right;
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return { value, cellIndex };
  }

  private swap(a: number, b: number): void {
    const v = this.values[a];
    this.values[a] = this.values[b];
    this.values[b] = v;
    const c = this.cells[a];
    this.cells[a] = this.cells[b];
    this.cells[b] = c;
  }
}

/**
 * Builds the complete water network. Deterministic: the flood order, tie
 * breaks and jitter are seeded — the same inputs yield identical results.
 */
export function buildRiverSystem(input: RiverSystemInput): RiverSystem {
  const { columns, rows, land, elevation } = input;
  const cellCount = columns * rows;
  const rng = new Random((input.seed ^ 0x51ab9e77) >>> 0);
  const nameRng = new Random((input.seed ^ 0x1c3f7a5d) >>> 0);
  const waterNames = new Set<string>();

  const neighborsOf = (cellIndex: number): number[] => {
    const cx = cellIndex % columns;
    const cz = Math.floor(cellIndex / columns);
    return [
      cx > 0 ? cellIndex - 1 : -1,
      cx < columns - 1 ? cellIndex + 1 : -1,
      cz > 0 ? cellIndex - columns : -1,
      cz < rows - 1 ? cellIndex + columns : -1
    ].filter((neighbor) => neighbor >= 0);
  };

  // —— 1. priority-flood (fill sinks) + drainage tree ——
  // parent: −2 = drains to the ocean · −1 = not flooded yet · ≥ 0 = parent cell.
  const filled = new Float64Array(cellCount);
  const parent = new Int32Array(cellCount).fill(-1);
  const closed = new Uint8Array(cellCount);
  const heap = new MinHeap();

  const isSeaLevelCell = (cellIndex: number): boolean => {
    const cx = cellIndex % columns;
    const cz = Math.floor(cellIndex / columns);
    return (
      cx === 0 ||
      cz === 0 ||
      cx === columns - 1 ||
      cz === rows - 1 ||
      neighborsOf(cellIndex).some((neighbor) => !land[neighbor])
    );
  };

  for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
    if (!land[cellIndex]) continue;
    if (isSeaLevelCell(cellIndex)) {
      filled[cellIndex] = elevation[cellIndex];
      parent[cellIndex] = -2;
      closed[cellIndex] = 1;
      heap.push(elevation[cellIndex], cellIndex);
    }
  }
  while (heap.size > 0) {
    const current = heap.pop()!;
    for (const neighbor of neighborsOf(current.cellIndex)) {
      if (!land[neighbor] || closed[neighbor]) continue;
      closed[neighbor] = 1;
      // The water surface never dips below the parent's surface (level or
      // epsilon-draining flats) nor below the cell's own ground.
      filled[neighbor] = Math.max(elevation[neighbor], filled[current.cellIndex] + EPSILON);
      parent[neighbor] = current.cellIndex;
      heap.push(filled[neighbor], neighbor);
    }
  }

  // —— 2. lakes: connected components with real submerged depth ——
  const lakeCellOwner = new Int32Array(cellCount).fill(-1); // cell → lake index
  const lakeBuilders: LakeBuilder[] = [];
  for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
    if (!land[cellIndex] || lakeCellOwner[cellIndex] >= 0) continue;
    if (filled[cellIndex] - elevation[cellIndex] <= LAKE_MIN_DEPTH) continue;
    // Flood-fill this lake component (deterministic BFS).
    const cells: number[] = [];
    const queue = [cellIndex];
    lakeCellOwner[cellIndex] = lakeBuilders.length;
    while (queue.length > 0) {
      const current = queue.shift() as number;
      cells.push(current);
      for (const neighbor of neighborsOf(current)) {
        if (!land[neighbor] || lakeCellOwner[neighbor] >= 0) continue;
        if (filled[neighbor] - elevation[neighbor] <= LAKE_MIN_DEPTH) continue;
        lakeCellOwner[neighbor] = lakeBuilders.length;
        queue.push(neighbor);
      }
    }
    let depth = 0;
    let x = 0;
    let z = 0;
    for (const lakeCell of cells) {
      depth = Math.max(depth, filled[lakeCell] - elevation[lakeCell]);
      const centroid = input.centroids[lakeCell];
      x += centroid.x;
      z += centroid.z;
    }
    lakeBuilders.push({
      id: `lake_${lakeBuilders.length}`,
      name: generateCityName(nameRng, waterNames),
      cells: [...cells].sort((a, b) => a - b),
      position: { x: x / cells.length, z: z / cells.length },
      areaCells: cells.length,
      depth: Math.min(1, depth),
      importance: Math.min(1, cells.length / 9),
      inflowRiverIds: [],
      outflowRiverIds: [],
      provinceIds: [],
      cityIds: []
    });
  }
  const lakeCellSet = new Set<number>();
  for (const lake of lakeBuilders) for (const cellIndex of lake.cells) lakeCellSet.add(cellIndex);

  // —— 3. flow accumulation on the drainage tree (descending filled order
  //       is topological: filled[parent] ≤ filled[child]) ——
  const order = Array.from({ length: cellCount }, (_, i) => i).filter((cellIndex) => land[cellIndex]);
  order.sort((a, b) => filled[b] - filled[a] || a - b);
  const accumulation = new Float64Array(cellCount);
  for (let i = 0; i < cellCount; i++) if (land[i]) accumulation[i] = 1;
  for (const cellIndex of order) {
    const target = parent[cellIndex];
    if (target >= 0) accumulation[target] += accumulation[cellIndex];
  }

  const landCells = order.length;
  // Threshold scales with the land mass so every map size gets a readable
  // network (default 30×20: ~360 land cells → threshold ~7).
  const channelThreshold = Math.max(6, Math.round(landCells * 0.02));
  const isChannel = (cellIndex: number): boolean => accumulation[cellIndex] >= channelThreshold;

  // —— 4. channel tracing along the drainage tree ——
  const sources = order.filter(
    (cellIndex) =>
      isChannel(cellIndex) &&
      elevation[cellIndex] >= SOURCE_MIN_ELEVATION &&
      !neighborsOf(cellIndex).some(
        (neighbor) => land[neighbor] && parent[neighbor] === cellIndex && isChannel(neighbor)
      )
  );
  sources.sort((a, b) => accumulation[b] - accumulation[a] || a - b);

  const riverBuilders: RiverBuilder[] = [];
  const claimed = new Map<number, { riverIndex: number; pathIndex: number }>();

  for (const source of sources) {
    if (claimed.has(source)) continue;
    const isTributary = riverBuilders.length >= MAX_MAIN_RIVERS;
    const mainCount = riverBuilders.filter((river) => river.parentRiverId === null).length;
    if (isTributary && riverBuilders.length - mainCount >= MAX_TRIBUTARIES) break;

    const path: number[] = [];
    let current = source;
    let mouthCell: number | null = null;
    let mouthType: 'ocean' | 'lake' | 'river' = 'ocean';
    let parentRiverId: string | null = null;
    let guard = 0;
    while (guard++ <= cellCount) {
      if (claimed.has(current)) {
        // Confluence: the claimer's path CONTAINS this cell — the tributary
        // joins there (its geometry ends at the claimer's own point). A
        // self-meet is impossible on a tree (strictly non-increasing walk).
        const claim = claimed.get(current)!;
        if (claim.riverIndex >= riverBuilders.length) {
          mouthCell = current; // defensive: never join a still-unbuilt river
          mouthType = 'lake';
          break;
        }
        mouthCell = current;
        mouthType = 'river';
        parentRiverId = riverBuilders[claim.riverIndex].id;
        break;
      }
      claimed.set(current, { riverIndex: riverBuilders.length, pathIndex: path.length });
      path.push(current);
      const target = parent[current];
      if (target === -2) {
        mouthCell = current; // last land cell before the sea
        mouthType = 'ocean';
        break;
      }
      if (target < 0) break; // defensive: unflooded cell (truncated)
      current = target;
    }

    // A tributary joins the parent AT the confluence cell — the shared cell
    // is appended so the cell chain (and geometry below) stays continuous.
    if (mouthType === 'river' && mouthCell !== null && path[path.length - 1] !== mouthCell) {
      path.push(mouthCell);
    }

    const minCells = isTributary ? MIN_TRIBUTARY_CELLS : MIN_MAIN_CELLS;
    if (mouthCell === null || path.length < minCells) {
      // Too short to read as a river: release the claims.
      for (const cellIndex of path) claimed.delete(cellIndex);
      continue;
    }
    riverBuilders.push({
      id: `river_${riverBuilders.length}`,
      name: generateCityName(nameRng, waterNames),
      cells: path,
      sourceCell: source,
      mouthCell,
      mouthType,
      parentRiverId,
      elevations: [],
      length: 0
    });
  }

  // —— 5. geometry: ONE cached jittered point per cell (continuous
  //      confluences) + water-surface elevation profile + length ——
  const jitteredPointByCell = new Map<number, MapPoint>();
  const pointOf = (cellIndex: number): MapPoint => {
    const cached = jitteredPointByCell.get(cellIndex);
    if (cached !== undefined) return cached;
    const centroid = input.centroids[cellIndex];
    const jitter = input.cellSize * POLYLINE_JITTER;
    const point = {
      x: centroid.x + (rng.next() * 2 - 1) * jitter,
      z: centroid.z + (rng.next() * 2 - 1) * jitter
    };
    jitteredPointByCell.set(cellIndex, point);
    return point;
  };
  // Pre-warm in stable cell order so per-cell jitter never depends on
  // path traversal order.
  for (const cellIndex of order) pointOf(cellIndex);

  const rivers: MapRiver[] = riverBuilders.map((builder) => {
    const polyline = builder.cells.map((cellIndex) => pointOf(cellIndex));
    let length = 0;
    for (let i = 1; i < polyline.length; i++) {
      length += Math.hypot(polyline[i].x - polyline[i - 1].x, polyline[i].z - polyline[i - 1].z);
    }
    return {
      id: builder.id,
      name: builder.name,
      cells: builder.cells,
      polyline,
      sourceCell: builder.sourceCell,
      mouthCell: builder.mouthCell,
      mouthType: builder.mouthType,
      parentRiverId: builder.parentRiverId,
      tributaryIds: [],
      // Water-surface (drained) profile — non-increasing by construction.
      elevations: builder.cells.map((cellIndex) => filled[cellIndex]),
      length,
      provinceIds: [],
      cityIds: [],
      navigable: builder.cells.length >= NAVIGABLE_MIN_CELLS && builder.mouthType === 'ocean',
      importance: 0
    };
  });

  // Tributary links + importance (length share of the longest stem).
  const maxMainLength = Math.max(
    1,
    ...rivers.filter((river) => river.parentRiverId === null).map((river) => river.length)
  );
  const tributariesByParent = new Map<string, string[]>();
  const importanceByRiver = new Map<string, number>();
  for (const river of rivers) {
    if (river.parentRiverId !== null) {
      const list = tributariesByParent.get(river.parentRiverId) ?? [];
      list.push(river.id);
      tributariesByParent.set(river.parentRiverId, list);
    }
    importanceByRiver.set(river.id, Math.max(0.15, Math.min(1, river.length / maxMainLength)));
  }
  const linkedRivers: MapRiver[] = rivers.map((river) => ({
    ...river,
    tributaryIds: tributariesByParent.get(river.id) ?? [],
    importance: importanceByRiver.get(river.id) ?? river.importance
  }));

  // —— 6. lakes: inflows (rivers flowing THROUGH or ending in the lake) and
  //        outflows (rivers whose source is a lake cell) ——
  for (const lake of lakeBuilders) {
    const lakeCells = new Set(lake.cells);
    for (const river of linkedRivers) {
      if (river.cells.some((cellIndex) => lakeCells.has(cellIndex))) {
        lake.inflowRiverIds.push(river.id);
      }
      if (lakeCells.has(river.sourceCell)) {
        lake.outflowRiverIds.push(river.id);
      }
    }
  }

  const riverCellOwner = new Map<number, { riverId: string; pathIndex: number }>();
  for (const river of linkedRivers) {
    river.cells.forEach((cellIndex, pathIndex) => {
      if (!riverCellOwner.has(cellIndex)) riverCellOwner.set(cellIndex, { riverId: river.id, pathIndex });
    });
  }

  return { rivers: linkedRivers, lakes: lakeBuilders, lakeCellSet, riverCellOwner };
}
