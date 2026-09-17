/**
 * MapRoutes — terrain-aware route geometry over the shared cell grid.
 *
 * WHY: transport polylines used to be straight 2–3 point lines between the
 * two city positions, so any city pair with water between them drew a road
 * straight through the ocean/lake (and "sea routes" straight across LAND).
 * This module is the ONE routing brain that fixes the geometry CLASS, not
 * two hardcoded pairs:
 *
 *  - `land` mode (roads + railways): A* over the CELL-CORNER graph — routes
 *    run along the jittered lattice edges (organic, and never through the
 *    cell interiors, so a road never covers a cell's click target). Ocean
 *    and lake cells are barriers: an edge is passable only while at least
 *    one adjacent cell is land, and water beside it multiplies the cost
 *    (a river bank reads as a narrow bridge; a long shoreline detour never
 *    pays). The MST in MapFeatures weights candidate edges with
 *    `routeDistance`, so a land route through intermediate cities beats a
 *    water crossing.
 *  - `water` mode (sea routes): A* over the CELL graph, the inverse domain
 *    — harbor lanes must be IN the ocean (following the coastline instead
 *    of cutting across land). Land cells cost a huge penalty so a route
 *    always EXISTS, but real coastlines win; a gentle hashed bow keeps
 *    every port pair's line distinct and organic. Ocean cells carry no
 *    grid-click targets, so the cell-centroid path is safe here.
 *
 * Deterministic: same inputs → byte-identical polylines (A* has no RNG; the
 * optional bow's amplitude+side are hashed from the route endpoints and are
 * validated to stay in water). Pure leaf: geometry types only.
 */

import type { MapPoint } from './MapTypes';
import type { Cell, LatticeData } from './MapGeometry';

/** Routing domain. */
export type RouteMode = 'land' | 'water';

/** Cost of ENTERING one cell, in distance multipliers (1 = free land step). */
export type RouteCosts = Readonly<Record<'land' | 'river' | 'lake' | 'ocean', number>>;

/** Land routes: oceans/lakes are barriers, rivers are narrow bridges. */
const LAND_COSTS: RouteCosts = { land: 1, river: 12, lake: 24, ocean: 24 };
/**
 * Sea routes: the OCEAN is the domain. Land is priced out of existence
 * (only a geography with NO water connection at all would ever pay it —
 * and even then the crossing is minimal). Coastal water costs a little
 * more than open water so lanes follow the coastline's SHAPE without
 * scraping the beach.
 */
const WATER_COSTS: RouteCosts = { land: 400, river: 60, lake: 60, ocean: 1 };
/** Extra cost for ocean cells adjacent to land (the offshore bias). */
const COASTAL_WATER_COST = 1.35;

/** Cell class (routing semantics, derived from the water masks). */
export type RouteCellKind = 'land' | 'river' | 'lake' | 'ocean';

/** A prepared routing grid (shared by all routes of one map build). */
export interface RouteGrid {
  readonly columns: number;
  readonly rows: number;
  readonly cellSize: number;
  readonly cells: readonly Cell[];
  readonly lattice: LatticeData;
  /** The mode this grid was built for. */
  readonly mode: RouteMode;
  /** Per-cell class (ocean / lake / river / land). */
  readonly kinds: readonly RouteCellKind[];
  /** Per-cell entering-cost table for the chosen mode. */
  readonly costs: readonly number[];
  /** Primary-domain members (cost ≤ 1) — diagonal no-corner-cut rule. */
  readonly primary: readonly boolean[];
}

/**
 * Classifies every cell (ocean / lake / river / land) and precomputes the
 * entering-cost table for `mode`. Built ONCE per map build; all routes of
 * the build share it.
 */
