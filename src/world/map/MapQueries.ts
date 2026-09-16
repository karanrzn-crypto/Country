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
  /**
   * City markers (optional for backward compatibility: undefined = visible).
   * A hidden layer is never selectable — the caller derives this from the
   * layer visibility ('cities' / 'capitals' flags).
   */
  readonly cities?: boolean;
  /** Capital markers (optional: undefined = visible). */
  readonly capitals?: boolean;
}

export const NO_FEATURES: PickEligibility = {
  grid: false,
  rivers: false,
  lakes: false,
  sites: false,
  buildings: false,
  cities: false,
  capitals: false
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
 *
 * ⚠️ ARITHMETIC approximation only — the drawn grid uses the JITTERED
 * lattice, so this must never decide a selection on its own. Use
 * `cellIndexAtPoint` (below) for every pick/hover path.
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
 * The 4 JITTERED lattice corners of a cell (NW, NE, SE, SW) — the exact
 * polygon the grid layer draws and the selection overlays highlight. Pick,
 * hover and renderer MUST all derive cell geometry from here (or from the
 * identical `cellCornerPoints` helper) so a click inside a DRAWN cell can
 * never resolve to a neighbor and the highlight always covers the whole
 * visual cell. Single geometry source — no transform/scale/offset drift.
 */
export function latticeQuad(
  latticePoints: readonly MapPoint[],
  cellIndex: number,
  columns: number
): readonly [MapPoint, MapPoint, MapPoint, MapPoint] {
  const cx = cellIndex % columns;
  const cz = Math.floor(cellIndex / columns);
  const stride = columns + 1;
  const nw = cz * stride + cx;
  return [
    latticePoints[nw],
    latticePoints[nw + 1],
    latticePoints[nw + stride + 1],
    latticePoints[nw + stride]
  ];
}

// ———————— exact VISIBLE cell polygon (display == pick == highlight) ————————

/** Signed side of `p` relative to the directed line a→b (scaled by |ab|). */
function sideOf(a: MapPoint, b: MapPoint, p: MapPoint): number {
  return (b.x - a.x) * (p.z - a.z) - (b.z - a.z) * (p.x - a.x);
}

/** Proper-or-touching segment intersection test (orientation signs). */
function segmentsCross(a1: MapPoint, a2: MapPoint, b1: MapPoint, b2: MapPoint): boolean {
  const d1 = sideOf(b1, b2, a1);
  const d2 = sideOf(b1, b2, a2);
  const d3 = sideOf(a1, a2, b1);
  const d4 = sideOf(a1, a2, b2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Intersection of segment prev→cur with the INFINITE line a→b. */
function lineIntersectionPoint(prev: MapPoint, cur: MapPoint, a: MapPoint, b: MapPoint): MapPoint {
  const sPrev = sideOf(a, b, prev);
  const sCur = sideOf(a, b, cur);
  const denominator = sPrev - sCur;
  const t = Math.abs(denominator) < 1e-12 ? 0 : sPrev / denominator;
  return { x: prev.x + t * (cur.x - prev.x), z: prev.z + t * (cur.z - prev.z) };
}

const CLIP_EPSILON = 1e-7;

/**
 * Sutherland–Hodgman clip of the country ring (concave subject) against the
 * cell quad's four half-planes (convex clipper — the quad is always the
 * clipper, so the classic concave-subject restriction does not apply to the
 * OUTPUT shape we need: ring ∩ quad). The quad centroid orients each
 * half-plane, making the clip winding-independent.
 */
function clipRingByQuad(ring: readonly MapPoint[], quad: readonly MapPoint[]): MapPoint[] {
  const centerX = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
  const centerZ = (quad[0].z + quad[1].z + quad[2].z + quad[3].z) / 4;
  let output: readonly MapPoint[] = ring;
  for (let edgeIndex = 0; edgeIndex < 4 && output.length > 0; edgeIndex++) {
    const a = quad[edgeIndex];
    const b = quad[(edgeIndex + 1) % 4];
    const orientation = sideOf(a, b, { x: centerX, z: centerZ }) >= 0 ? 1 : -1;
    const input = output;
    const clipped: MapPoint[] = [];
    for (let i = 0; i < input.length; i++) {
      const current = input[i];
      const previous = input[(i + input.length - 1) % input.length];
      const currentIn = sideOf(a, b, current) * orientation >= -CLIP_EPSILON;
      const previousIn = sideOf(a, b, previous) * orientation >= -CLIP_EPSILON;
      if (currentIn !== previousIn) {
        clipped.push(lineIntersectionPoint(previous, current, a, b));
      }
      if (currentIn) clipped.push(current);
    }
    output = clipped;
  }
  // Drop near-duplicate consecutive vertices (boundary epsilon artifacts)
  // so triangulation and LineLoop never see degenerate spans.
  const deduped: MapPoint[] = [];
  for (const point of output) {
    const last = deduped[deduped.length - 1];
    if (last === undefined || Math.hypot(point.x - last.x, point.z - last.z) > 1e-6) {
      deduped.push(point);
    }
  }
  if (deduped.length > 2) {
    const first = deduped[0];
    const last = deduped[deduped.length - 1];
    if (Math.hypot(first.x - last.x, first.z - last.z) <= 1e-6) deduped.pop();
  }
  return deduped;
}

/**
 * The polygon of a grid cell that is actually VISIBLE on the map — the
 * jittered lattice quad clipped to the owner country's ring. Interior cells
 * pass through EXACTLY unchanged (fast path); border cells are cut by the
 * fractal border, and the result is the precise intersection polygon.
 *
 * THE single geometry source for grid selection: what the grid layer draws,
 * what picking resolves (see `gridCellKeyAt` with a point) and what the
 * selection highlight covers are all THIS polygon — never an approximation.
 */
export function visibleCellPolygon(
  model: StrategicMapModel,
  cellIndex: number,
  columns: number
): { readonly points: readonly MapPoint[]; readonly clipped: boolean } {
  const quad = latticeQuad(model.lattice, cellIndex, columns);
  const owner = cellIndex >= 0 && cellIndex < model.features.cellOwner.length
    ? model.features.cellOwner[cellIndex]
    : -1;
  if (owner < 0) return { points: quad, clipped: false };
  const country = model.countries[model.countryOrder[owner]];
  if (country === undefined) return { points: quad, clipped: false };
  const ring = country.ring.points;

  // Fast path: the quad lies fully inside the ring and the ring never
  // enters it — the displayed cell IS the quad (the common interior case).
  let fullyInside = true;
  for (const corner of quad) {
    if (!pointInRing(corner, ring)) {
      fullyInside = false;
      break;
    }
  }
  if (fullyInside) {
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (const corner of quad) {
      minX = Math.min(minX, corner.x);
      maxX = Math.max(maxX, corner.x);
      minZ = Math.min(minZ, corner.z);
      maxZ = Math.max(maxZ, corner.z);
    }
    const inBox = (point: MapPoint): boolean =>
      point.x >= minX && point.x <= maxX && point.z >= minZ && point.z <= maxZ;
    fastPath: for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      if (!inBox(a)) continue;
      if (pointInRing(a, quad)) {
        fullyInside = false;
        break;
      }
      const b = ring[(i + 1) % ring.length];
      if (!inBox(b)) continue;
      for (let edgeIndex = 0; edgeIndex < 4; edgeIndex++) {
        if (segmentsCross(a, b, quad[edgeIndex], quad[(edgeIndex + 1) % 4])) {
          fullyInside = false;
          break fastPath;
        }
      }
    }
  }
  if (fullyInside) return { points: quad, clipped: false };

  const clipped = clipRingByQuad(ring, quad);
  if (clipped.length < 3) {
    // Degenerate intersection (numerical edge / pathological ring) — fall
    // back to the full quad so a selection can never render as nothing.
    return { points: quad, clipped: false };
  }
  return { points: clipped, clipped: true };
}

/**
 * Polygon-ACCURATE cell lookup: returns the cell whose JITTERED quad
 * actually contains the point — the same geometry the grid layer draws.
 *
 * The lattice displaces interior points by up to (strictly less than) half
 * a cell, so the containing quad always lies within the 3×3 neighborhood of
 * the arithmetic cell: we test those ≤9 quads (cheap 4-gon ray casts) and
 * fall back to the arithmetic index only on a degenerate numerical edge.
 * This is what makes "click a cell → the WHOLE cell highlights" true by
 * construction — picking and drawing share one coordinate system.
 */
export function cellIndexAtPoint(
  model: StrategicMapModel,
  point: MapPoint,
  columns: number,
  rows: number,
  cellSize: number
): number {
  const seed = cellIndexAtWorld(point, columns, rows, cellSize);
  if (seed < 0) return -1;
  const cz = Math.floor(seed / columns);
  const cx = seed - cz * columns;
  for (let dz = -1; dz <= 1; dz++) {
    const nz = cz + dz;
    if (nz < 0 || nz >= rows) continue;
    for (let dx = -1; dx <= 1; dx++) {
      const nx = cx + dx;
      if (nx < 0 || nx >= columns) continue;
      const candidate = nz * columns + nx;
      if (pointInRing(point, latticeQuad(model.lattice, candidate, columns))) {
        return candidate;
      }
    }
  }
  return seed;
}

/**
 * Click tolerance for the owner-ring check (world units): points ON the
 * drawn border line belong to the cell — the border stroke is painted on
 * the ring, and a click there must select the cell, not fall through.
 */
const GRID_PICK_BORDER_TOLERANCE = 0.05;

/**
 * Canonical `countryId#gridId` key of a cell, or null for ocean/unknown
 * cells. Lives HERE (not in MapGeography) so the whole pick/hover contract
 * stays importable without enrichments — MapQueries stays a leaf query
 * module (only MapTypes beneath it).
 *
 * When `point` is passed, the key is only returned for points that are
 * INSIDE (or on the border stroke of) the owner country's ring — the
 * clickable polygon equals the DISPLAYED polygon (a border cell's visible
 * shape is cut by the country border, so a click on the cut-away part must
 * not select the cell).
 */
export function gridCellKeyAt(
  model: StrategicMapModel,
  cellIndex: number,
  point?: MapPoint
): string | null {
  if (cellIndex < 0 || cellIndex >= model.features.gridIds.length) return null;
  const owner = model.features.cellOwner[cellIndex];
  if (owner < 0) return null;
  const gridId = model.features.gridIds[cellIndex];
  if (gridId === null) return null;
  const countryId = model.countryOrder[owner];
  if (countryId === undefined) return null;
  if (point !== undefined) {
    const country = model.countries[countryId];
    if (
      country === undefined ||
      (!pointInRing(point, country.ring.points, GRID_PICK_BORDER_TOLERANCE) &&
        distanceToRing(point, country.ring.points) > GRID_PICK_BORDER_TOLERANCE)
    ) {
      return null;
    }
  }
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
 *
 * The grid cell is resolved against the JITTERED lattice (the drawn
 * geometry) — a click anywhere inside a drawn cell selects that whole cell.
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
  const cellIndex = cellIndexAtPoint(model, point, options.columns, options.rows, options.cellSize);

  // —— 1-3. point features: KIND priority first (city > site > building),
  // then nearest distance — markers sharing a position with a city resolve
  // to the city (its info block lists the port/airport anyway) ——
  const KIND_CITY = 0;
  const KIND_SITE = 1;
  const KIND_BUILDING = 2;
  const citiesAllowed = options.eligibility.cities !== false;
  const capitalsAllowed = options.eligibility.capitals !== false;
  let featureId: string | null = null;
  let featureRank = Number.POSITIVE_INFINITY;
  let bestDistance = options.pickRadius;
  for (const city of Object.values(model.cities)) {
    // A hidden layer is never selectable (you select what you can see).
    if (city.isCapital ? !capitalsAllowed : !citiesAllowed) continue;
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

  // —— 6. grid cell (only where a country owns the cell AND the point is
  //       inside the owner ring — pick polygon == displayed polygon) ——
  const gridCellKey =
    options.eligibility.grid && cellIndex >= 0
      ? gridCellKeyAt(model, cellIndex, point)
      : null;

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
 *
 * Uses the SAME lattice-accurate cell lookup as pickAt, so hover and click
 * can never disagree about the cell under the pointer.
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
  const cellIndex = cellIndexAtPoint(model, point, options.columns, options.rows, options.cellSize);

  let cityId: string | null = null;
  let bestDistance = options.pickRadius;
  for (const city of Object.values(model.cities)) {
    if (city.isCapital ? options.eligibility.capitals === false : options.eligibility.cities === false) {
      continue;
    }
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
    options.eligibility.grid && cellIndex >= 0
      ? gridCellKeyAt(model, cellIndex, point)
      : null;

  // Province/country context — THE SAME ring tests pickAt uses. The O(1)
  // cell partitions would disagree near province borders (the drawn rings
  // carry the border's fractal detail), and hover contradicting the click
  // target is exactly the selection inconsistency this module must prevent.
  let provinceId: string | null = null;
  let countryId: string | null = null;
  if (cityId !== null) {
    provinceId = model.cities[cityId].provinceId;
    countryId = model.cities[cityId].countryId;
  } else {
    for (const candidateCountryId of model.countryOrder) {
      if (pointInRing(point, model.countries[candidateCountryId].ring.points)) {
        countryId = candidateCountryId;
        break;
      }
    }
    if (countryId !== null) {
      for (const candidateProvinceId of model.countries[countryId].provinceIds) {
        if (pointInRing(point, model.provinces[candidateProvinceId].ring.points)) {
          provinceId = candidateProvinceId;
          break;
        }
      }
    }
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
