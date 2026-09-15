/**
 * Map geometry core: jittered lattice → cell graph → shared edge registry
 * with deterministic fractal subdivision → closed boundary rings.
 *
 * GUARANTEES (by construction):
 * - Every undirected boundary edge exists ONCE in the registry and carries
 *   ONE polyline → both neighboring regions concatenate the same points.
 * - Subdivision is seeded per-edge (hash of the canonical edge key ⊕ map
 *   seed), so geometry is independent of build/iteration order.
 * - Rings are extracted by walking cell-boundary half-edges, keeping the
 *   region's interior on a consistent side.
 *
 * Pure TypeScript — no Three.js, no DOM, no game logic.
 */

import { Random } from '../../utils/Random';
import { fnv1a32 } from '../../utils/hash';
import type { MapPoint, MapEdge, EdgeKey, EdgeKind, MapRing, RingSegment } from './MapTypes';

/** One grid cell of the lattice (the atomic unit of land). */
export interface Cell {
  readonly index: number;
  readonly cx: number;
  readonly cz: number;
  /** Lattice indices in clockwise order: NW, NE, SE, SW. */
  readonly corners: readonly [number, number, number, number];
}

/** Directed cell-boundary half-edge (interior of the cell on the right). */
interface DirectedEdge {
  from: number; // lattice index
  to: number; // lattice index
  cellIndex: number;
}

export interface LatticeData {
  readonly points: MapPoint[];
  readonly columns: number; // lattice columns (cells + 1)
  readonly rows: number;
}

/**
 * Builds the jittered lattice. Interior points are displaced by a seeded RNG
 * with amplitude strictly below half a cell, which keeps every quad simple
 * and non-inverted while giving the grid an organic, irregular look.
 * Outer-ring points stay fixed so the map bounding box is exact.
 */
export function buildLattice(
  columns: number,
  rows: number,
  cellSize: number,
  jitterAmplitude: number,
  rng: Random
): LatticeData {
  const points: MapPoint[] = [];
  const amp = jitterAmplitude * cellSize;
  for (let cz = 0; cz <= rows; cz++) {
    for (let cx = 0; cx <= columns; cx++) {
      const onBorder = cx === 0 || cz === 0 || cx === columns || cz === rows;
      const jx = onBorder ? 0 : (rng.next() * 2 - 1) * amp;
      const jz = onBorder ? 0 : (rng.next() * 2 - 1) * amp;
      points.push({ x: cx * cellSize + jx, z: cz * cellSize + jz });
    }
  }
  return { points, columns, rows };
}

export function latticeIndex(columns: number, cx: number, cz: number): number {
  return cz * (columns + 1) + cx;
}

/** Creates all grid cells with clockwise corner order (NW, NE, SE, SW). */
export function buildCells(columns: number, rows: number): Cell[] {
  const cells: Cell[] = [];
  for (let cz = 0; cz < rows; cz++) {
    for (let cx = 0; cx < columns; cx++) {
      const index = cz * columns + cx;
      cells.push({
        index,
        cx,
        cz,
        corners: [
          latticeIndex(columns, cx, cz), // NW
          latticeIndex(columns, cx + 1, cz), // NE
          latticeIndex(columns, cx + 1, cz + 1), // SE
          latticeIndex(columns, cx, cz + 1) // SW
        ]
      });
    }
  }
  return cells;
}