export function createRouteGrid(
  input: {
    readonly columns: number;
    readonly rows: number;
    readonly cellSize: number;
    readonly land: readonly boolean[];
    readonly lakeCells: ReadonlySet<number>;
    readonly riverCells: ReadonlySet<number>;
    readonly cells: readonly Cell[];
    readonly lattice: LatticeData;
  },
  mode: RouteMode
): RouteGrid {
  const cellCount = input.columns * input.rows;
  const template = mode === 'land' ? LAND_COSTS : WATER_COSTS;
  const kinds: RouteCellKind[] = new Array(cellCount);
  const costs: number[] = new Array(cellCount);
  const primary: boolean[] = new Array(cellCount);
  for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
    let kind: RouteCellKind;
    if (!input.land[cellIndex]) kind = 'ocean';
    else if (input.lakeCells.has(cellIndex)) kind = 'lake';
    else if (input.riverCells.has(cellIndex)) kind = 'river';
    else kind = 'land';
    kinds[cellIndex] = kind;
    costs[cellIndex] = template[kind];
    // The mode's own domain defines diagonal legality (never clip a corner
    // of the OTHER domain: no road cutting a lake corner, no sea lane
    // clipping a cape).
    primary[cellIndex] = mode === 'land' ? kind === 'land' : kind === 'ocean';
  }
  if (mode === 'water') {
    // Offshore bias: coastal water (touching land) costs a bit more than
    // open water — sea lanes keep a natural distance from the beach while
    // still following the coastline's overall form.
    for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
      if (kinds[cellIndex] !== 'ocean') continue;
      let touchesLand = false;
      const cx = cellIndex % input.columns;
      const cz = Math.floor(cellIndex / input.columns);
      for (let dz = -1; dz <= 1 && !touchesLand; dz++) {
        for (let dx = -1; dx <= 1 && !touchesLand; dx++) {
          const nx = cx + dx;
          const nz = cz + dz;
          if (nx < 0 || nx >= input.columns || nz < 0 || nz >= input.rows) continue;
          const neighbor = nz * input.columns + nx;
          if (input.land[neighbor] && !input.lakeCells.has(neighbor)) touchesLand = true;
        }
      }
      if (touchesLand) costs[cellIndex] = COASTAL_WATER_COST;
    }
  }
  return {
    columns: input.columns,
    rows: input.rows,
    cellSize: input.cellSize,
    cells: input.cells,
    lattice: input.lattice,
    mode,
    kinds,
    costs,
    primary
  };
}

// ———————————————————————————— shared helpers ————————————————————————————

/** Lattice centroid of one cell. */
function centroidOf(grid: RouteGrid, cellIndex: number): MapPoint {
  const corners = grid.cells[cellIndex].corners;
  let x = 0;
  let z = 0;
  for (const latticeIndex of corners) {
    x += grid.lattice.points[latticeIndex].x;
    z += grid.lattice.points[latticeIndex].z;
  }
  return { x: x / 4, z: z / 4 };
}

/** Cell index of a world position, or −1 when off-grid. */
function cellIndexOfPoint(grid: RouteGrid, position: MapPoint): number {
  const cx = Math.floor(position.x / grid.cellSize);
  const cz = Math.floor(position.z / grid.cellSize);
  if (cx < 0 || cx >= grid.columns || cz < 0 || cz >= grid.rows) return -1;
  return cz * grid.columns + cx;
}

/** Lattice point of one corner id: corner (cx, cz) → index cz·(columns+1)+cx. */
function cornerPosition(grid: RouteGrid, corner: number): MapPoint {
  return grid.lattice.points[corner];
}

function cornerId(grid: RouteGrid, cx: number, cz: number): number {
  return cz * (grid.columns + 1) + cx;
}

