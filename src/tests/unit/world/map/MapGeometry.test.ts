import { describe, it, expect } from 'vitest';
import {
  buildLattice,
  buildCells,
  buildSharedEdges,
  extractRegionRing,
  subdivideEdge,
  edgeKeyFor,
  ringSignedArea
} from '../../../../world/map/MapGeometry';
import { Random } from '../../../../utils/Random';
import type { MapEdge, MapPoint } from '../../../../world/map/MapTypes';

describe('MapGeometry — shared lattice, edges and rings', () => {
  const columns = 12;
  const rows = 8;
  const lattice = buildLattice(columns, rows, 10, 0.3, new Random(1234));
  const cells = buildCells(columns, rows);

  it('lattice has exact bounds (outer ring unjittered)', () => {
    expect(lattice.points).toHaveLength((columns + 1) * (rows + 1));
    expect(lattice.points[0]).toEqual({ x: 0, z: 0 });
    const last = lattice.points[lattice.points.length - 1];
    expect(last.x).toBe(columns * 10);
    expect(last.z).toBe(rows * 10);
    // Interior points are jittered but stay within the amplitude corridor.
    const interior = lattice.points[5 * (columns + 1) + 5];
    const idealX = 5 * 10;
    const idealZ = 5 * 10;
    expect(Math.abs(interior.x - idealX)).toBeLessThanOrEqual(3);
    expect(Math.abs(interior.z - idealZ)).toBeLessThanOrEqual(3);
  });

  it('cells reference lattice corners in clockwise order', () => {
    const cell = cells[0];
    expect(cell.corners).toEqual([0, 1, columns + 2, columns + 1]); // NW, NE, SE, SW
  });

  it('subdivideEdge is deterministic and stays near the original segment', () => {
    const a = { x: 0, z: 0 };
    const b = { x: 10, z: 0 };
    const run = (): MapPoint[] => subdivideEdge(a, b, 3, 0.12, new Random(42));
    const first = run();
    const second = run();
    expect(first).toEqual(second);
    expect(first).toHaveLength(8); // 2^3 points after subdivision (excluding start)
    // All points stay within the amplitude corridor around the segment.
    for (const point of first) {
      expect(Math.abs(point.z)).toBeLessThan(10 * 0.12 * 2 + 1e-9);
      expect(point.x).toBeGreaterThanOrEqual(-0.5);
      expect(point.x).toBeLessThanOrEqual(10.5);
    }
  });

  it('every shared edge is registered once and classified consistently', () => {
    // Partition: left half country 0, right half country 1, split into provinces.
    const landOf = new Int32Array(columns * rows).fill(-1);
    const subOf = new Int32Array(columns * rows).fill(-1);
    let provinceCounter = 0;
    for (const cell of cells) {
      const country = cell.cx < columns / 2 ? 0 : 1;
      landOf[cell.index] = country;
      subOf[cell.index] = provinceCounter++;
    }
    const result = buildSharedEdges(lattice, cells, landOf, subOf, 42, 3, 0.12);

    // Interior (ocean) cells contribute no edges.
    const total = Object.keys(result.edges).length;
    expect(total).toBeGreaterThan(0);

    // Every edge's polyline starts and ends exactly at its lattice endpoints.
    for (const edge of Object.values(result.edges) as readonly MapEdge[]) {
      const pointA = lattice.points[edge.a];
      const pointB = lattice.points[edge.b];
      expect(edge.polyline[0]).toEqual(pointA);
      expect(edge.polyline[edge.polyline.length - 1]).toEqual(pointB);
      if (edge.kind === 'coast') expect(result.coastEdgeKeys.has(edge.key)).toBe(true);
      if (edge.kind === 'country') expect(result.countryEdgeKeys.has(edge.key)).toBe(true);
      if (edge.kind === 'province') expect(result.provinceEdgeKeys.has(edge.key)).toBe(true);
    }

    // The split line between the two country halves must exist as country edges.
    expect(result.countryEdgeKeys.size).toBe(rows);

    // Coast edges: outer border of the land block.
    expect(result.coastEdgeKeys.size).toBe(2 * columns + 2 * rows);
  });

  it('extractRegionRing produces a closed, edge-referencing ring', () => {
    // Uniform partition: the whole block is one country, one province — so
    // the ring must cover EXACTLY the coast edges (2·cols + 2·rows).
    const landOf = new Int32Array(columns * rows).fill(0);
    const subOf = new Int32Array(columns * rows).fill(0);
    const result = buildSharedEdges(lattice, cells, landOf, subOf, 42, 3, 0.12);
    expect(result.coastEdgeKeys.size).toBe(2 * columns + 2 * rows);
    expect(result.countryEdgeKeys.size).toBe(0);
    expect(result.provinceEdgeKeys.size).toBe(0);

    const ring = extractRegionRing(cells, landOf, 0, columns, rows, result.edges);
    expect(ring.segments.length).toBeGreaterThanOrEqual(4);
    expect(ringSignedArea(ring.points)).not.toBe(0);

    // Every segment references the registry; each boundary edge exactly once.
    const keys = ring.segments.map((segment) => segment.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBe(result.coastEdgeKeys.size);

    // Direction consistency: point count = Σ (polyline length − 1) + 1 — the
    // exact concatenation of shared polylines: the first segment contributes
    // all its points, every later one skips its (duplicated) joint.
    const expectedPoints =
      ring.segments.reduce(
        (sum, segment) => sum + result.edges[segment.key].polyline.length - 1,
        0
      ) + 1;
    expect(ring.points).toHaveLength(expectedPoints);

    // Every forward segment traverses a→b; every reverse segment b→a. Both
    // use the SAME polyline — the definition of a shared border.
    for (const segment of ring.segments) {
      const edge = result.edges[segment.key];
      const traversed = segment.forward ? [edge.polyline[0], edge.polyline.at(-1)] : [edge.polyline.at(-1), edge.polyline[0]];
      const [start, end] = traversed as [MapPoint, MapPoint];
      const startIndex = latticeIndexByPoint(lattice.points, start);
      const endIndex = latticeIndexByPoint(lattice.points, end);
      expect(segment.forward ? startIndex === edge.a && endIndex === edge.b : startIndex === edge.b && endIndex === edge.a).toBe(true);
    }
  });

  it('edge keys are order-independent', () => {
    expect(edgeKeyFor(5, 2)).toBe(edgeKeyFor(2, 5));
    expect(edgeKeyFor(5, 2)).toBe('2|5');
  });
});

function latticeIndexByPoint(points: readonly MapPoint[], point: MapPoint): number {
  for (let i = 0; i < points.length; i++) {
    if (points[i].x === point.x && points[i].z === point.z) return i;
  }
  return -1;
}
