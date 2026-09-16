/**
 * Pure geometric queries over the strategic map: point-in-polygon, picking
 * with layer priority, distance helpers and camera clamping.
 *
 * These are the ONLY selection semantics the game uses — the renderer and
 * the command handlers both call into here, so picking behaves identically
 * headless and on screen. No Three.js.
 */

import type { MapPoint, MapBounds, StrategicMapModel, MapRing } from './MapTypes';
import { gridCellKey } from './MapTypes';

/**
 * WHICH feature classes a pick/hover may resolve. The caller derives these
 * from the CURRENT layer visibility — a hidden layer is never clickable
 * (you select what you can see). Pure data, decided outside this module.
 */
export interface PickEligibility {
  readonly grid: boolean;
  readonly rivers: boolean;
  readonly lakes: boolean;
  /** Site markers (resources/ports/industry/military). */
  readonly sites: boolean;
  /** Building markers (city facilities). */
  readonly buildings: boolean;
}

export const NO_FEATURES: PickEligibility = {
  grid: false,
  rivers: false,
  lakes: false,
  sites: false,
  buildings: false
};

export interface PickResult {
  readonly cityId: string | null;
  readonly provinceId: string | null;
  readonly countryId: string | null;
  // —— Part 3.5 feature picking (shared interaction system) ——
  /** Canonical grid-cell key `countryId#gridId`, null when none. */
  readonly gridCellKey: string | null;
  /** Cell index under the point (−1 outside the map); the grid address. */
  readonly cellIndex: number;
  readonly riverId: string | null;
  readonly lakeId: string | null;
  /** Site (mine/oil/farm/factory/port/base/airbase) under the point. */
  readonly siteId: string | null;
  readonly buildingId: string | null;
}

export const EMPTY_PICK: PickResult = {
  cityId: null,
  provinceId: null,
  countryId: null,
  gridCellKey: null,
  cellIndex: -1,
  riverId: null,
  lakeId: null,
  siteId: null,
  buildingId: null
};

/**
 * Ray-casting point-in-polygon with a small on-boundary tolerance.
 * Works for any simple (or vertex-touching) ring; rings here are closed
 * implicitly (last point connects back to the first).
 */
export function pointInRing(point: MapPoint, ring: readonly MapPoint[], epsilon = 1e-7): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = ring[i];
    const b = ring[j];
    // On-segment check (boundary counts as inside).
    const cross = (b.x - a.x) * (point.z - a.z) - (b.z - a.z) * (point.x - a.x);
    if (Math.abs(cross) <= epsilon * Math.max(1, Math.hypot(b.x - a.x, b.z - a.z))) {
      const withinX = point.x >= Math.min(a.x, b.x) - epsilon && point.x <= Math.max(a.x, b.x) + epsilon;
      const withinZ = point.z >= Math.min(a.z, b.z) - epsilon && point.z <= Math.max(a.z, b.z) + epsilon;
      if (withinX && withinZ) return true;
    }
    const intersects =
      a.z > point.z !== b.z > point.z &&
      point.x < ((b.x - a.x) * (point.z - a.z)) / (b.z - a.z) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function distancePointToSegment(point: MapPoint, a: MapPoint, b: MapPoint): number {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const lengthSquared = abx * abx + abz * abz;
  if (lengthSquared < 1e-12) return Math.hypot(point.x - a.x, point.z - a.z);
  let t = ((point.x - a.x) * abx + (point.z - a.z) * abz) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(point.x - (a.x + t * abx), point.z - (a.z + t * abz));
}

export function distanceToRing(point: MapPoint, ring: readonly MapPoint[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const d = distancePointToSegment(point, ring[j], ring[i]);
    if (d < best) best = d;
  }
  return best;
}

/**
 * True when `point` is inside the ring by at least `margin` (used to keep
 * city markers comfortably inside their country instead of hugging borders).
 */
export function pointInsideWithMargin(point: MapPoint, ring: MapRing, margin: number): boolean {
  return pointInRing(point, ring.points) && distanceToRing(point, ring.points) >= margin;
}