/** Deterministic 0..1 hash of two world positions (per-point variety). */
function pairHash01(from: MapPoint, to: MapPoint): number {
  // Bit-mix of the quantized coordinates (mulberry-style avalanche).
  let h = 0x9e3779b9;
  const words = [from.x, from.z, to.x, to.z];
  for (const word of words) {
    const bits = Math.imul(Math.round(word * 100) | 0, 0x85ebca6b);
    h = Math.imul(h ^ bits, 0xc2b2ae35);
    h ^= h >>> 13;
  }
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// ———————————————————————————— A* (shared core) ————————————————————————————

/**
 * Generic A* over implicit integer nodes with linear minimum extraction
 * (maps are ≤ a few thousand nodes; a heap would be over-engineering).
 * `neighbors(node)` yields [nextNode, stepCost] pairs. Returns the node
 * path (inclusive) and its g-cost, or null when unreachable.
 */
function aStar(
  starts: readonly number[],
  goals: ReadonlySet<number>,
  heuristic: (node: number) => number,
  neighbors: (node: number) => readonly [number, number][]
): { path: number[]; cost: number } | null {
  const g = new Map<number, number>();
  const parent = new Map<number, number>();
  const closed = new Set<number>();
  const open: number[] = [];
  const fOf = new Map<number, number>();
  for (const start of starts) {
    const h = heuristic(start);
    if (!g.has(start) || g.get(start)! > 0) {
      g.set(start, 0);
      fOf.set(start, h);
      open.push(start);
    }
  }
  while (open.length > 0) {
    let bestIndex = 0;
    for (let i = 1; i < open.length; i++) {
      const a = fOf.get(open[i]) ?? Number.POSITIVE_INFINITY;
      const b = fOf.get(open[bestIndex]) ?? Number.POSITIVE_INFINITY;
      if (a < b || (a === b && open[i] < open[bestIndex])) bestIndex = i;
    }
    const current = open[bestIndex];
    open.splice(bestIndex, 1);
    if (goals.has(current)) {
      const path: number[] = [current];
      let cursor = current;
      while (parent.has(cursor)) {
        cursor = parent.get(cursor)!;
        path.unshift(cursor);
      }
      return { path, cost: g.get(current) ?? 0 };
    }
    closed.add(current);
    for (const [neighbor, stepCost] of neighbors(current)) {
      if (closed.has(neighbor)) continue;
      const candidate = (g.get(current) ?? Number.POSITIVE_INFINITY) + stepCost;
      if (candidate < (g.get(neighbor) ?? Number.POSITIVE_INFINITY)) {
        g.set(neighbor, candidate);
        parent.set(neighbor, current);
        fOf.set(neighbor, candidate + heuristic(neighbor));
        if (!open.includes(neighbor)) open.push(neighbor);
      }
    }
  }
  return null;
}

// ———————————————————————————— water mode (cells) ———————————————————————————

/** 8-connected neighbors (indices) of a cell, in deterministic order. */
function neighborsOf(grid: RouteGrid, cellIndex: number): number[] {
  const cx = cellIndex % grid.columns;
  const cz = Math.floor(cellIndex / grid.columns);
  const result: number[] = [];
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dz === 0) continue;
      const nx = cx + dx;
      const nz = cz + dz;
      if (nx < 0 || nx >= grid.columns || nz < 0 || nz >= grid.rows) continue;
      result.push(nz * grid.columns + nx);
    }
  }
  return result;
}

/** Step length between two grid-adjacent cells (world units). */
function stepLength(grid: RouteGrid, a: number, b: number): number {
  const dx = Math.abs((b % grid.columns) - (a % grid.columns));
  const dz = Math.abs(Math.floor(b / grid.columns) - Math.floor(a / grid.columns));
  return (dx === 1 && dz === 1 ? Math.SQRT2 : 1) * grid.cellSize;
}
/**
 * Cheapest CELL path start→goal (inclusive) for sea routes, or null when
 * unreachable. A* with the entering-cell cost model; the start cell is
 * never charged. Diagonal moves never cut across a non-primary corner.
 */
function findWaterCellPath(grid: RouteGrid, start: number, goal: number): number[] | null {
  if (start < 0 || goal < 0) return null;
  if (start === goal) return [start];
  const goalPosition = centroidOf(grid, goal);
  const heuristic = (cellIndex: number): number =>
    Math.hypot(
      centroidOf(grid, cellIndex).x - goalPosition.x,
      centroidOf(grid, cellIndex).z - goalPosition.z
    );
  const result = aStar(
    [start],
    new Set([goal]),
    heuristic,
    (current) => {
      const moves: [number, number][] = [];
      const cx = current % grid.columns;
      const cz = Math.floor(current / grid.columns);
      for (const neighbor of neighborsOf(grid, current)) {
        const nx = neighbor % grid.columns;
        const nz = Math.floor(neighbor / grid.columns);
        const diagonal = Math.abs(nx - cx) === 1 && Math.abs(nz - cz) === 1;
        if (diagonal) {
          const sideA = cz * grid.columns + nx;
          const sideB = nz * grid.columns + cx;
          if (!grid.primary[sideA] || !grid.primary[sideB]) continue;
        }
        moves.push([neighbor, stepLength(grid, current, neighbor) * grid.costs[neighbor]]);
      }
      return moves;
    }
  );
  return result?.path ?? null;
}

