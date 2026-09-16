/**
 * City Areas — spatial network domain (Phase 2).
 *
 * City Areas are NOT decorative map lines: they form a real GRAPH of urban
 * and rural areas connected by transport links, generated deterministically
 * from the strategic-map geography (city rings, road/railway polylines,
 * province cells). The topology is the foundation for future trade routing,
 * transport capacity, urban development and military movement:
 *
 *   City A (core) → Suburban Area → Road Junction → Industrial Area → City B
 *
 * Design guardrails (per spec): real topology (nodes + edges + junctions +
 * travel costs), but NOT a full GIS — footprint polygons are lightweight
 * approximations anchored to the shared map geometry, and every field is
 * JSON-safe state the save system can persist verbatim.
 *
 * Leaf module: imports nothing but world/map types.
 */

import type { MapPoint } from '../map/MapTypes';

/** Area classification — the node type of the network. */
export type CityAreaType =
  | 'urban_core' // city center (one per city)
  | 'residential' // housing district
  | 'commercial' // markets, offices
  | 'industrial' // factories, works
  | 'suburban' // fringe district of small settlements
  | 'agricultural' // farmland / rural surroundings
  | 'junction' // transport interchange (≥ 3 links in future, 2 today)
  | 'port_area'; // harbor district (reserved — future coastal generation)

/** Transport link classification — the edge type of the network. */
export type CityAreaLinkKind = 'road' | 'railway' | 'sea';

/** One area (node). All fields JSON-safe. */
export interface CityArea {
  /** Stable id, derived from map ids (e.g. `area_city_000003_core`). */
  id: string;
  countryId: string;
  provinceId: string;
  /** Owning city, or null for rural/junction areas. */
  cityId: string | null;
  name: string;
  type: CityAreaType;
  /** World-space anchor (node position for pathfinding and future drawing). */
  position: MapPoint;
  /** Approximate ground footprint (closed polygon, ≥ 3 points). */
  footprint: readonly MapPoint[];
  /** Current residents / utilized capacity (persons). */
  population: number;
  /** Approximate population or throughput capacity (persons). */
  capacity: number;
  /** 0..1 development level — infrastructure & buildings raise it. */
  development: number;
  /** Map building/site ids located in this area. */
  buildings: readonly string[];
  /** Controlling country (future: occupation, autonomy). */
  controlledBy: string;
  /** True for interchange/transport nodes (junctions, future ports). */
  transportHub: boolean;
}

/** One transport link (edge) between two areas. */
export interface CityAreaLink {
  id: string;
  kind: CityAreaLinkKind;
  /** Endpoint area ids (undirected edge; stored a < b by construction). */
  a: string;
  b: string;
  /** World-space path (polyline; endpoints are the area positions). */
  path: readonly MapPoint[];
  /** Path length in world units (> 0). */
  length: number;
  /** Relative throughput (persons/goods per tick unit; 0 = unlimited). */
  capacity: number;
  /** 0..1 condition — decay/maintenance and sabotage live here later. */
  condition: number;
}

/** The whole national network (flat — cross-border links fit naturally). */
export interface CityAreaNetwork {
  areas: Record<string, CityArea>;
  links: Record<string, CityAreaLink>;
}
