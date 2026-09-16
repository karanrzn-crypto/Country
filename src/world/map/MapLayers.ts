/**
 * Map layer registry (core-side, renderer-agnostic).
 *
 * EVERY information layer of the strategic map is declared HERE as data —
 * id, display label, UI group, default visibility and render order. Adding
 * a new layer means: (1) add an id + def below, (2) render/build it in the
 * renderer's layer table. No state rewrite, no UI rewrite (the toggle UI is
 * generated from this registry), no save migration (visibility is a record).
 *
 * The renderer builds one visual group per layer in MAP_LAYER_ORDER;
 * visibility lives in the map state slice so UI toggles and saves work
 * without touching the renderer. Pure data — no Three.js.
 */

export type MapLayerGroup = 'base' | 'geography' | 'infrastructure' | 'society';

export type MapLayerId =
  // base
  | 'ocean'
  | 'land'
  | 'countries'
  | 'countryBorders'
  | 'cityAreas'
  | 'labels'
  // geography
  | 'biomes'
  | 'terrain'
  | 'rivers'
  | 'provinceBorders'
  | 'cities'
  | 'capitals'
  // infrastructure
  | 'roads'
  | 'railways'
  | 'ports'
  | 'industry'
  | 'resources'
  | 'military'
  // society (population real; economy reads countrySlice; weather/intelligence
  // are extensible stubs filled by future systems without renderer rewrites)
  | 'population'
  | 'economy'
  | 'weather'
  | 'intelligence';

export interface MapLayerDef {
  readonly id: MapLayerId;
  /** English display label (UI renders it verbatim — no country data here). */
  readonly label: string;
  readonly group: MapLayerGroup;
  readonly defaultVisible: boolean;
}

/** Bottom → top render order. Fills < lines < borders < markers < labels. */
export const MAP_LAYERS: readonly MapLayerDef[] = [
  { id: 'ocean', label: 'Ocean', group: 'base', defaultVisible: true },
  { id: 'land', label: 'Land', group: 'base', defaultVisible: true },
  { id: 'countries', label: 'Countries', group: 'base', defaultVisible: true },
  { id: 'biomes', label: 'Biomes', group: 'geography', defaultVisible: false },
  { id: 'terrain', label: 'Terrain', group: 'geography', defaultVisible: false },
  { id: 'rivers', label: 'Rivers', group: 'geography', defaultVisible: true },
  { id: 'provinceBorders', label: 'Provinces', group: 'geography', defaultVisible: true },
  { id: 'cityAreas', label: 'City Areas', group: 'geography', defaultVisible: true },
  { id: 'countryBorders', label: 'Country Borders', group: 'base', defaultVisible: true },
  { id: 'roads', label: 'Roads', group: 'infrastructure', defaultVisible: false },
  { id: 'railways', label: 'Railways', group: 'infrastructure', defaultVisible: false },
  { id: 'ports', label: 'Ports', group: 'infrastructure', defaultVisible: false },
  { id: 'industry', label: 'Industry', group: 'infrastructure', defaultVisible: false },
  { id: 'resources', label: 'Resources', group: 'infrastructure', defaultVisible: false },
  { id: 'military', label: 'Military', group: 'infrastructure', defaultVisible: false },
  { id: 'cities', label: 'Cities', group: 'geography', defaultVisible: true },
  { id: 'capitals', label: 'Capitals', group: 'geography', defaultVisible: true },
  { id: 'population', label: 'Population', group: 'society', defaultVisible: false },
  { id: 'economy', label: 'Economy', group: 'society', defaultVisible: false },
  { id: 'weather', label: 'Weather', group: 'society', defaultVisible: false },
  { id: 'intelligence', label: 'Intelligence', group: 'society', defaultVisible: false },
  { id: 'labels', label: 'Labels', group: 'base', defaultVisible: true }
] as const;

/** Flat bottom→top id order (renderer group order + validation). */
export const MAP_LAYER_ORDER: readonly MapLayerId[] = MAP_LAYERS.map((layer) => layer.id);

/** Defaults derived from the registry — the single place to change them. */
export const DEFAULT_LAYER_VISIBILITY: Readonly<Record<MapLayerId, boolean>> = Object.fromEntries(
  MAP_LAYERS.map((layer) => [layer.id, layer.defaultVisible])
) as Readonly<Record<MapLayerId, boolean>>;

export function layerDef(layer: MapLayerId): MapLayerDef {
  const def = MAP_LAYERS.find((candidate) => candidate.id === layer);
  if (def === undefined) throw new Error(`Unknown map layer "${layer}"`);
  return def;
}

export function isKnownMapLayer(layer: string): layer is MapLayerId {
  return (MAP_LAYER_ORDER as readonly string[]).includes(layer);
}