// ——————————————————————————— land mode (corners) ———————————————————————————

/** Water kinds an edge may not run through on BOTH sides (roads stay dry). */
function isWaterKind(kind: RouteCellKind): boolean {
  return kind === 'ocean' || kind === 'lake' || kind === 'river';
}

/**
 * The four corners of the cell hosting `position`, nearest first — the
 * virtual entry/exit points that connect a city position to the corner
 * graph (the host cell is always land: cities stand on land).
 */
function hostCornersByDistance(grid: RouteGrid, position: MapPoint): number[] {
  const cellIndex = cellIndexOfPoint(grid, position);
  if (cellIndex < 0) return [];
  const cx = cellIndex % grid.columns;
  const cz = Math.floor(cellIndex / grid.columns);
  const corners = [
    cornerId(grid, cx, cz),
    cornerId(grid, cx + 1, cz),
    cornerId(grid, cx + 1, cz + 1),
    cornerId(grid, cx, cz + 1)
  ];
  return corners.sort(
    (a, b) =>
      Math.hypot(cornerPosition(grid, a).x - position.x, cornerPosition(grid, a).z - position.z) -
      Math.hypot(cornerPosition(grid, b).x - position.x, cornerPosition(grid, b).z - position.z)
  );
}

/**
 * The land corner-graph edges of ONE corner: [nextCorner, stepCost] pairs.
 * Orthogonal moves only (edges never enter a cell interior); an edge is
 * passable while at least ONE adjacent cell is land, priced by the most
 * expensive adjacent cell — water on every side blocks the edge.
 */
function landCornerMoves(grid: RouteGrid, corner: number): [number, number][] {
  const moves: [number, number][] = [];
  const latticeStride = grid.columns + 1;
  const cz = Math.floor(corner / latticeStride);
  const cx = corner - cz * latticeStride;
  const edgeCost = (cellA: number, cellB: number): number => {
    let multiplier = 0;
    let waterSides = 0;
    let cellCount = 0;
    for (const cellIndex of [cellA, cellB]) {
      if (cellIndex < 0 || cellIndex >= grid.kinds.length) continue;
      cellCount += 1;
      if (isWaterKind(grid.kinds[cellIndex])) waterSides += 1;
      if (grid.costs[cellIndex] > multiplier) multiplier = grid.costs[cellIndex];
    }
    if (cellCount === 0 || waterSides === cellCount) return Number.POSITIVE_INFINITY;
    return multiplier;
  };
  const push = (ncx: number, ncz: number, cost: number): void => {
    if (ncx < 0 || ncx > grid.columns || ncz < 0 || ncz > grid.rows) return;
    if (!Number.isFinite(cost)) return;
    const next = cornerId(grid, ncx, ncz);
    moves.push([
      next,
      Math.hypot(
        cornerPosition(grid, next).x - cornerPosition(grid, corner).x,
        cornerPosition(grid, next).z - cornerPosition(grid, corner).z
      ) * cost
    ]);
  };
  // East edge of cell (cx, cz): cells (cx, cz-1) above + (cx, cz) below.
  if (cx < grid.columns) {
    push(cx + 1, cz, edgeCost(cz > 0 ? (cz - 1) * grid.columns + cx : -1, cz * grid.columns + cx));
  }
  // West edge of cell (cx-1, cz): cells (cx-1, cz-1) above + (cx-1, cz).
  if (cx > 0) {
    push(cx - 1, cz, edgeCost(cz > 0 ? (cz - 1) * grid.columns + (cx - 1) : -1, cz * grid.columns + (cx - 1)));
  }
  // South edge of cell (cx, cz): cells (cx-1, cz) left + (cx, cz) right.
  if (cz < grid.rows) {
    push(cx, cz + 1, edgeCost(cx > 0 ? cz * grid.columns + (cx - 1) : -1, cz * grid.columns + cx));
  }
  // North edge of cell (cx, cz-1): cells (cx-1, cz-1) left + (cx, cz-1).
  if (cz > 0) {
    push(cx, cz - 1, edgeCost(cx > 0 ? (cz - 1) * grid.columns + (cx - 1) : -1, (cz - 1) * grid.columns + cx));
  }
  return moves;
}

