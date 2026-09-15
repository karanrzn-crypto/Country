/**
 * Map layer registry (core-side, renderer-agnostic).
 *
 * The renderer builds one visual group per layer in this exact order;
 * visibility lives in the map state slice so UI toggles and saves work
 * without touching the renderer. Pure data — no Three.js.
 */

export type MapLayerId =
  | 'ocean'
  | 'land'
  | 'countries'
  | 'countryBorders'
  | 'provinceBorders'
  | 'cities'
  | 'capitals'
  | 'labels';

/** Bottom → top render order. Borders/cities/labels must never be hidden by fills. */
export const MAP_LAYER_ORDER: readonly MapLayerId[] = [
  'ocean',
  'land',
  'countries',
  'provinceBorders',
  'countryBorders',
  'cities',
  'capitals',
  'labels'
] as const;

export const DEFAULT_LAYER_VISIBILITY: Readonly<Record<MapLayerId, boolean>> = {
  ocean: true,
  land: true,
  countries: true,
  countryBorders: true,
  provinceBorders: true,
  cities: true,
  capitals: true,
  labels: true
};

export function isKnownMapLayer(layer: string): layer is MapLayerId {
  return (MAP_LAYER_ORDER as readonly string[]).includes(layer);
}
