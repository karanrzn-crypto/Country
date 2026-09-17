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
  | 'lakes'
  | 'grid'
  | 'provinceBorders'
  | 'cities'
  | 'capitals'
  // infrastructure
  // ('roads' was removed as a user-facing layer — the road LINES remain in
  //  the map model and inside the City Areas network, but there is no
  //  standalone Roads toggle any more.)
  | 'railways'
  | 'airports'
  | 'ports'
  | 'industry'
  | 'buildings'
  | 'resources'
  | 'military'
  // society (population real; economy reads countrySlice; weather/intelligence
  // are extensible stubs filled by future systems without renderer rewrites)
  | 'population'
  | 'economy'
  | 'strategic'
  | 'weather'
  | 'intelligence';

export interface MapLayerDef {
  readonly id: MapLayerId;
  /** Persian display label (UI renders it verbatim — no country data here). */
  readonly label: string;
  readonly group: MapLayerGroup;
  readonly defaultVisible: boolean;
}

/** Bottom → top render order. Fills < lines < borders < markers < labels. */
export const MAP_LAYERS: readonly MapLayerDef[] = [
  { id: 'ocean', label: 'اقیانوس', group: 'base', defaultVisible: true },
  { id: 'land', label: 'خشکی', group: 'base', defaultVisible: true },
  { id: 'countries', label: 'کشورها', group: 'base', defaultVisible: true },
  { id: 'biomes', label: 'زیست‌بوم‌ها', group: 'geography', defaultVisible: false },
  { id: 'terrain', label: 'توپوگرافی', group: 'geography', defaultVisible: false },
  { id: 'rivers', label: 'رودخانه‌ها', group: 'geography', defaultVisible: true },
  { id: 'lakes', label: 'دریاچه‌ها / آب', group: 'geography', defaultVisible: true },
  { id: 'grid', label: 'شبکهٔ جغرافیایی', group: 'geography', defaultVisible: false },
  { id: 'provinceBorders', label: 'استان‌ها', group: 'geography', defaultVisible: true },
  { id: 'cityAreas', label: 'مناطق شهری', group: 'geography', defaultVisible: true },
  { id: 'countryBorders', label: 'مرز کشورها', group: 'base', defaultVisible: true },
  { id: 'railways', label: 'راه‌آهن‌ها', group: 'infrastructure', defaultVisible: false },
  { id: 'airports', label: 'فرودگاه‌ها', group: 'infrastructure', defaultVisible: false },
  { id: 'ports', label: 'بنادر', group: 'infrastructure', defaultVisible: false },
  { id: 'industry', label: 'صنعت', group: 'infrastructure', defaultVisible: false },
  { id: 'buildings', label: 'ساختمان‌ها', group: 'infrastructure', defaultVisible: false },
  { id: 'resources', label: 'منابع', group: 'infrastructure', defaultVisible: false },
  { id: 'military', label: 'نظامی', group: 'infrastructure', defaultVisible: false },
  { id: 'cities', label: 'شهرها', group: 'geography', defaultVisible: true },
  { id: 'capitals', label: 'پایتخت‌ها', group: 'geography', defaultVisible: true },
  { id: 'population', label: 'جمعیت', group: 'society', defaultVisible: false },
  { id: 'economy', label: 'اقتصاد', group: 'society', defaultVisible: false },
  { id: 'strategic', label: 'ارزش راهبردی', group: 'society', defaultVisible: false },
  { id: 'weather', label: 'آب‌وهوا', group: 'society', defaultVisible: false },
  { id: 'intelligence', label: 'اطلاعات', group: 'society', defaultVisible: false },
  { id: 'labels', label: 'برچسب‌ها', group: 'base', defaultVisible: true }
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

// ———————————————— exclusive surface layers ————————————————

/**
 * Mutually-exclusive layer groups — a PRESENTATION policy, but owned by the
 * layer registry (core, data-driven) and enforced in the LAYER STATE, not by
 * hiding UI. Each group is one "surface mode": the members color the same
 * pixels, so showing two of them at once would blend unrelated colorings
 * into noise. Enabling one member automatically disables the others.
 *
 * Extensible: a future exclusive pair (e.g. two weather renderings) is one
 * new array here — every toggle path (commands, saves, UI) follows without
 * further changes. The layer DATA (biome/elevation/terrain per cell) is
 * untouched by this: it stays complete in the map model for composable
 * future uses; only the surface coloring is exclusive.
 */
export const EXCLUSIVE_LAYER_GROUPS: readonly (readonly MapLayerId[])[] = [
  ['biomes', 'terrain']
];

/**
 * Next visibility record after toggling `layer` to `visible`. When the
 * toggled layer joins an exclusive group, the other group members are
 * switched off in the SAME record (one atomic state change). Disabling a
 * layer never re-enables anything.
 *
 * Pure function — the caller owns the slice mutation and event emission.
 */
export function applyLayerToggle(
  visibility: Readonly<Record<MapLayerId, boolean>>,
  layer: MapLayerId,
  visible: boolean
): Record<MapLayerId, boolean> {
  const next: Record<MapLayerId, boolean> = { ...visibility, [layer]: visible };
  if (!visible) return next;
  for (const group of EXCLUSIVE_LAYER_GROUPS) {
    if (!(group as readonly string[]).includes(layer)) continue;
    for (const other of group) {
      if (other !== layer) next[other] = false;
    }
  }
  return next;
}

/**
 * Repairs IMPOSSIBLE saved/hand-made states in place (e.g. two exclusive
 * members both on — allowed by older versions): per group only the FIRST
 * member survives (deterministic, registry order defines priority).
 * @returns the number of layers flipped off.
 */
export function normalizeLayerVisibility(visibility: Record<MapLayerId, boolean>): number {
  let changed = 0;
  for (const group of EXCLUSIVE_LAYER_GROUPS) {
    let firstOn: MapLayerId | null = null;
    for (const member of group) {
      if (visibility[member] !== true) continue;
      if (firstOn === null) {
        firstOn = member;
        continue;
      }
      visibility[member] = false;
      changed++;
    }
  }
  return changed;
}