/**
 * Nearest cell index for a world position (−1 outside the map grid).
 * Bounds are exact (0..columns·cellSize) by generator contract.
 */
export function cellIndexAtWorld(
  point: MapPoint,
  columns: number,
  rows: number,
  cellSize: number
): number {
  const fx = point.x / cellSize;
  const fz = point.z / cellSize;
  if (fx < 0 || fz < 0 || fx >= columns || fz >= rows) return -1;
  return Math.floor(fz) * columns + Math.floor(fx);
}

/**
 * Canonical `countryId#gridId` key of a cell, or null for ocean/unknown
 * cells. Lives HERE (not in MapGeography) so the whole pick/hover contract
 * stays importable without enrichments — MapQueries stays a leaf query
 * module (only MapTypes beneath it).
 */
export function gridCellKeyAt(model: StrategicMapModel, cellIndex: number): string | null {
  if (cellIndex < 0 || cellIndex >= model.features.gridIds.length) return null;
  const owner = model.features.cellOwner[cellIndex];
  if (owner < 0) return null;
  const gridId = model.features.gridIds[cellIndex];
  if (gridId === null) return null;
  const countryId = model.countryOrder[owner];
  if (countryId === undefined) return null;
  return gridCellKey(countryId, gridId);
}

/**
 * Resolves the top-most entity at a world position — THE shared map
 * interaction semantics (click AND hover both land here).
 *
 * Priority (top-most visible feature wins):
 *   city → site → building → river → lake → grid cell → province → country
 *
 * Feature classes NOT enabled in `eligibility` are skipped entirely, so a
 * hidden layer is never selectable and toggling a layer can never invalidate
 * the hierarchy beneath it. Ocean / unclaimed positions return all-null.
 */
export function pickAt(
  model: StrategicMapModel,
  point: MapPoint,
  options: {
    readonly pickRadius: number;
    /** Extra cursor tolerance for thin river polylines (world units). */
    readonly riverPickDistance: number;
    readonly columns: number;
    readonly rows: number;
    readonly cellSize: number;
    readonly eligibility: PickEligibility;
  }
): PickResult {
  const cellIndex = cellIndexAtWorld(point, options.columns, options.rows, options.cellSize);

  // —— 1-3. point features: KIND priority first (city > site > building),
  // then nearest distance — markers sharing a position with a city resolve
  // to the city (its info block lists the port/airport anyway) ——
  const KIND_CITY = 0;
  const KIND_SITE = 1;
  const KIND_BUILDING = 2;
  let featureId: string | null = null;
  let featureRank = Number.POSITIVE_INFINITY;
  let bestDistance = options.pickRadius;
  for (const city of Object.values(model.cities)) {
    const d = Math.hypot(city.position.x - point.x, city.position.z - point.z);
    if (d <= bestDistance && KIND_CITY <= featureRank) {
      bestDistance = d;
      featureId = city.id;
      featureRank = KIND_CITY;
    }
  }
  if (options.eligibility.sites) {
    for (const site of model.features.sites) {
      const d = Math.hypot(site.position.x - point.x, site.position.z - point.z);
      if (d <= bestDistance && KIND_SITE < featureRank) {
        bestDistance = d;
        featureId = site.id;
        featureRank = KIND_SITE;
      }
    }
  }
  if (options.eligibility.buildings) {
    for (const building of model.features.buildings) {
      const d = Math.hypot(building.position.x - point.x, building.position.z - point.z);
      if (d <= bestDistance && KIND_BUILDING < featureRank) {
        bestDistance = d;
        featureId = building.id;
        featureRank = KIND_BUILDING;
      }
    }
  }
  const siteId = featureRank === KIND_SITE ? (featureId as string) : null;
  const buildingId = featureRank === KIND_BUILDING ? (featureId as string) : null;

  let cityId: string | null = null;
  let provinceId: string | null = null;
  let countryId: string | null = null;
  if (featureRank === KIND_CITY && featureId !== null) {
    cityId = featureId;
    const city = model.cities[cityId];
    provinceId = city.provinceId;
    countryId = city.countryId;
  }

  // —— 4. rivers (thin polylines get their own tolerance) ——
  let riverId: string | null = null;
  if (options.eligibility.rivers) {
    let bestRiver = options.riverPickDistance;
    for (const river of model.features.rivers) {
      let best = Number.POSITIVE_INFINITY;
      for (let i = 1; i < river.polyline.length && best > 0; i++) {
        const d = distancePointToSegment(point, river.polyline[i - 1], river.polyline[i]);
        if (d < best) best = d;
      }
      if (best <= bestRiver) {
        bestRiver = best;
        riverId = river.id;
      }
    }
  }

  // —— 5. lakes ——
  let lakeId: string | null = null;
  if (options.eligibility.lakes && cellIndex >= 0) {
    for (const lake of model.features.lakes) {
      if (lake.cells.includes(cellIndex)) {
        lakeId = lake.id;
        break;
      }
    }
  }

  // —— 6. grid cell (only where a country owns the cell) ——
  const gridCellKey =
    options.eligibility.grid && cellIndex >= 0 ? gridCellKeyAt(model, cellIndex) : null;

  // —— 7-8. province / country rings (never resolved when a city won) ——
  if (cityId === null) {
    for (const countryIdIter of model.countryOrder) {
      const country = model.countries[countryIdIter];
      if (pointInRing(point, country.ring.points)) {
        countryId = country.id;
        break;
      }
    }
    if (countryId !== null) {
      for (const provinceIdCandidate of model.countries[countryId].provinceIds) {
        const province = model.provinces[provinceIdCandidate];
        if (pointInRing(point, province.ring.points)) {
          provinceId = province.id;
          break;
        }
      }
    }
  }

  return { cityId, provinceId, countryId, gridCellKey, cellIndex, riverId, lakeId, siteId, buildingId };
}

