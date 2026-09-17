/**
 * City Connections — the CITY-LEVEL view of the City Areas network.
 *
 * The CityAreaNetwork graph is AREA-level (cores, districts, junctions).
 * Map rendering and info panels need the human-level answer: WHICH city is
 * connected to WHICH city, along which real path. This module derives those
 * city-to-city connections deterministically from the network itself —
 * NO parallel data, NO synthetic coordinates:
 *
 *  - a road link whose two endpoint areas belong to DIFFERENT cities is one
 *    direct connection;
 *  - an inter-city road passes through its junction node (link A: city
 *    district → junction, link B: junction → other city district): the two
 *    halves are MERGED back into one continuous city→city route whose path
 *    is exactly the shared map road polyline (city center → … → city center);
 *  - railway links already run core→core → direct connections.
 *
 * Intra-city links (core↔district, core↔farmland) are deliberately NOT
 * connections — they are the urban interior, drawn as city highlights, not
 * as inter-city routes.
 *
 * Leaf module: imports only CityAreaTypes (world/map type re-export).
 */

import type { MapPoint } from '../map/MapTypes';
import type { CityArea, CityAreaLink, CityAreaNetwork, CityAreaLinkKind } from './CityAreaTypes';

/** Display approximation: 1 world unit = 4 km (map cell = 10 units ≈ 40 km).
 *  The only place world→km is defined, so every panel agrees on distances. */
export const KM_PER_WORLD_UNIT = 4;

/** One city-to-city connection (the drawn route between two settlements). */
export interface CityConnection {
  /** Stable id derived from the constituent network link ids. */
  id: string;
  kind: CityAreaLinkKind;
  /** City ids of the two endpoints (never equal, undirected pair). */
  cityA: string;
  cityB: string;
  /** Province ids of the endpoint cities (from the area records). */
  provinceA: string;
  provinceB: string;
  /** True when the route crosses a province border. */
  crossProvince: boolean;
  /** Continuous world-space path; endpoints sit on the two city positions. */
  path: readonly MapPoint[];
  /** Path length in world units (sum of the constituent link lengths). */
  length: number;
  /** Constitutive network link ids (road halves / direct link). */
  linkIds: readonly string[];
}

const EPSILON = 1e-9;

function pointsEqual(a: MapPoint, b: MapPoint): boolean {
  return Math.abs(a.x - b.x) < EPSILON && Math.abs(a.z - b.z) < EPSILON;
}

function concatPaths(
  first: readonly MapPoint[],
  second: readonly MapPoint[]
): MapPoint[] {
  const merged = [...first];
  const tail = second[0] !== undefined && pointsEqual(merged[merged.length - 1], second[0])
    ? second.slice(1)
    : [...second];
  for (const point of tail) merged.push(point);
  return merged;
}

/** Canonical undirected pair id for the two city ids (deterministic). */
function cityPairKey(cityA: string, cityB: string): string {
  return cityA < cityB ? `${cityA}|${cityB}` : `${cityB}|${cityA}`;
}

/**
 * Derives every city-to-city connection of the network. Deterministic:
 * same network → same connections in the same order (areas and links are
 * iterated over their Record key order, and each connection id is stable).
 */
