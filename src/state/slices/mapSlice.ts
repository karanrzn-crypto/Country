/**
 * Map state slice — the DYNAMIC part of the strategic map:
 * selection, layer visibility and the logical camera.
 *
 * Static geography (polygons, countries, cities) is NOT here — it lives in
 * the immutable StrategicMapModel built once per seed. Everything in this
 * slice is JSON-safe and participates in save/load + state hashing.
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
  layerVisibility: Record<MapLayerId, boolean>;
  camera: MapCameraState;
  viewport: MapViewport;
}

/** Default logical camera: whole continent centered, fully zoomed out. */
export function createDefaultMapSlice(columns = 30, rows = 20, cellSize = 10): MapSlice {
  return {
    selectedCountryId: null,
    selectedProvinceId: null,
    selectedCityId: null,
    layerVisibility: { ...DEFAULT_LAYER_VISIBILITY },
    camera: { x: (columns * cellSize) / 2, z: (rows * cellSize) / 2, viewHeight: rows * cellSize },
    viewport: { width: 1280, height: 720 }
  };
}

export function clearMapSelection(slice: MapSlice): void {
  slice.selectedCountryId = null;
  slice.selectedProvinceId = null;
  slice.selectedCityId = null;
}

/** Selection is hierarchical: city ⇒ province ⇒ country. */
export function setMapSelection(
  slice: MapSlice,
  ids: { countryId?: string | null; provinceId?: string | null; cityId?: string | null }
): void {
  slice.selectedCityId = ids.cityId ?? null;
  slice.selectedProvinceId = ids.provinceId ?? null;
  slice.selectedCountryId = ids.countryId ?? null;
}
