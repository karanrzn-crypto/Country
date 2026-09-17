import { describe, it, expect } from 'vitest';
import { createTestGame } from '../../../helpers/testGame';
import { cityConnectionsOf } from '../../../../world/cityareas/CityConnections';
import { cellIndexAtPoint } from '../../../../world/map/MapQueries';
import { DEFAULT_CONFIG } from '../../../../config/configTypes';
import type { StrategicMapModel, MapPoint } from '../../../../world/map/MapTypes';

/**
 * MapRoutes geometry contract (user directive — roads must never cross
 * water, port lanes must never cut across land):
 *
 *  - every road/railway polyline stays on DRY land — no ocean, no lake,
 *    and no more than a narrow river crossing (a bank-hugging bridge);
 *  - the two reported city connections (Orissgrad ← Norauliskeindport,
 *    Areimgrad ← Peliandiskuthhaven) are land routes now — fixed at the
 *    GENERATOR level, not hardcoded;
 *  - every sea route runs through WATER (interior samples), following the
 *    coastline with multiple bends on long lanes;
 *  - connection paths still start and end EXACTLY at the city positions.
 */

function waterKindOf(
  model: StrategicMapModel,
  point: MapPoint
): 'ocean' | 'lake' | 'river' | null {
  const { columns, rows, cellSize } = DEFAULT_CONFIG.map;
  const cellIndex = cellIndexAtPoint(model, point, columns, rows, cellSize);
  if (cellIndex < 0) return null;
  if (model.features.biomes[cellIndex] === 'ocean') return 'ocean';
  for (const lake of model.features.lakes) {
    if (lake.cells.includes(cellIndex)) return 'lake';
  }
  for (const river of model.features.rivers) {
    if (river.cells.includes(cellIndex)) return 'river';
  }
  return null;
}

function samplePoints(path: readonly MapPoint[], perSegment: number): MapPoint[] {
  const points: MapPoint[] = [];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    for (let s = 1; s < perSegment; s++) {
      const t = s / perSegment;
      points.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    }
  }
  return points;
}

describe('MapRoutes — terrain-aware transport geometry', () => {
  const game = createTestGame({ seed: 4242 });
  const model = game.strategicMap;
  const network = game.gameState.cityAreas.network;
  const connections = cityConnectionsOf(network);
  const nameOf = (cityId: string): string => model.cities[cityId]?.name ?? cityId;

  function waterHits(connectionPath: readonly MapPoint[]): {
    ocean: number;
    lake: number;
    river: number;
  } {
    const hits = { ocean: 0, lake: 0, river: 0 };
    for (const point of samplePoints(connectionPath, 8)) {
      const kind = waterKindOf(model, point);
      if (kind === 'ocean') hits.ocean += 1;
      else if (kind === 'lake') hits.lake += 1;
      else if (kind === 'river') hits.river += 1;
    }
    return hits;
  }

  it('roads and railways NEVER cross ocean or lake water (every connection sampled)', () => {
    expect(connections.length).toBeGreaterThan(0);
    for (const connection of connections) {
      const hits = waterHits(connection.path);
      expect(hits.ocean, `${connection.kind} ${nameOf(connection.cityA)}←→${nameOf(connection.cityB)} ocean`).toBe(0);
      expect(hits.lake, `${connection.kind} ${nameOf(connection.cityA)}←→${nameOf(connection.cityB)} lake`).toBe(0);
    }
  });

  it('river contact is a narrow bridge at most (never running along a river)', () => {
    for (const connection of connections) {
      const hits = waterHits(connection.path);
      expect(
        hits.river,
        `${connection.kind} ${nameOf(connection.cityA)}←→${nameOf(connection.cityB)} river`
      ).toBeLessThanOrEqual(4);
    }
  });

  it('the reported water-crossing connections are fixed: Orissgrad←→Norauliskeindport and Areimgrad←→Peliandiskuthhaven', () => {
    const problems = [
      ['Orissgrad', 'Norauliskeindport'],
      ['Areimgrad', 'Peliandiskuthhaven']
    ];
    for (const [nameA, nameB] of problems) {
      const connection = connections.find(
        (entry) =>
          (nameOf(entry.cityA) === nameA && nameOf(entry.cityB) === nameB) ||
          (nameOf(entry.cityA) === nameB && nameOf(entry.cityB) === nameA)
      );
      expect(connection, `${nameA} ←→ ${nameB}`).toBeDefined();
      const hits = waterHits(connection!.path);
      expect(hits.ocean + hits.lake + hits.river).toBe(0);
    }
  });

  it('every connection path still starts and ends EXACTLY at its city positions', () => {
    for (const connection of connections) {
      const first = connection.path[0];
      const last = connection.path[connection.path.length - 1];
      const cityA = model.cities[connection.cityA];
      const cityB = model.cities[connection.cityB];
      expect(Math.hypot(first.x - cityA.position.x, first.z - cityA.position.z)).toBeLessThan(1e-6);
      expect(Math.hypot(last.x - cityB.position.x, last.z - cityB.position.z)).toBeLessThan(1e-6);
    }
  });

  it('sea routes run through WATER away from their ports (no straight lines across land)', () => {
    const seaLines = model.features.lines.filter((line) => line.kind === 'seaRoute');
    expect(seaLines.length).toBeGreaterThan(0);
    for (const line of seaLines) {
      const path = line.polyline;
      const start = path[0];
      const end = path[path.length - 1];
      for (const point of samplePoints(path, 8)) {
        // Samples within ~1 cell of either port may be on the harbor's own
        // ground (the access); everything between must be water.
        const nearStart = Math.hypot(point.x - start.x, point.z - start.z) < DEFAULT_CONFIG.map.cellSize * 1.2;
        const nearEnd = Math.hypot(point.x - end.x, point.z - end.z) < DEFAULT_CONFIG.map.cellSize * 1.2;
        if (nearStart || nearEnd) continue;
        const kind = waterKindOf(model, point);
        expect(
          kind,
          `sea lane ${nameOf(line.cityA ?? '')}←→${nameOf(line.cityB ?? '')} dry sample (${point.x.toFixed(1)},${point.z.toFixed(1)})`
        ).not.toBeNull();
      }
    }
  });

  it('sea lanes are coastline-aware curves, not one repeated straight line', () => {
    const seaLines = model.features.lines.filter((line) => line.kind === 'seaRoute');
    let curved = 0;
    for (const line of seaLines) {
      const path = line.polyline;
      const straight = Math.hypot(
        path[path.length - 1].x - path[0].x,
        path[path.length - 1].z - path[0].z
      );
      let length = 0;
      for (let i = 1; i < path.length; i++) {
        length += Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
      }
      if (path.length > 2 || length > straight * 1.02) curved += 1;
    }
    // Most lanes must bend (bays/capes force detours; the hashed bow adds
    // per-pair variety) — a full set of straight lines would mean the
    // coastline is ignored again.
    expect(curved / seaLines.length).toBeGreaterThan(0.5);
  });
});
