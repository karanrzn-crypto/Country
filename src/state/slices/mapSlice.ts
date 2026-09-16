/**
 * Map state slice — the DYNAMIC part of the strategic map:
 * selection, layer visibility and the logical camera.
 *
 * Static geography (polygons, countries, cities) is NOT here — it lives in
 * the immutable StrategicMapModel built once per seed. Everything in this
 * slice is JSON-safe and participates in save/load + state hashing.
 *
 * Selection model (Part 3.5 — shared map interaction):
 * - the country hierarchy (country ⇒ province ⇒ city) and the FEATURE
 *   selections (grid cell / river / lake / site / building) are mutually
 *   exclusive KINDS — selecting one kind clears the others, so the panel
 *   always shows exactly one coherent selection;
 * - a grid cell is stored by its CANONICAL key `countryId#gridId` — "A3"
 *   exists in every country, the key never conflicts;
 * - all ids are references into the central StrategicMapModel — the state
 *   never copies geometry or feature data (no parallel state).
 */

import type { CountryId, ProvinceId, CityId } from '../../world/types';
import type { MapLayerId } from '../../world/map/MapLayers';
import { DEFAULT_LAYER_VISIBILITY } from '../../world/map/MapLayers';

export interface MapCameraState {
  /** Camera center in world coordinates. */
  x: number;
  z: number;
  /** Visible world height — smaller means more zoomed in. */
  viewHeight: number;
}

export interface MapViewport {
  width: number;
  height: number;
}

export interface MapSlice {
  selectedCountryId: CountryId | null;
  selectedProvinceId: ProvinceId | null;
  selectedCityId: CityId | null;
  /** Canonical grid-cell key `countryId#gridId` (e.g. "country_3#A3"). */
  selectedGridKey: string | null;
  selectedRiverId: string | null;
  selectedLakeId: string | null;
  /** features.sites entry (mine/oil/farm/factory/port/base/airbase). */
  selectedSiteId: string | null;
  /** features.buildings entry (urban facility). */
  selectedBuildingId: string | null;
  layerVisibility: Record<MapLayerId, boolean>;
  camera: MapCameraState;
  viewport: MapViewport;
}

/** One coherent feature selection (exactly one kind set at a time). */
export type MapFeatureSelection =
  | { readonly kind: 'grid'; readonly gridKey: string }
  | { readonly kind: 'river'; readonly riverId: string }
  | { readonly kind: 'lake'; readonly lakeId: string }
  | { readonly kind: 'site'; readonly siteId: string }
  | { readonly kind: 'building'; readonly buildingId: string };

/** Default logical camera: whole continent centered, fully zoomed out. */
export function createDefaultMapSlice(columns = 30, rows = 20, cellSize = 10): MapSlice {
  return {
    selectedCountryId: null,
    selectedProvinceId: null,
    selectedCityId: null,
    selectedGridKey: null,
    selectedRiverId: null,
    selectedLakeId: null,
    selectedSiteId: null,
    selectedBuildingId: null,
    layerVisibility: { ...DEFAULT_LAYER_VISIBILITY },
    camera: { x: (columns * cellSize) / 2, z: (rows * cellSize) / 2, viewHeight: rows * cellSize },
    viewport: { width: 1280, height: 720 }
  };
}

export function clearMapSelection(slice: MapSlice): void {
  slice.selectedCountryId = null;
  slice.selectedProvinceId = null;
  slice.selectedCityId = null;
  slice.selectedGridKey = null;
  slice.selectedRiverId = null;
  slice.selectedLakeId = null;
  slice.selectedSiteId = null;
  slice.selectedBuildingId = null;
}

/**
 * Hierarchy selection (country ⇐ province ⇐ city). Selecting the hierarchy
 * clears any feature selection — one coherent selection at a time.
 */
export function setMapSelection(
  slice: MapSlice,
  ids: { countryId?: string | null; provinceId?: string | null; cityId?: string | null }
): void {
  slice.selectedCityId = ids.cityId ?? null;
  slice.selectedProvinceId = ids.provinceId ?? null;
  slice.selectedCountryId = ids.countryId ?? null;
  slice.selectedGridKey = null;
  slice.selectedRiverId = null;
  slice.selectedLakeId = null;
  slice.selectedSiteId = null;
  slice.selectedBuildingId = null;
}

/**
 * Feature selection (grid cell / river / lake / site / building). Clears the
 * country hierarchy and every other feature kind atomically. Pure state
 * write — ids are NOT validated here (the caller resolves them from the
 * model; describe* functions re-validate on read).
 */
export function setFeatureSelection(slice: MapSlice, selection: MapFeatureSelection): void {
  clearMapSelection(slice);
  switch (selection.kind) {
    case 'grid':
      slice.selectedGridKey = selection.gridKey;
      break;
    case 'river':
      slice.selectedRiverId = selection.riverId;
      break;
    case 'lake':
      slice.selectedLakeId = selection.lakeId;
      break;
    case 'site':
      slice.selectedSiteId = selection.siteId;
      break;
    case 'building':
      slice.selectedBuildingId = selection.buildingId;
      break;
  }
}

/** The current selection as a feature kind, or null for hierarchy/none. */
export function featureSelectionOf(slice: MapSlice): MapFeatureSelection | null {
  if (slice.selectedGridKey !== null) return { kind: 'grid', gridKey: slice.selectedGridKey };
  if (slice.selectedRiverId !== null) return { kind: 'river', riverId: slice.selectedRiverId };
  if (slice.selectedLakeId !== null) return { kind: 'lake', lakeId: slice.selectedLakeId };
  if (slice.selectedSiteId !== null) return { kind: 'site', siteId: slice.selectedSiteId };
  if (slice.selectedBuildingId !== null) {
    return { kind: 'building', buildingId: slice.selectedBuildingId };
  }
  return null;
}