/**
 * Cheapest LAND path along the CELL-CORNER graph (jittered lattice edges,
 * 4-directional). Orthogonal edges never enter a cell interior, so routes
 * stay off the cells' click targets by half a cell; the shared lattice
 * keeps the geometry organic.
 */
function findLandCornerPath(grid: RouteGrid, from: MapPoint, to: MapPoint): MapPoint[] | null {
  const startCorners = hostCornersByDistance(grid, from);
  const goalCorners = hostCornersByDistance(grid, to);
  if (startCorners.length === 0 || goalCorners.length === 0) return null;
  // Same host cell → a straight in-cell hop (both endpoints on land).
  if (cellIndexOfPoint(grid, from) === cellIndexOfPoint(grid, to)) return [from, to];

  const result = aStar(
    [...startCorners],
    new Set(goalCorners),
    (corner) => {
      const position = cornerPosition(grid, corner);
      return Math.hypot(position.x - to.x, position.z - to.z);
    },
    (corner) => landCornerMoves(grid, corner)
  );
  if (result === null) return null;
  const waypoints = result.path.map((corner) => cornerPosition(grid, corner));
  return [from, ...waypoints, to];
}

// ———————————————————————————— public routing API ———————————————————————————

/** Douglas–Peucker polyline simplification (keeps the route's real bends). */
function simplify(points: readonly MapPoint[], epsilon: number): MapPoint[] {
  if (points.length <= 2) return [...points];
  let maxDistance = 0;
  let split = 0;
  const first = points[0];
  const last = points[points.length - 1];
  const dx = last.x - first.x;
  const dz = last.z - first.z;
  const length = Math.hypot(dx, dz) || 1;
  for (let i = 1; i < points.length - 1; i++) {
    const point = points[i];
    const t = ((point.x - first.x) * dx + (point.z - first.z) * dz) / (length * length);
    const projX = first.x + dx * Math.max(0, Math.min(1, t));
    const projZ = first.z + dz * Math.max(0, Math.min(1, t));
    const distance = Math.hypot(point.x - projX, point.z - projZ);
    if (distance > maxDistance) {
      maxDistance = distance;
      split = i;
    }
  }
  if (maxDistance <= epsilon) return [first, last];
  const left = simplify(points.slice(0, split + 1), epsilon);
  const right = simplify(points.slice(split), epsilon);
  return [...left.slice(0, -1), ...right];
}

/** Ocean-only membership (sea-route bow validation). */
function isOceanCell(grid: RouteGrid, cellIndex: number): boolean {
  return cellIndex >= 0 && grid.kinds[cellIndex] === 'ocean';
}

/** The up-to-4 cells sharing one lattice corner. */
function cornerCells(grid: RouteGrid, point: MapPoint): number[] {
  const cx = Math.round(point.x / grid.cellSize);
  const cz = Math.round(point.z / grid.cellSize);
  const cells: number[] = [];
  for (const [dx, dz] of [
    [-1, -1],
    [0, -1],
    [-1, 0],
    [0, 0]
  ] as const) {
    const px = cx + dx;
    const pz = cz + dz;
    if (px < 0 || px >= grid.columns || pz < 0 || pz >= grid.rows) continue;
    cells.push(pz * grid.columns + px);
  }
  return cells;
}