/**
 * Lightweight hover resolution: same feature priority as pickAt, but the
 * province/country context comes from the O(1) cell partitions instead of
 * ring ray-casting — safe to run on every pointer move. Returns null-shaped
 * results (not undefined) so callers can branch on fields directly.
 */
export function hoverAt(
  model: StrategicMapModel,
  point: MapPoint,
  options: {
    readonly pickRadius: number;
    readonly riverPickDistance: number;
    readonly columns: number;
    readonly rows: number;
    readonly cellSize: number;
    readonly eligibility: PickEligibility;
  }
): PickResult {
  const cellIndex = cellIndexAtWorld(point, options.columns, options.rows, options.cellSize);

  let cityId: string | null = null;
  let bestDistance = options.pickRadius;
  for (const city of Object.values(model.cities)) {
    const d = Math.hypot(city.position.x - point.x, city.position.z - point.z);
    if (d <= bestDistance) {
      bestDistance = d;
      cityId = city.id;
    }
  }

  let siteId: string | null = null;
  if (options.eligibility.sites) {
    let best = options.pickRadius;
    for (const site of model.features.sites) {
      const d = Math.hypot(site.position.x - point.x, site.position.z - point.z);
      if (d <= best) {
        best = d;
        siteId = site.id;
      }
    }
  }

  let riverId: string | null = null;
  if (options.eligibility.rivers) {
    let bestRiver = options.riverPickDistance;
    for (const river of model.features.rivers) {
      let best = Number.POSITIVE_INFINITY;
      for (let i = 1; i < river.polyline.length && best > 0; i++) {
        const d = distancePointToSegment(point, river.polyline[i - 1], river.polyline[i]);
        if (d < best) best = d;
      }
      if (best <= bestRiver) {
        bestRiver = best;
        riverId = river.id;
      }
    }
  }

  let lakeId: string | null = null;
  if (options.eligibility.lakes && cellIndex >= 0) {
    for (const lake of model.features.lakes) {
      if (lake.cells.includes(cellIndex)) {
        lakeId = lake.id;
        break;
      }
    }
  }

  const gridCellKey =
    options.eligibility.grid && cellIndex >= 0 ? gridCellKeyAt(model, cellIndex) : null;

  // Province/country context from the dense partitions — O(1), no rings.
  let provinceId: string | null = null;
  let countryId: string | null = null;
  if (cityId !== null) {
    provinceId = model.cities[cityId].provinceId;
    countryId = model.cities[cityId].countryId;
  } else if (cellIndex >= 0) {
    provinceId = model.features.provinceOf[cellIndex] ?? null;
    const owner = model.features.cellOwner[cellIndex];
    countryId = owner >= 0 ? model.countryOrder[owner] ?? null : null;
  }

  return { cityId, provinceId, countryId, gridCellKey, cellIndex, riverId, lakeId, siteId, buildingId: null };
}

