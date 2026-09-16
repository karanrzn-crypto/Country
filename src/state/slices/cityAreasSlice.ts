/**
 * City Areas state slice (Phase 2) — the persisted urban/transport network.
 *
 * The network's GEOMETRY is generated deterministically from the strategic
 * map (single geometric truth); the slice carries it as JSON-safe state so
 * runtime-mutable fields (development, capacity, control, link condition)
 * survive save/load and evolve over the campaign.
 *
 * On save LOAD the network is re-synced against the live map model:
 * regenerated areas/links keep their ids, and the saved runtime fields are
 * overlaid by id — stale ids (map config changed) are dropped.
 */

import type { StrategicMapModel } from '../../world/map/MapTypes';
import { buildCityAreaNetwork } from '../../world/cityareas/CityAreaGenerator';
import type { CityAreaNetwork } from '../../world/cityareas/CityAreaTypes';
import { clamp01 } from '../../government/types';

export type { CityAreaNetwork } from '../../world/cityareas/CityAreaTypes';

export interface CityAreasSlice {
  network: CityAreaNetwork;
}

/** Builds the initial slice from the generated map (deterministic). */
export function createCityAreasSlice(model: StrategicMapModel, columns: number): CityAreasSlice {
  const generation = buildCityAreaNetwork(model, columns);
  return { network: generation.network };
}

/**
 * Re-syncs the slice to the live map model after a save load: regenerates
 * the topology, then overlays saved runtime fields by id.
 */
export function syncCityAreas(slice: CityAreasSlice, model: StrategicMapModel, columns: number): void {
  const regenerated = buildCityAreaNetwork(model, columns).network;
  const savedAreas = slice.network.areas;
  const savedLinks = slice.network.links;

  for (const area of Object.values(regenerated.areas)) {
    const saved = savedAreas[area.id];
    if (saved === undefined) continue;
    area.development = clamp01(saved.development);
    area.population = Math.max(0, saved.population);
    area.capacity = Math.max(0, saved.capacity);
    area.controlledBy = saved.controlledBy;
    area.buildings = [...saved.buildings];
  }
  for (const link of Object.values(regenerated.links)) {
    const saved = savedLinks[link.id];
    if (saved === undefined) continue;
    link.condition = Math.max(0, Math.min(1, saved.condition));
    link.capacity = Math.max(0, saved.capacity);
  }

  slice.network = regenerated;
}

/** Sets an area's development level (clamped 0..1). Returns the clamped value. */
export function setAreaDevelopment(slice: CityAreasSlice, areaId: string, value: number): number {
  const area = slice.network.areas[areaId];
  if (area === undefined) return 0;
  area.development = clamp01(value);
  return area.development;
}

/** Sets a link's condition (clamped 0..1). Returns the clamped value. */
export function setLinkCondition(slice: CityAreasSlice, linkId: string, value: number): number {
  const link = slice.network.links[linkId];
  if (link === undefined) return 0;
  link.condition = clamp01(value);
  return link.condition;
}

/** Structural integrity check for tests + save validation. */
export function cityAreaNetworkIsCoherent(network: CityAreaNetwork): boolean {
  for (const link of Object.values(network.links)) {
    if (network.areas[link.a] === undefined || network.areas[link.b] === undefined) return false;
    if (link.a === link.b) return false;
    if (!(link.length > 0)) return false;
    if (link.condition < 0 || link.condition > 1) return false;
    if (link.path.length < 2) return false;
  }
  for (const area of Object.values(network.areas)) {
    if (area.footprint.length < 3) return false;
    if (area.development < 0 || area.development > 1) return false;
    if (area.capacity < 0 || area.population < 0) return false;
  }
  return true;
}