/**
 * Unit vector pointing from a corner INTO its adjacent land (the average
 * direction to the adjacent land cells' centroids), or null when no
 * adjacent cell is land. Nudging bank corners this way keeps every road
 * segment on the dry side of the coastline it follows.
 */
function landwardVector(grid: RouteGrid, point: MapPoint): MapPoint | null {
  let vx = 0;
  let vz = 0;
  let landCells = 0;
  for (const cellIndex of cornerCells(grid, point)) {
    if (grid.kinds[cellIndex] !== 'land') continue;
    const centroid = centroidOf(grid, cellIndex);
    vx += centroid.x - point.x;
    vz += centroid.z - point.z;
    landCells += 1;
  }
  if (landCells === 0) return null;
  const length = Math.hypot(vx, vz) || 1;
  return { x: vx / length, z: vz / length };
}

/** Σ water samples along a polyline (4 interior samples per segment). */
function countWaterSamples(grid: RouteGrid, points: readonly MapPoint[]): number {
  let water = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    for (const t of [0.2, 0.4, 0.6, 0.8]) {
      const cellIndex = cellIndexOfPoint(grid, {
        x: a.x + (b.x - a.x) * t,
        z: a.z + (b.z - a.z) * t
      });
      if (cellIndex >= 0 && isWaterKind(grid.kinds[cellIndex])) water += 1;
    }
  }
  return water;
}

export interface RoutePolylineOptions {
  /** Gentle organic curve for sea routes (each pair bows differently). */
  readonly bow?: boolean;
  /** Bow amplitude as a fraction of the route length (default 0.12). */
  readonly bowAmplitudeFraction?: number;
}

/**
 * Terrain-aware route polyline between two world positions:
 * exact endpoints + simplified waypoints. Never null — when even the
 * penalized grid has no path (off-map), falls back to the straight line
 * (the caller's previous behavior).
 */
