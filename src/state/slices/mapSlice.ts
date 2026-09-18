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
import type { StrategicMapModel } from '../../world/map/MapTypes';
import { DEFAULT_LAYER_VISIBILITY } from '../../world/map/MapLayers';
import type { CityConnection } from '../../world/cityareas/CityConnections';
import { connectionsOfCity } from '../../world/cityareas/CityConnections';

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

/** What a plain land click selects: the country, or the province under it. */
export type MapSelectionMode = 'country' | 'province';

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
  /**
   * City Areas network connection (`CityConnection.id`) — selectable only
   * while the 'urbanRoads' layer is visible. References the DERIVED city
   * network view; never copies its geometry (no parallel state).
   */
  selectedCityConnectionId: string | null;
  /**
   * Region-selection mode (presentation policy, saved with the map):
   * 'country' → a land click selects the COUNTRY under the point;
   * 'province' → a land click selects the PROVINCE under the point (and
   * its country). Feature kinds (city/river/lake/…) are unaffected —
   * only the land fallback changes.
   */
  selectionMode: MapSelectionMode;
  /**
   * BUILD MODE (spec §1): the building typeId the player is placing, or
   * null. While active, a map click resolves as a BUILD PLACEMENT on the
   * clicked grid cell (own country, one economic building per region) —
   * not as a selection. The core owns the mode like the selection policy;
   * the grid layer is force-enabled while the mode is active so the cells
   * are visible and clickable.
   */
  buildMode: string | null;
  /**
   * BUILD PREVIEW (spec §3/§21): the cell the player picked WHILE a build
   * mode is active, held for CONFIRMATION — the UI shows the region's land
   * quality and the estimated output, then the player confirms (the project
   * starts) or cancels. Null when no cell is previewed.
   */
  buildPreview: { readonly typeId: string; readonly cellKey: string } | null;
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
  | { readonly kind: 'building'; readonly buildingId: string }
  | { readonly kind: 'cityLink'; readonly connectionId: string };

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
    selectedCityConnectionId: null,
    selectionMode: 'country',
    buildMode: null,
    buildPreview: null,
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
  slice.selectedCityConnectionId = null;
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
  slice.selectedCityConnectionId = null;
}

/**
 * Feature selection (grid cell / river / lake / site / building / city
 * network connection). Clears the country hierarchy and every other feature
 * kind atomically. Pure state write — ids are NOT validated here (the caller
 * resolves them from the model; describe* functions re-validate on read).
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
    case 'cityLink':
      slice.selectedCityConnectionId = selection.connectionId;
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
  if (slice.selectedCityConnectionId !== null) {
    return { kind: 'cityLink', connectionId: slice.selectedCityConnectionId };
  }
  return null;
}

/**
 * ONE human-readable summary of THE central selection — every panel that
 * shows "what is selected" renders THIS string, so the general Selection
 * row and the feature detail block can never disagree (they read the same
 * state through the same function). Resolution order mirrors the pick
 * priority: feature kinds first, then the country hierarchy (city ⇒
 * province ⇒ country), then the empty state.
 *
 * Pure function over (state, model) — unit-testable without DOM.
 */
export function selectionSummary(
  slice: MapSlice,
  model: StrategicMapModel,
  cityConnections: readonly CityConnection[] = []
): string {
  const feature = featureSelectionOf(slice);
  if (feature !== null) {
    switch (feature.kind) {
      case 'cityLink': {
        const connection = cityConnections.find((entry) => entry.id === feature.connectionId);
        if (connection === undefined) return 'اتصال شهری ناشناخته';
        const nameA = model.cities[connection.cityA]?.name ?? connection.cityA;
        const nameB = model.cities[connection.cityB]?.name ?? connection.cityB;
        return `${nameA} → ${nameB} (اتصال شهری)`;
      }
      case 'grid': {
        // `countryId#gridId` → "B7 (خانهٔ شبکه، CountryName)".
        const separator = feature.gridKey.indexOf('#');
        const countryId = feature.gridKey.slice(0, separator);
        const gridId = feature.gridKey.slice(separator + 1);
        const country = model.countries[countryId];
        return `${gridId} (خانهٔ شبکه، ${country?.name ?? countryId})`;
      }
      case 'river': {
        const river = model.features.rivers.find((candidate) => candidate.id === feature.riverId);
        return river !== undefined ? `${river.name} (رودخانه)` : 'رودخانهٔ ناشناخته';
      }
      case 'lake': {
        const lake = model.features.lakes.find((candidate) => candidate.id === feature.lakeId);
        return lake !== undefined ? `${lake.name} (دریاچه)` : 'دریاچهٔ ناشناخته';
      }
      case 'site': {
        const site = model.features.sites.find((candidate) => candidate.id === feature.siteId);
        return site !== undefined ? `${site.kind} (محوطه)` : 'محوطهٔ ناشناخته';
      }
      case 'building': {
        const building = model.features.buildings.find(
          (candidate) => candidate.id === feature.buildingId
        );
        return building !== undefined ? `${building.kind} (ساختمان)` : 'ساختمان ناشناخته';
      }
    }
  }
  if (slice.selectedCityId !== null) {
    const city = model.cities[slice.selectedCityId];
    if (city !== undefined) {
      const linked = connectionsOfCity(cityConnections, city.id).length;
      return `${city.name} (شهر، ${city.isCapital ? 'پایتخت' : 'شهر'}${linked > 0 ? `، ${linked} اتصال` : ''})`;
    }
  }
  if (slice.selectedProvinceId !== null) {
    const province = model.provinces[slice.selectedProvinceId];
    if (province !== undefined) return `${province.name} (استان)`;
  }
  if (slice.selectedCountryId !== null) {
    const country = model.countries[slice.selectedCountryId];
    if (country !== undefined) return `${country.name} (کشور)`;
  }
  return 'هیچ — روی نقشه کلیک کنید';
}