export function cityConnectionsOf(network: CityAreaNetwork): CityConnection[] {
  const areas = network.areas;
  const links = network.links;

  // —— junction halves: junction area id → the (single) city-side link ——
  // A junction may carry 1 road half only when its sibling link could not be
  // created (degenerate path); those never form a city→city route.
  const halvesByJunction = new Map<string, { link: CityAreaLink; cityId: string; area: CityArea }[]>();

  const connections: CityConnection[] = [];
  const seenPairKinds = new Set<string>();

  const endpointArea = (link: CityAreaLink, other: string): CityArea | undefined =>
    areas[link.a === other ? link.b : link.a];

  const pushDirect = (link: CityAreaLink, areaA: CityArea, areaB: CityArea): void => {
    if (areaA.cityId === null || areaB.cityId === null || areaA.cityId === areaB.cityId) return;
    const key = `${cityPairKey(areaA.cityId, areaB.cityId)}#${link.kind}`;
    if (seenPairKinds.has(key)) return; // one route per city pair + kind
    seenPairKinds.add(key);
    connections.push({
      id: `conn_${link.id}`,
      kind: link.kind,
      cityA: areaA.cityId,
      cityB: areaB.cityId,
      provinceA: areaA.provinceId,
      provinceB: areaB.provinceId,
      crossProvince: areaA.provinceId !== areaB.provinceId,
      path: [...link.path],
      length: link.length,
      linkIds: [link.id]
    });
  };

  // —— pass 1: direct links (railway core→core, or a direct road between
  // two cities' areas without a junction) ——
  for (const link of Object.values(links)) {
    const areaA = areas[link.a];
    const areaB = areas[link.b];
    if (areaA === undefined || areaB === undefined) continue;
    const aHub = areaA.transportHub;
    const bHub = areaB.transportHub;
    if (!aHub && !bHub) {
      pushDirect(link, areaA, areaB);
      continue;
    }
    // Exactly one hub side (generator guarantees 2 halves per junction, but
    // stay defensive for hand-edited state).
    const junctionId = aHub ? link.a : bHub ? link.b : null;
    const cityArea = endpointArea(link, junctionId ?? link.a);
    if (junctionId === null || cityArea === undefined || cityArea.cityId === null) continue;
    let halves = halvesByJunction.get(junctionId);
    if (halves === undefined) {
      halves = [];
      halvesByJunction.set(junctionId, halves);
    }
    halves.push({ link, cityId: cityArea.cityId, area: cityArea });
  }

  // —— pass 2: merge junction halves into continuous city→city routes ——
  for (const [junctionId, halves] of halvesByJunction) {
    if (halves.length !== 2) continue;
    const [first, second] = halves;
    if (first.cityId === second.cityId) continue;
    const provinceA = first.area.provinceId;
    const provinceB = second.area.provinceId;
    const pairKey = `${cityPairKey(first.cityId, second.cityId)}#road`;
    // One ROAD route per city pair — a second road would need a second
    // junction between the same cities, which the MST road network cannot
    // produce (kept as a data-driven guard, not an assumption).
    if (seenPairKinds.has(pairKey)) continue;
    seenPairKinds.add(pairKey);
    const ordered = first.link.id < second.link.id ? [first, second] : [second, first];
    connections.push({
      id: `conn_${junctionId}`,
      kind: 'road',
      cityA: ordered[0].cityId,
      cityB: ordered[1].cityId,
      provinceA,
      provinceB,
      crossProvince: provinceA !== provinceB,
      path: concatPaths(ordered[0].link.path, ordered[1].link.path),
      length: ordered[0].link.length + ordered[1].link.length,
      linkIds: [ordered[0].link.id, ordered[1].link.id]
    });
  }

  return connections;
}

/** All connections touching one city (either endpoint). */
export function connectionsOfCity(
  connections: readonly CityConnection[],
  cityId: string
): CityConnection[] {
  return connections.filter((connection) => connection.cityA === cityId || connection.cityB === cityId);
}

/** True when the connection id exists in the list (selection validation). */
export function cityConnectionExists(
  connections: readonly CityConnection[],
  connectionId: string
): boolean {
  return connections.some((connection) => connection.id === connectionId);
}

function distancePointToSegment(
  px: number,
  pz: number,
  a: MapPoint,
  b: MapPoint
): number {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const lengthSquared = abx * abx + abz * abz;
  if (lengthSquared <= EPSILON) return Math.hypot(px - a.x, pz - a.z);
  let t = ((px - a.x) * abx + (pz - a.z) * abz) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a.x + abx * t), pz - (a.z + abz * t));
}

/** Distance from a point to a polyline (min over segments). */
export function distancePointToPath(point: MapPoint, path: readonly MapPoint[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let index = 1; index < path.length && best > 0; index += 1) {
    const distance = distancePointToSegment(point.x, point.z, path[index - 1], path[index]);
    if (distance < best) best = distance;
  }
  return best;
}

/**
 * Picks the connection nearest to a world position within `maxDistance`
 * (map click → route selection). Returns the connection id or null.
 * Ties break deterministically by id.
 */
export function pickCityConnection(
  connections: readonly CityConnection[],
  point: MapPoint,
  maxDistance: number
): string | null {
  let bestId: string | null = null;
  let bestDistance = maxDistance;
  for (const connection of connections) {
    const distance = distancePointToPath(point, connection.path);
    if (distance > bestDistance + EPSILON) continue;
    if (
      distance < bestDistance - EPSILON ||
      (bestId !== null && connection.id < bestId)
    ) {
      bestDistance = distance;
      bestId = connection.id;
    }
  }
  return bestId;
}

/** Other endpoint of a connection relative to one city. */
export function connectionOtherCity(connection: CityConnection, cityId: string): string {
  return connection.cityA === cityId ? connection.cityB : connection.cityA;
}

/** World-unit path length → display kilometers (whole km). */
export function connectionLengthKm(connection: CityConnection): number {
  return Math.round(connection.length * KM_PER_WORLD_UNIT);
}