export function routePolylinePoints(
  grid: RouteGrid,
  from: MapPoint,
  to: MapPoint,
  mode: RouteMode,
  options?: RoutePolylineOptions
): MapPoint[] {
  if (grid.mode !== mode) {
    throw new Error(`route grid built for "${grid.mode}" but asked for "${mode}"`);
  }
  if (mode === 'land') {
    const raw = findLandCornerPath(grid, from, to);
    if (raw === null) return [from, to];
    const landwardNudged = (waypoints: readonly MapPoint[], bankBoost: number): MapPoint[] => {
      const nudged = [...waypoints];
      // Roads hugging lattice edges would sit exactly ON province/country
      // border lines (drawn over the same edges) and on water BANKS — nudge
      // each kept waypoint TOWARD land when the corner touches water (bank
      // corners get the bigger push), otherwise a hashed side. All nudges
      // stay well under the half cell that separates a corner from any
      // cell's click target.
      for (let i = 1; i < nudged.length - 1; i++) {
        const touchesWater = cornerCells(grid, nudged[i]).some(
          (cellIndex) => isWaterKind(grid.kinds[cellIndex])
        );
        const magnitude =
          (touchesWater ? 1.6 + bankBoost : 0.6) +
          pairHash01(nudged[i], { x: i * 1.618, z: 7.31 }) * 0.6;
        const landward = landwardVector(grid, nudged[i]);
        if (landward !== null) {
          nudged[i] = {
            x: nudged[i].x + landward.x * magnitude,
            z: nudged[i].z + landward.z * magnitude
          };
          continue;
        }
        const previous = nudged[i - 1];
        const next = nudged[i + 1];
        const dx = next.x - previous.x;
        const dz = next.z - previous.z;
        const length = Math.hypot(dx, dz) || 1;
        const offset =
          (pairHash01({ x: 3.7, z: i * 2.418 }, nudged[i]) > 0.5 ? 1 : -1) * magnitude;
        nudged[i] = {
          x: nudged[i].x + (-dz / length) * offset,
          z: nudged[i].z + (dx / length) * offset
        };
      }
      return nudged;
    };
    const simplified = simplify(raw, grid.cellSize * 0.42);
    const candidates: MapPoint[][] =
      simplified.length > 2
        ? [
            landwardNudged(simplified, 0),
            landwardNudged(raw, 0),
            landwardNudged(raw, 1)
          ]
        : [landwardNudged(raw, 0), landwardNudged(raw, 1)];
    // Keep the DRYEST candidate: simplified+nudged normally wins; if a
    // simplified chord clipped a water corner, fall back to the full
    // corner path (never geometrically inside water).
    let best: MapPoint[] | null = null;
    let bestWater = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      const water = countWaterSamples(grid, candidate);
      if (water < bestWater) {
        bestWater = water;
        best = candidate;
      }
      if (water === 0) break;
    }
    return best ?? simplified;
  }

  const raw = findWaterCellPath(grid, cellIndexOfPoint(grid, from), cellIndexOfPoint(grid, to));
  if (raw === null) return [from, to];

  // —— water mode: centroid waypoints + the organic bow (sea routes) ——
  const points: MapPoint[] = [from];
  for (let i = 1; i < raw.length - 1; i++) points.push(centroidOf(grid, raw[i]));
  points.push(to);
  const simplified = simplify(points, grid.cellSize * 0.42);
  if (simplified.length <= 2 || options?.bow !== true) return simplified;

  // One smooth arc over the interior, amplitude + side hashed from the
  // endpoints (deterministic, per-pair — no two port pairs draw the same
  // curve, and no RNG state is consumed).
  const amplitude =
    (pairHash01(from, to) * 2 - 1) *
    (options.bowAmplitudeFraction ?? 0.12) *
    Math.hypot(to.x - from.x, to.z - from.z);
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const length = Math.hypot(dx, dz) || 1;
  const bent = simplified.map((point, index) => {
    if (index === 0 || index === simplified.length - 1) return point;
    const t = index / (simplified.length - 1);
    const offset = Math.sin(Math.PI * t) * amplitude;
    return { x: point.x + (-dz / length) * offset, z: point.z + (dx / length) * offset };
  });
  // Validate: every bent INTERIOR point (and segment midpoints) must stay in
  // the ocean. One violation → keep the unbent route (never over land).
  for (let i = 1; i < bent.length; i++) {
    const a = bent[i - 1];
    const b = bent[i];
    for (const t of [0.33, 0.66]) {
      const sample = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
      if (!isOceanCell(grid, cellIndexOfPoint(grid, sample))) return simplified;
    }
  }
  for (let i = 1; i < bent.length - 1; i++) {
    if (!isOceanCell(grid, cellIndexOfPoint(grid, bent[i]))) return simplified;
  }
  return bent;
}

/**
 * Route DISTANCE for MST weighting: the A* cost of the best path (land
 * steps ≈ euclidean, water steps inflated by their penalty). Deterministic;
 * callers memoize per city pair.
 */
export function routeDistance(grid: RouteGrid, from: MapPoint, to: MapPoint): number {
  const straightFallback = Math.hypot(to.x - from.x, to.z - from.z) * 1000;
  if (grid.mode === 'land') {
    const startCorners = hostCornersByDistance(grid, from);
    const goalCorners = hostCornersByDistance(grid, to);
    if (startCorners.length === 0 || goalCorners.length === 0) return straightFallback;
    if (cellIndexOfPoint(grid, from) === cellIndexOfPoint(grid, to)) {
      return Math.hypot(to.x - from.x, to.z - from.z);
    }
    const result = aStar(
      [...startCorners],
      new Set(goalCorners),
      (corner) => {
        const position = cornerPosition(grid, corner);
        return Math.hypot(position.x - to.x, position.z - to.z);
      },
      (corner) => landCornerMoves(grid, corner)
    );
    return result?.cost ?? straightFallback;
  }
  const startCell = cellIndexOfPoint(grid, from);
  const goalCell = cellIndexOfPoint(grid, to);
  const path = findWaterCellPath(grid, startCell, goalCell);
  if (path === null) return straightFallback;
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    total += stepLength(grid, path[i - 1], path[i]) * grid.costs[path[i]];
  }
  return total;
}