/** Resolves which country (if any) contains a world position. */
export function countryAt(model: StrategicMapModel, point: MapPoint): string | null {
  for (const countryId of model.countryOrder) {
    if (pointInRing(point, model.countries[countryId].ring.points)) return countryId;
  }
  return null;
}

export function provinceAt(model: StrategicMapModel, point: MapPoint): string | null {
  const countryId = countryAt(model, point);
  if (countryId === null) return null;
  for (const provinceId of model.countries[countryId].provinceIds) {
    if (pointInRing(point, model.provinces[provinceId].ring.points)) return provinceId;
  }
  return null;
}

export interface CameraView {
  readonly x: number;
  readonly z: number;
  readonly viewHeight: number; // visible world height (smaller = closer zoom)
  readonly aspect: number; // viewport width / height
}

/**
 * Clamps a camera view so it can never wander off the map: zoom is bounded
 * and the center is constrained so the viewport always overlaps the map.
 *
 * Progressive re-centering (Part 2): the more zoomed-out the view is, the
 * stronger the center is pulled toward the map center — fully zoomed out the
 * map is always framed, mid-zoom the cursor keeps full control. This removes
 * the classic "zoom out flings the map into a corner" failure while keeping
 * cursor-anchored zooming where it matters.
 *
 * Pure function — used by the camera system, command handlers and tests.
 */
export function clampCamera(view: CameraView, bounds: MapBounds, minViewHeight: number, maxViewHeight: number): CameraView {
  const viewHeight = Math.min(maxViewHeight, Math.max(minViewHeight, view.viewHeight));
  const viewWidth = viewHeight * view.aspect;
  const mapWidth = bounds.maxX - bounds.minX;
  const mapHeight = bounds.maxZ - bounds.minZ;
  const marginX = Math.max(0, viewWidth * 0.5 - mapWidth * 0.1);
  const marginZ = Math.max(0, viewHeight * 0.5 - mapHeight * 0.1);
  const minX = bounds.minX - marginX;
  const maxX = bounds.maxX + marginX;
  const minZ = bounds.minZ - marginZ;
  const maxZ = bounds.maxZ + marginZ;
  let x = viewWidth >= mapWidth + marginX * 2 ? (bounds.minX + bounds.maxX) / 2 : Math.min(maxX, Math.max(minX, view.x));
  let z = viewHeight >= mapHeight + marginZ * 2 ? (bounds.minZ + bounds.maxZ) / 2 : Math.min(maxZ, Math.max(minZ, view.z));

  // —— progressive re-centering ——
  const zoomOut = Math.min(1, Math.max(0, (viewHeight - minViewHeight) / Math.max(1e-6, maxViewHeight - minViewHeight)));
  const pull = smoothstep(0.55, 1, zoomOut);
  if (pull > 0) {
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerZ = (bounds.minZ + bounds.maxZ) / 2;
    x += (centerX - x) * pull;
    z += (centerZ - z) * pull;
  }
  return { x, z, viewHeight, aspect: view.aspect };
}

/** Hermite smoothstep between edges (0 below e0, 1 above e1). */
function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