export function edgeKeyFor(a: number, b: number): EdgeKey {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Deterministic fractal midpoint displacement for one edge.
 *
 * Seeded ONLY by (mapSeed, canonical edge key) → both neighboring regions,
 * and any rebuild of the same map, get byte-identical geometry. The
 * perpendicular offset shrinks geometrically per depth level, producing a
 * natural coastline/border wiggle that stays within a narrow corridor.
 */
export function subdivideEdge(
  a: MapPoint,
  b: MapPoint,
  depth: number,
  amplitudeFactor: number,
  rng: Random
): MapPoint[] {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const length = Math.hypot(dx, dz);
  if (depth <= 0 || length < 1e-6) return [b];

  // Perpendicular unit vector (right-hand side of a→b).
  const px = -dz / length;
  const pz = dx / length;
  const offset = (rng.next() * 2 - 1) * amplitudeFactor * length;
  const mid: MapPoint = {
    x: (a.x + b.x) / 2 + px * offset,
    z: (a.z + b.z) / 2 + pz * offset
  };
  const childAmplitude = amplitudeFactor * 0.55;
  return [
    ...subdivideEdge(a, mid, depth - 1, childAmplitude, rng),
    ...subdivideEdge(mid, b, depth - 1, childAmplitude, rng)
  ];
}

/** A cell side: 0=N, 1=E, 2=S, 3=W (matches corner pair order below). */
export type CellSide = 0 | 1 | 2 | 3;

const SIDE_CORNERS: readonly (readonly [number, number])[] = [
  [0, 1], // N: NW → NE
  [1, 2], // E: NE → SE
  [2, 3], // S: SE → SW
  [3, 0] // W: SW → NW
];

/** Directed half-edge (from → to) of a cell side, interior on the right. */
export function directedSideEdge(cell: Cell, side: CellSide): DirectedEdge {
  const [c0, c1] = SIDE_CORNERS[side];
  return { from: cell.corners[c0], to: cell.corners[c1], cellIndex: cell.index };
}

/** Neighbor cell across a side; -1 when out of the grid. */
export function neighborCellIndex(cell: Cell, side: CellSide, columns: number, rows: number): number {
  switch (side) {
    case 0:
      return cell.cz === 0 ? -1 : cell.index - columns;
    case 1:
      return cell.cx === columns - 1 ? -1 : cell.index + 1;
    case 2:
      return cell.cz === rows - 1 ? -1 : cell.index + columns;
    case 3:
      return cell.cx === 0 ? -1 : cell.index - 1;
  }
}

export interface EdgeSideInfo {
  readonly cellIndex: number;
  readonly owner: number; // country partition id (or -1 for ocean/none)
  readonly subOwner: number; // province partition id (or -1)
}

export interface EdgeBuildResult {
  readonly edges: Readonly<Record<EdgeKey, MapEdge>>;
  readonly coastEdgeKeys: ReadonlySet<EdgeKey>;
  readonly countryEdgeKeys: ReadonlySet<EdgeKey>;
  readonly provinceEdgeKeys: ReadonlySet<EdgeKey>;
}

/**
 * Builds the shared edge registry from the cell partitions.
 *
 * `landOf[cellIndex]` = partition id (country index) or -1 for ocean.
 * `subOf[cellIndex]` = province id within the country or -1.
 *
 * Every edge touched by a land cell is registered exactly once; its kind is
 * derived from the two sides. The polyline is generated once, deterministically.
 */
export function buildSharedEdges(
  lattice: LatticeData,
  cells: readonly Cell[],
  landOf: readonly number[] | Int32Array,
  subOf: readonly number[] | Int32Array,
  mapSeed: number,
  borderDepth: number,
  amplitudeFactor: number
): EdgeBuildResult {
  const sides = new Map<EdgeKey, { a: MapPoint; b: MapPoint; sideA: EdgeSideInfo | null; sideB: EdgeSideInfo | null }>();

  const addSide = (
    key: EdgeKey,
    a: MapPoint,
    b: MapPoint,
    info: EdgeSideInfo,
    forward: boolean
  ): void => {
    const existing = sides.get(key);
    if (existing === undefined) {
      sides.set(key, { a, b, sideA: forward ? info : null, sideB: forward ? null : info });
      return;
    }
    if (forward) {
      if (existing.sideA !== null) throw new Error(`Edge "${key}" claimed twice from the same side`);
      existing.sideA = info;
    } else {
      if (existing.sideB !== null) throw new Error(`Edge "${key}" claimed twice from the same side`);
      existing.sideB = info;
    }
  };

  for (const cell of cells) {
    if (landOf[cell.index] < 0) continue; // ocean contributes no edges
    const info: EdgeSideInfo = {
      cellIndex: cell.index,
      owner: landOf[cell.index],
      subOwner: subOf[cell.index]
    };
    for (const side of [0, 1, 2, 3] as const) {
      const de = directedSideEdge(cell, side);
      const key = edgeKeyFor(de.from, de.to);
      const a = lattice.points[de.from];
      const b = lattice.points[de.to];
      const forward = de.from < de.to; // canonical polyline direction is a→b with a<b
      addSide(key, a, b, info, forward);
    }
  }

  const edges: Record<EdgeKey, MapEdge> = {};
  const coastEdgeKeys = new Set<EdgeKey>();
  const countryEdgeKeys = new Set<EdgeKey>();
  const provinceEdgeKeys = new Set<EdgeKey>();

  for (const [key, entry] of sides) {
    let kind: EdgeKind;
    if (entry.sideA !== null && entry.sideB !== null) {
      if (entry.sideA.owner !== entry.sideB.owner) kind = 'country';
      else if (entry.sideA.subOwner !== entry.sideB.subOwner) kind = 'province';
      else kind = 'interior';
    } else {
      kind = 'coast'; // exactly one land side (the other is ocean / out of grid)
    }

    const parts = key.split('|');
    const ia = Number(parts[0]);
    const ib = Number(parts[1]);
    const pointA = lattice.points[ia];
    const pointB = lattice.points[ib];
    // Interior edges are never rendered and never part of a ring — skip the
    // (deterministic) subdivision work for them.
    const polyline =
      kind === 'interior'
        ? [pointA, pointB]
        : [pointA, ...subdivideEdge(pointA, pointB, borderDepth, amplitudeFactor, new Random((fnv1a32(key) ^ mapSeed) >>> 0))];

    edges[key] = { key, a: ia, b: ib, kind, polyline };
    if (kind === 'coast') coastEdgeKeys.add(key);
    else if (kind === 'country') countryEdgeKeys.add(key);
    else if (kind === 'province') provinceEdgeKeys.add(key);
  }

  return { edges, coastEdgeKeys, countryEdgeKeys, provinceEdgeKeys };
}

/**
 * Walks the boundary of a cell region (a set of cell indices sharing one
 * partition value) and produces a closed ring made ONLY of shared edge
 * traversals.
 *
 * This is the classic planar face walk with the region interior kept on the
 * right: arriving at a lattice vertex via quadrant q's side, candidate
 * continuations are tried in order q (right turn) → counter-clockwise
 * neighbors (straight, left, U-turn). Correct at pinch vertices too — the
 * ring may legally pass through the same vertex twice.
 */
export function extractRegionRing(
  cells: readonly Cell[],
  landOf: readonly number[] | Int32Array,
  partitionId: number,
  columns: number,
  rows: number,
  edges: Readonly<Record<EdgeKey, MapEdge>>
): MapRing {
  const member = new Set<number>();
  for (const cell of cells) {
    if (landOf[cell.index] === partitionId) member.add(cell.index);
  }
  if (member.size === 0) throw new Error(`Cannot extract ring: partition ${partitionId} has no cells`);

  // All directed boundary half-edges, keyed by "fromLatticeIndex>direction".
  // Directions from a vertex: e(north-east grid: +x), n(-z), w(-x), s(+z).
  const outgoing = new Map<string, DirectedEdge>();
  const putOutgoing = (vertex: number, direction: string, edge: DirectedEdge): void => {
    const key = `${vertex}>${direction}`;
    const existing = outgoing.get(key);
    if (existing !== undefined) throw new Error(`Two boundary half-edges leave vertex ${vertex} towards ${direction}`);
    outgoing.set(key, edge);
  };

  for (const cellIndex of member) {
    const cell = cells[cellIndex];
    for (const side of [0, 1, 2, 3] as const) {
      const neighbor = neighborCellIndex(cell, side, columns, rows);
      if (neighbor >= 0 && member.has(neighbor)) continue; // interior edge
      const de = directedSideEdge(cell, side);
      // The direction the half-edge leaves its start vertex towards.
      const startLx = de.from % (columns + 1);
      const startLz = Math.floor(de.from / (columns + 1));
      const endLx = de.to % (columns + 1);
      const endLz = Math.floor(de.to / (columns + 1));
      const direction =
        endLx > startLx ? 'e' : endLx < startLx ? 'w' : endLz > startLz ? 's' : 'n';
      putOutgoing(de.from, direction, de);
    }
  }

  const firstEdge: DirectedEdge | undefined = outgoing.values().next().value;
  if (firstEdge === undefined) throw new Error(`Partition ${partitionId} has no boundary edges`);

  const quadrantOf = (cellIndex: number, vertex: number): 0 | 1 | 2 | 3 => {
    const vx = vertex % (columns + 1);
    const vz = Math.floor(vertex / (columns + 1));
    const cell = cells[cellIndex];
    if (cell.cx === vx && cell.cz === vz) return 0; // cell SE of vertex
    if (cell.cx === vx && cell.cz === vz - 1) return 1; // NE
    if (cell.cx === vx - 1 && cell.cz === vz - 1) return 2; // NW
    if (cell.cx === vx - 1 && cell.cz === vz) return 3; // SW
    throw new Error(`Cell ${cellIndex} does not touch vertex ${vertex}`);
  };
  // Right-turn first: q → counter-clockwise rotation around the vertex.
  const CCW: readonly (readonly [0 | 1 | 2 | 3, 0 | 1 | 2 | 3])[] = [
    [0, 1], [1, 2], [2, 3], [3, 0]
  ];
  const nextQuadrant = (quadrant: 0 | 1 | 2 | 3): 0 | 1 | 2 | 3 => {
    for (const [from, to] of CCW) if (from === quadrant) return to;
    throw new Error('unreachable quadrant');
  };
  const OUT_DIRECTION = ['e', 'n', 'w', 's'] as const; // by quadrant 0..3

  const segments: RingSegment[] = [];
  const points: MapPoint[] = [];
  let current: DirectedEdge = firstEdge;
  let guard = 0;
  const maxSteps = member.size * 8 + 64;

  do {
    if (guard++ > maxSteps) throw new Error(`Ring walk exceeded step budget for partition ${partitionId}`);
    const key = edgeKeyFor(current.from, current.to);
    const edge = edges[key];
    if (edge === undefined) throw new Error(`Ring walk hit unregistered edge "${key}"`);

    const forward = current.from === edge.a;
    segments.push({ key, forward });

    const line = edge.polyline;
    const skipFirst = points.length > 0 ? 1 : 0; // joints are not duplicated
    if (forward) {
      for (let i = skipFirst; i < line.length; i++) points.push(line[i]);
    } else {
      for (let i = line.length - 1 - skipFirst; i >= 0; i--) points.push(line[i]);
    }

    // Pick the next half-edge around the end vertex: right turn first.
    const vertex = current.to;
    const quadrant = quadrantOf(current.cellIndex, vertex);
    let next: DirectedEdge | null = null;
    let probe: 0 | 1 | 2 | 3 = quadrant;
    for (let attempt = 0; attempt < 4 && next === null; attempt++) {
      next = outgoing.get(`${vertex}>${OUT_DIRECTION[probe]}`) ?? null;
      if (next === null) probe = nextQuadrant(probe);
    }
    if (next === null) throw new Error(`Boundary broken at vertex ${vertex} (partition ${partitionId})`);
    if (sameDirected(next, firstEdge) && segments.length > 1) {
      // Closed the ring — but only accept closure at the START edge; if the
      // walk closes onto the start prematurely the boundary is degenerate.
      break;
    }
    current = next;
  } while (!sameDirected(current, firstEdge) && guard <= maxSteps);

  if (segments.length < 3) throw new Error(`Ring for partition ${partitionId} has fewer than 3 segments`);

  return { segments, points };
}

function sameDirected(a: DirectedEdge, b: DirectedEdge): boolean {
  return a.from === b.from && a.to === b.to && a.cellIndex === b.cellIndex;
}

/** Signed area (positive = counter-clockwise in standard math axes). */
export function ringSignedArea(points: readonly MapPoint[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    sum += p.x * q.z - q.x * p.z;
  }
  return sum / 2;
}

export function ringPerimeter(points: readonly MapPoint[]): number {
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    total += Math.hypot(q.x - p.x, q.z - p.z);
  }
  return total;
}
