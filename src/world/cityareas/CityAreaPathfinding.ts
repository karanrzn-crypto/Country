/**
 * City Areas pathfinding (Phase 2) — routing over the area network.
 *
 * Dijkstra over area nodes with per-link travel cost:
 *   cost = length × kindFactor(kind) / max(condition, 0.05)
 * Low condition (worn roads) raises cost; railways are faster per unit
 * distance than roads. Future congestion/toll/cargo modifiers plug into
 * `linkCost` without touching the algorithm.
 *
 * Pure functions, no side effects — reusable by trade, transport and
 * movement systems alike.
 */

import type { CityArea, CityAreaLink, CityAreaNetwork, CityAreaLinkKind } from './CityAreaTypes';

/** Relative speed factor per link kind (higher = cheaper per world unit). */
export const LINK_SPEED_FACTOR: Readonly<Record<CityAreaLinkKind, number>> = {
  road: 1.0,
  railway: 1.8,
  sea: 0.9
};

/** Travel cost of one link (≥ 0). */
export function linkCost(link: CityAreaLink): number {
  const condition = Math.max(0.05, link.condition);
  return (link.length / LINK_SPEED_FACTOR[link.kind]) / condition;
}

interface AdjacencyEntry {
  linkId: string;
  other: string;
  cost: number;
}

/** Adjacency list keyed by area id (built per call; networks are small). */
export function buildAdjacency(network: CityAreaNetwork): Map<string, AdjacencyEntry[]> {
  const adjacency = new Map<string, AdjacencyEntry[]>();
  for (const areaId of Object.keys(network.areas)) adjacency.set(areaId, []);
  for (const link of Object.values(network.links)) {
    const cost = linkCost(link);
    adjacency.get(link.a)?.push({ linkId: link.id, other: link.b, cost });
    adjacency.get(link.b)?.push({ linkId: link.id, other: link.a, cost });
  }
  return adjacency;
}

export interface NetworkPath {
  /** Area ids from start to goal (inclusive). */
  areaIds: readonly string[];
  /** Link ids traversed, in order (length = areaIds.length − 1). */
  linkIds: readonly string[];
  /** Σ link costs along the path. */
  totalCost: number;
}

/**
 * Cheapest path between two areas, or null when unreachable.
 * start === goal yields a trivial single-node path.
 */
export function findPath(network: CityAreaNetwork, startId: string, goalId: string): NetworkPath | null {
  if (network.areas[startId] === undefined || network.areas[goalId] === undefined) return null;
  if (startId === goalId) return { areaIds: [startId], linkIds: [], totalCost: 0 };

  const adjacency = buildAdjacency(network);
  const distance = new Map<string, number>([[startId, 0]]);
  const previous = new Map<string, { areaId: string; linkId: string }>();
  const visited = new Set<string>();

  // Small-graph Dijkstra with linear minimum extraction (networks hold
  // dozens-to-hundreds of nodes; a heap would be over-engineering here).
  while (true) {
    let current: string | null = null;
    let currentCost = Number.POSITIVE_INFINITY;
    for (const [areaId, cost] of distance) {
      if (!visited.has(areaId) && cost < currentCost) {
        current = areaId;
        currentCost = cost;
      }
    }
    if (current === null) return null; // no reachable unvisited node left
    if (current === goalId) break;
    visited.add(current);
    for (const edge of adjacency.get(current) ?? []) {
      if (visited.has(edge.other)) continue;
      const candidate = currentCost + edge.cost;
      if (candidate < (distance.get(edge.other) ?? Number.POSITIVE_INFINITY)) {
        distance.set(edge.other, candidate);
        previous.set(edge.other, { areaId: current, linkId: edge.linkId });
      }
    }
  }

  // —— reconstruct ——
  const areaIds: string[] = [goalId];
  const linkIds: string[] = [];
  let cursor = goalId;
  while (cursor !== startId) {
    const step = previous.get(cursor);
    if (step === undefined) return null;
    linkIds.unshift(step.linkId);
    cursor = step.areaId;
    areaIds.unshift(cursor);
  }
  return { areaIds, linkIds, totalCost: distance.get(goalId) ?? 0 };
}

/** Areas of one country (utility for UI + economy hooks). */
export function areasOfCountry(network: CityAreaNetwork, countryId: string): CityArea[] {
  return Object.values(network.areas).filter((area) => area.countryId === countryId);
}

export interface CityAreaNetworkSummary {
  areas: number;
  links: number;
  junctions: number;
  /** Mean development over the country's areas (0..1). */
  averageDevelopment: number;
  /** Σ area capacity (persons). */
  totalCapacity: number;
  /** Share of the country's areas in the largest connected component. */
  connectivity: number;
}

/** Aggregate metrics for one country — the economy's urbanization hook. */
export function networkSummary(network: CityAreaNetwork, countryId: string): CityAreaNetworkSummary {
  const areas = areasOfCountry(network, countryId);
  const areaIds = new Set(areas.map((area) => area.id));

  // Transport hubs (junctions) are SHARED infrastructure: a cross-border
  // road's junction may be "owned" by the neighbor, but it still routes
  // domestic traffic. Connectivity analysis walks through hubs regardless
  // of who controls them; the denominator stays the country's own areas.
  const nodes = new Set<string>(areaIds);
  for (const link of Object.values(network.links)) {
    const aOwn = areaIds.has(link.a);
    const bOwn = areaIds.has(link.b);
    if (aOwn && !bOwn && network.areas[link.b]?.transportHub) nodes.add(link.b);
    if (bOwn && !aOwn && network.areas[link.a]?.transportHub) nodes.add(link.a);
  }
  const internalLinks = Object.values(network.links).filter(
    (link) => nodes.has(link.a) && nodes.has(link.b)
  );

  // —— largest connected component (union-find over the relevant links) ——
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const root = parent.get(id);
    if (root === undefined || root === id) return id;
    const resolved = find(root);
    parent.set(id, resolved);
    return resolved;
  };
  for (const id of nodes) parent.set(id, id);
  for (const link of internalLinks) {
    const rootA = find(link.a);
    const rootB = find(link.b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  }
  const ownComponentSize = new Map<string, number>();
  for (const area of areas) {
    const root = find(area.id);
    ownComponentSize.set(root, (ownComponentSize.get(root) ?? 0) + 1);
  }
  const largest = Math.max(0, ...ownComponentSize.values());

  const junctionCount =
    areas.filter((area) => area.type === 'junction').length +
    Object.values(network.areas).filter(
      (area) =>
        area.type === 'junction' &&
        !areaIds.has(area.id) &&
        nodes.has(area.id)
    ).length;

  return {
    areas: areas.length,
    links: internalLinks.length,
    junctions: junctionCount,
    averageDevelopment:
      areas.length === 0
        ? 0
        : areas.reduce((sum, area) => sum + area.development, 0) / areas.length,
    totalCapacity: areas.reduce((sum, area) => sum + area.capacity, 0),
    connectivity: areas.length === 0 ? 0 : largest / areas.length
  };
}
