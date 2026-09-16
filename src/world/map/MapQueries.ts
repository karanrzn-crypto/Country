/**
 * Pure geometric queries over the strategic map: point-in-polygon, picking
 * with layer priority, distance helpers and camera clamping.
 *
 * These are the ONLY selection semantics the game uses — the renderer and
 * the command handlers both call into here, so picking behaves identically
 * headless and on screen. No Three.js.
 */

import type { MapPoint, MapBounds, StrategicMapModel, MapRing } from './MapTypes';

export interface PickResult {
  readonly cityId: string | null;
  readonly provinceId: string | null;
  readonly countryId: string | null;
}

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
 * Resolves the top-most entity at a world position.
 * Priority: city (within pick radius) → province → country.
 * Ocean / unclaimed positions return all-null.
 */
export function pickAt(model: StrategicMapModel, point: MapPoint, pickRadius: number): PickResult {
  let cityId: string | null = null;
  let bestCityDistance = pickRadius;
  for (const city of Object.values(model.cities)) {
    const d = Math.hypot(city.position.x - point.x, city.position.z - point.z);
    if (d <= bestCityDistance) {
      bestCityDistance = d;
      cityId = city.id;
    }
  }

  if (cityId !== null) {
    const city = model.cities[cityId];
    return { cityId, provinceId: city.provinceId, countryId: city.countryId };
  }

  // Deep-inside countries are checked first so that enclaved shapes resolve
  // to their true owner; ordering by label point is a cheap heuristic that
  // breaks ties consistently.
  let provinceId: string | null = null;
  let countryId: string | null = null;
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
  return { cityId: null, provinceId, countryId };
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
