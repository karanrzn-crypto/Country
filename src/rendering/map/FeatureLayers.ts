import * as THREE from 'three';
import type { StrategicMapModel, MapSite, MapRiver, MapBuilding, MapPoint } from '../../world/map/MapTypes';
import { cellCornerPoints } from '../../world/map/MapFeatures';
import { visibleCellPolygon, cellIndexAtPoint } from '../../world/map/MapQueries';
import { type MapTheme } from './MapTheme';
import {
  type RGB,
  rgb,
  lerpColor,
  buildVertexElevationGrid,
  SURFACE_FILL_Y,
  SURFACE_RELIEF_AMPLITUDE
} from './MapSurface';

/**
 * FeatureLayers — Part-3 information-layer visuals EXCEPT the land surface
 * (biomes/terrain live in MapSurface.ts — the single land-surface
 * definition shared with the legends): rivers/lakes, railways,
 * sea routes, ports, industry, resources, military, population, economy.
 *
 * Performance contract (weak-hardware friendly):
 * - ONE merged geometry + ONE material per layer (a handful of draw calls
 *   total, no matter how many cells/lines/sites the map has);
 * - LAZY build: nothing is created until the layer is first toggled visible;
 * - toggling only flips `group.visible` — never rebuilds;
 * - site markers are a single InstancedMesh with per-instance colors;
 * - `invalidate()` supports cheap rebuilds (e.g. economy values change) and
 *   is the ONLY path that re-creates GPU objects.
 *
 * All data comes from the static model / game state (renderer as pure view).
 */

export type { RGB } from './MapSurface';

/**
 * One merged, vertex-colored mesh over the cell grid (2 triangles per cell).
 * `colorAt` returns null for cells the layer must skip (e.g. ocean).
 * Used by the translucent OVERLAY tints (population / economy) — the land
 * SURFACE itself (biomes/terrain) is MapSurface.SurfaceLayer.
 */
export class CellFillLayer {
  readonly group = new THREE.Group();
  private geometry: THREE.BufferGeometry | null = null;
  private material: THREE.MeshBasicMaterial | null = null;

  constructor(
    private readonly columns: number,
    private readonly opacity: number,
    private readonly colorAt: (cellIndex: number, model: StrategicMapModel) => RGB | null
  ) {}

  get isBuilt(): boolean {
    return this.geometry !== null;
  }

  /** Builds (or rebuilds after invalidate) the merged fill mesh. */
  ensureBuilt(model: StrategicMapModel): void {
    if (this.geometry !== null) return;
    const positions: number[] = [];
    const colors: number[] = [];
    const cellCount = model.features.biomes.length;
    const heights = buildVertexElevationGrid(model, this.columns);
    for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
      const color = this.colorAt(cellIndex, model);
      if (color === null) continue;
      const [nw, ne, se, sw] = cellCornerPoints(cellIndex, model.lattice, this.columns);
      // The tint FOLLOWS the surface relief (same height function as water,
      // slightly lower lift) so it can never sink below the lifted terrain
      // in biomes/terrain mode.
      const y = surfaceTopY(heights, this.columns, cellIndex) + TINT_LIFT;
      // Two triangles: NW-SW-SE and NW-SE-NE (DoubleSide — winding-free).
      for (const point of [nw, sw, se, nw, se, ne]) {
        positions.push(point.x, y, point.z);
        colors.push(color.r, color.g, color.b);
      }
    }
    if (positions.length === 0) return;
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    this.geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    this.geometry.computeBoundingSphere();
    this.material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: this.opacity,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(this.geometry, this.material);
    mesh.renderOrder = 5; // translucent tint ABOVE the surface (4), below water (6)
    this.group.add(mesh);
  }

  /** Drops GPU objects; the next ensureBuilt rebuilds from current data. */
  invalidate(): void {
    if (this.geometry === null) return;
    this.group.clear();
    this.geometry.dispose();
    this.geometry = null;
    this.material?.dispose();
    this.material = null;
  }

  dispose(): void {
    this.invalidate();
    this.group.clear();
  }
}

/** Per-cell population density from city populations with a small falloff. */
export function cellPopulationDensity(model: StrategicMapModel, columns: number): number[] {
  const cellCount = model.features.biomes.length;
  const density = new Array<number>(cellCount).fill(0);
  const rows = Math.ceil(cellCount / columns);
  const cellWidthX = (model.bounds.maxX - model.bounds.minX) / columns;
  const cellWidthZ = (model.bounds.maxZ - model.bounds.minZ) / rows;
  for (const city of Object.values(model.cities)) {
    const cx = Math.max(0, Math.min(columns - 1, Math.floor((city.position.x - model.bounds.minX) / cellWidthX)));
    const cz = Math.max(0, Math.min(rows - 1, Math.floor((city.position.z - model.bounds.minZ) / cellWidthZ)));
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        const nx = cx + dx;
        const nz = cz + dz;
        if (nx < 0 || nx >= columns || nz < 0 || nz >= rows) continue;
        const distance = Math.hypot(dx, dz);
        if (distance > 2.5) continue;
        density[nz * columns + nx] += city.population * (1 - distance / 2.5);
      }
    }
  }
  return density;
}

/** Population heat tint (built once — density is a pure function of the model). */
export function createPopulationFillLayer(columns: number, theme: MapTheme): CellFillLayer {
  const low = rgb(theme.layerColors.populationLow);
  const high = rgb(theme.layerColors.populationHigh);
  let density: number[] | null = null;
  let max = 1;
  return new CellFillLayer(columns, theme.layerColors.tintFillOpacity, (cellIndex, model) => {
    if (density === null) {
      density = cellPopulationDensity(model, columns);
      max = Math.max(...density, 1);
    }
    if (model.features.biomes[cellIndex] === 'ocean') return null;
    const value = density[cellIndex] / max;
    if (value < 0.02) return null;
    return lerpColor(low, high, Math.pow(value, 0.5));
  });
}

/**
 * Economy tint: per-country value from the LIVE country state (state.countries)
 * — when the future economy simulation mutates those values, rebuilding on
 * visibility change makes this layer follow automatically. No renderer
 * rewrite needed, no duplicated economy state.
 */
export function createEconomyFillLayer(
  columns: number,
  theme: MapTheme,
  countryShare: (countryId: string) => number
): CellFillLayer {
  const low = rgb(theme.layerColors.economyLow);
  const high = rgb(theme.layerColors.economyHigh);
  return new CellFillLayer(columns, theme.layerColors.tintFillOpacity, (cellIndex, model) => {
    const owner = model.features.cellOwner[cellIndex];
    if (owner < 0) return null; // ocean
    const countryId = model.countryOrder[owner];
    if (countryId === undefined) return null;
    return lerpColor(low, high, countryShare(countryId));
  });
}

// ———————————————————————————— line features ————————————————————————————

function lineSegmentsFromPolylines(
  polylines: readonly (readonly { x: number; z: number }[])[],
  color: RGB,
  y: number,
  yAt?: (point: { x: number; z: number }) => number
): THREE.BufferGeometry | null {
  const positions: number[] = [];
  const colors: number[] = [];
  for (const polyline of polylines) {
    for (let i = 1; i < polyline.length; i++) {
      const a = polyline[i - 1];
      const b = polyline[i];
      const yA = yAt !== undefined ? yAt(a) : y;
      const yB = yAt !== undefined ? yAt(b) : y;
      positions.push(a.x, yA, a.z, b.x, yB, b.z);
      colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
    }
  }
  if (positions.length === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

/** Terrain-following lines ride this hair above the local surface top
 *  (same max-corner convention as tints/water — never buried in relief). */
const TERRAIN_LINE_LIFT = 0.03;

/** Optional grid context that makes line features FOLLOW THE TERRAIN. */
interface LineGridContext {
  readonly columns: number;
  readonly rows: number;
  readonly cellSize: number;
}

/**
 * Line-feature layer (roads vertex-colored by class, railways, sea routes) —
 * ONE merged LineSegments per color group, built lazily, disposed as one.
 * With a grid context the vertices follow the terrain surface (roads and
 * railways stay ON the ground — and visible — in biomes/terrain relief
 * mode); without it they render on one flat plane (sea routes).
 */
export class LineFeatureLayer {
  readonly group = new THREE.Group();
  private geometries: THREE.BufferGeometry[] = [];
  private material: THREE.LineBasicMaterial | null = null;

  constructor(
    private readonly pickLines: (
      model: StrategicMapModel
    ) => readonly { color: RGB; polyline: readonly { x: number; z: number }[] }[],
    private readonly opacity: number,
    private readonly y: number,
    private readonly grid?: LineGridContext
  ) {}

  ensureBuilt(model: StrategicMapModel): void {
    if (this.geometries.length > 0) return;
    const heights = this.grid !== undefined ? buildVertexElevationGrid(model, this.grid.columns) : null;
    const grid = this.grid;
    const yAt = grid !== undefined && heights !== null
      ? (point: { x: number; z: number }): number => {
          const cellIndex = cellIndexAtPoint(model, point, grid.columns, grid.rows, grid.cellSize);
          if (cellIndex < 0) return this.y;
          return surfaceTopY(heights, grid.columns, cellIndex) + TERRAIN_LINE_LIFT;
        }
      : undefined;
    const byColor = new Map<string, { color: RGB; polylines: (readonly { x: number; z: number }[])[] }>();
    for (const line of this.pickLines(model)) {
      const key = `${line.color.r.toFixed(4)}|${line.color.g.toFixed(4)}|${line.color.b.toFixed(4)}`;
      let entry = byColor.get(key);
      if (entry === undefined) {
        entry = { color: line.color, polylines: [] };
        byColor.set(key, entry);
      }
      entry.polylines.push(line.polyline);
    }
    if (byColor.size === 0) return;
    for (const entry of byColor.values()) {
      const geometry = lineSegmentsFromPolylines(entry.polylines, entry.color, this.y, yAt);
      if (geometry === null) continue;
      this.geometries.push(geometry);
    }
    if (this.geometries.length === 0) return;
    this.material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: this.opacity,
      depthWrite: false
    });
    for (const geometry of this.geometries) {
      const segments = new THREE.LineSegments(geometry, this.material);
      segments.renderOrder = 7;
      this.group.add(segments);
    }
  }

  dispose(): void {
    this.group.clear();
    for (const geometry of this.geometries) geometry.dispose();
    this.geometries = [];
    this.material?.dispose();
    this.material = null;
  }
}

/**
 * Roads: every land transport line (highway/secondary/dirt) vertex-colored
 * by class. A visibility toggle only flips the group's `visible` flag —
 * the built mesh and the underlying map data are NEVER rebuilt or dropped,
 * so OFF = hide, ON = exactly the same roads again.
 */
export function createRoadsLayer(theme: MapTheme, grid?: LineGridContext): LineFeatureLayer {
  const colors: Record<string, RGB> = {};
  for (const [kind, hex] of Object.entries(theme.layerColors.roadColors)) {
    colors[kind] = rgb(hex);
  }
  return new LineFeatureLayer(
    (model) =>
      model.features.lines
        .filter((line) => line.kind !== 'railway' && line.kind !== 'seaRoute')
        .map((line) => ({ color: colors[line.kind] ?? colors.secondary, polyline: line.polyline })),
    theme.layerColors.roadOpacity,
    0.85,
    grid
  );
}

/** Railways: single theme color. */
export function createRailwaysLayer(theme: MapTheme, grid?: LineGridContext): LineFeatureLayer {
  const color = rgb(theme.layerColors.railwayStroke);
  return new LineFeatureLayer(
    (model) =>
      model.features.lines
        .filter((line) => line.kind === 'railway')
        .map((line) => ({ color, polyline: line.polyline })),
    theme.layerColors.railwayOpacity,
    0.87,
    grid
  );
}

/** Sea routes: light lines across the ocean. */
export function createSeaRoutesLayer(theme: MapTheme): LineFeatureLayer {
  const color = rgb(theme.layerColors.seaRouteStroke);
  return new LineFeatureLayer(
    (model) =>
      model.features.lines
        .filter((line) => line.kind === 'seaRoute')
        .map((line) => ({ color, polyline: line.polyline })),
    theme.layerColors.seaRouteOpacity,
    0.35
  );
}

// ———————————————————————————— water features ————————————————————————————

/** Small lift keeping water ON TOP of the (relief-lifted) land surface. */
const WATER_LIFT = 0.05;
/** Tint fills ride just under the water lift, above the raw surface. */
const TINT_LIFT = 0.02;
/** Grid lines: between tints and water. */
const GRID_LINE_LIFT = 0.03;
/** Selection/hover overlays: above everything visual (with depthTest off). */
const HOVER_LIFT = 0.04;
const SELECT_FILL_LIFT = 0.05;
const SELECT_OUTLINE_LIFT = 0.06;
/** A river stub reaching into a lake sits a hair ABOVE the lake surface —
 * a tiny controlled offset that kills coplanar z-fighting at the joint. */
const RIVER_OVER_LAKE_LIFT = 0.02;

/**
 * Height of the surface (terrain relief) within a cell: the land mesh's
 * height is a convex blend of the cell's four corner heights, so the MAX
 * corner dominates everywhere in the cell. Everything that must stay
 * VISIBLE on the ground (tints, grid, water) derives its height from HERE —
 * one height function, zero burial in any surface mode.
 */
export function surfaceTopY(heights: Float64Array, columns: number, cellIndex: number): number {
  const cz = Math.floor(cellIndex / columns);
  const cx = cellIndex - cz * columns;
  const stride = columns + 1;
  const maxCorner = Math.max(
    heights[cz * stride + cx],
    heights[cz * stride + cx + 1],
    heights[(cz + 1) * stride + cx + 1],
    heights[(cz + 1) * stride + cx]
  );
  return SURFACE_FILL_Y + maxCorner * SURFACE_RELIEF_AMPLITUDE;
}

/**
 * Height of the water surface for a cell: ABOVE the rendered land surface,
 * so rivers/lakes stay visible in EVERY mode and never sink into lifted
 * relief.
 */
function waterSurfaceY(heights: Float64Array, columns: number, cellIndex: number): number {
  return surfaceTopY(heights, columns, cellIndex) + WATER_LIFT;
}

/** Natural river width (world units): tapers source → mouth, grows with length. */
export function riverWidthAt(
  river: MapRiver,
  t: number,
  width: { readonly source: number; readonly perCell: number; readonly max: number }
): number {
  const mouth = Math.min(width.max, width.source + width.perCell * river.cells.length);
  const clamped = Math.max(0, Math.min(1, t));
  return Math.max(0.05, width.source + (mouth - width.source) * clamped);
}

/**
 * The spans of a river polyline that the renderer should DRAW: the river
 * is clipped where it runs THROUGH a lake so its ribbon terminates at the
 * lake boundary instead of crossing the lake surface as an artificial
 * stripe. Each run of non-lake points is extended by EXACTLY ONE lake
 * point at each end (where one exists) — the ribbon tip therefore reaches
 * ONTO the lake surface and reads as a natural inflow/outflow connection.
 *
 * Pure function (unit-testable): run interiors are strictly non-lake, run
 * boundaries (when truncated) are lake cells, and every non-lake index is
 * covered exactly once — Source/Mouth/tributaries/flow direction/width
 * variation are untouched (§F).
 */
export function riverDrawnRuns(
  river: MapRiver,
  lakeCells: ReadonlySet<number>
): readonly (readonly [number, number])[] {
  const count = river.cells.length;
  const runs: (readonly [number, number])[] = [];
  let index = 0;
  while (index < count) {
    if (lakeCells.has(river.cells[index])) {
      index++;
      continue;
    }
    let end = index;
    while (end + 1 < count && !lakeCells.has(river.cells[end + 1])) end++;
    // Extend each end by one lake-boundary point so the ribbon visually
    // connects to the lake surface (never more than one — no crossing).
    const start = index > 0 ? index - 1 : index;
    const stop = end < count - 1 ? end + 1 : end;
    runs.push([start, stop] as const);
    index = end + 1;
  }
  return runs;
}

/**
 * ONE merged ribbon mesh for ALL rivers — a triangle strip along each
 * river polyline with a natural, tapering width (narrow at the source,
 * widest at the mouth) and smooth per-point normals, so rivers read as
 * flowing water instead of artificial 1-px lines. Ribbon height follows
 * the terrain surface (water stays on the ground in every mode).
 *
 * Rivers are clipped at LAKE boundaries (riverDrawnRuns): inside a lake
 * the water is the lake surface — the river ribbon stops at the shore and
 * reconnects on the other side, with a hair-thin lift over the lake
 * surface at the joints so no coplanar z-fighting can occur.
 */
export function buildRiverRibbons(
  model: StrategicMapModel,
  columns: number,
  theme: MapTheme
): THREE.BufferGeometry | null {
  if (model.features.rivers.length === 0) return null;
  const heights = buildVertexElevationGrid(model, columns);
  const width = theme.layerColors.riverWidth;
  const lakeCells = new Set<number>();
  for (const lake of model.features.lakes) {
    for (const cellIndex of lake.cells) lakeCells.add(cellIndex);
  }
  const positions: number[] = [];
  for (const river of model.features.rivers) {
    const polyline = river.polyline;
    if (polyline.length < 2) continue;
    for (const [startIndex, endIndex] of riverDrawnRuns(river, lakeCells)) {
      if (endIndex - startIndex < 1) continue;
      // Per-point frame: tangent (central difference, clamped to the run)
      // → perpendicular normal.
      const left: { x: number; y: number; z: number }[] = [];
      const right: { x: number; y: number; z: number }[] = [];
      for (let i = startIndex; i <= endIndex; i++) {
        const previous = polyline[Math.max(startIndex, i - 1)];
        const next = polyline[Math.min(endIndex, i + 1)];
        const tx = next.x - previous.x;
        const tz = next.z - previous.z;
        const length = Math.hypot(tx, tz) || 1;
        const nx = -tz / length;
        const nz = tx / length;
        const halfWidth = riverWidthAt(river, i / (polyline.length - 1), width) / 2;
        const point = polyline[i];
        const inLake = lakeCells.has(river.cells[i]);
        const y =
          waterSurfaceY(heights, columns, river.cells[i]) + (inLake ? RIVER_OVER_LAKE_LIFT : 0);
        left.push({ x: point.x + nx * halfWidth, y, z: point.z + nz * halfWidth });
        right.push({ x: point.x - nx * halfWidth, y, z: point.z - nz * halfWidth });
      }
      for (let i = 1; i < left.length; i++) {
        const li = left[i];
        const ri = right[i];
        const liPrev = left[i - 1];
        const riPrev = right[i - 1];
        // Two triangles per segment (DoubleSide — winding-free).
        for (const vertex of [liPrev, riPrev, ri, liPrev, ri, li]) {
          positions.push(vertex.x, vertex.y, vertex.z);
        }
      }
    }
  }
  if (positions.length === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Rivers: ONE merged natural ribbon mesh (see buildRiverRibbons).
 * Lakes are a SEPARATE user-facing layer — see LakeLayer below.
 */
export class RiverLayer {
  readonly group = new THREE.Group();
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private built = false;

  constructor(
    private readonly columns: number,
    private readonly theme: MapTheme
  ) {}

  ensureBuilt(model: StrategicMapModel): void {
    if (this.built) return;
    this.built = true;
    const riverColor = rgb(this.theme.layerColors.riverStroke);
    const riverGeometry = buildRiverRibbons(model, this.columns, this.theme);
    if (riverGeometry !== null) {
      this.geometries.push(riverGeometry);
      const material = new THREE.MeshBasicMaterial({
        color: new THREE.Color(riverColor.r, riverColor.g, riverColor.b),
        transparent: true,
        opacity: this.theme.layerColors.riverOpacity,
        depthWrite: false,
        side: THREE.DoubleSide
      });
      this.materials.push(material);
      const mesh = new THREE.Mesh(riverGeometry, material);
      // Explicit water stacking (Terrain → Lake → River): lakes stay at 6,
      // rivers draw right after them — no coplanar tie, no z-fighting.
      mesh.renderOrder = 6.5;
      this.group.add(mesh);
    }
  }

  dispose(): void {
    this.group.clear();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.geometries.length = 0;
    this.materials.length = 0;
    this.built = false;
  }
}

/**
 * Lakes / standing water: ONE merged mesh of filled cell quads per lake
 * (the same shared lattice geometry), lifted exactly like rivers so they
 * always sit ON the surface. Data source: model.features.lakes (MapLake).
 */
export class LakeLayer {
  readonly group = new THREE.Group();
  private geometry: THREE.BufferGeometry | null = null;
  private material: THREE.MeshBasicMaterial | null = null;
  private built = false;

  constructor(
    private readonly columns: number,
    private readonly theme: MapTheme
  ) {}

  ensureBuilt(model: StrategicMapModel): void {
    if (this.built) return;
    this.built = true;
    if (model.features.lakes.length === 0) return;
    const heights = buildVertexElevationGrid(model, this.columns);
    const positions: number[] = [];
    for (const lake of model.features.lakes) {
      for (const cellIndex of lake.cells) {
        const [nw, ne, se, sw] = cellCornerPoints(cellIndex, model.lattice, this.columns);
        const y = waterSurfaceY(heights, this.columns, cellIndex);
        for (const point of [nw, sw, se, nw, se, ne]) positions.push(point.x, y, point.z);
      }
    }
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    this.geometry.computeBoundingSphere();
    this.material = new THREE.MeshBasicMaterial({
      color: new THREE.Color(this.theme.layerColors.lakeFill),
      transparent: true,
      opacity: this.theme.layerColors.lakeOpacity,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(this.geometry, this.material);
    mesh.renderOrder = 6;
    this.group.add(mesh);
  }

  dispose(): void {
    this.group.clear();
    this.geometry?.dispose();
    this.geometry = null;
    this.material?.dispose();
    this.material = null;
    this.built = false;
  }
}

/**
 * Geographic grid: ONE merged LineSegments of every country-INTERNAL cell
 * boundary (the shared lattice edges between two land cells of the same
 * country). Country/province borders stay their own layers; the grid is the
 * A/B/C × 1/2/3 reference mesh behind them. Emitted once per lattice edge
 * (deduped by edge key), lazy, one draw call — no measurable frame cost.
 */
export class GridLayer {
  readonly group = new THREE.Group();
  private geometry: THREE.BufferGeometry | null = null;
  private material: THREE.LineBasicMaterial | null = null;
  private built = false;
  // —— interaction overlay state (rebuilt ONLY on selection/hover change) ——
  private selectFillMesh: THREE.Mesh | null = null;
  private selectOutlineMesh: THREE.LineLoop | null = null;
  private hoverFillMesh: THREE.Mesh | null = null;
  private selectFillMaterial: THREE.MeshBasicMaterial | null = null;
  private selectOutlineMaterial: THREE.LineBasicMaterial | null = null;
  private hoverFillMaterial: THREE.MeshBasicMaterial | null = null;
  private selectedCell = -1;
  private hoveredCell = -1;
  /** The static model — set during ensureBuilt (the lazy build). */
  private model: StrategicMapModel | null = null;
  /** Shared vertex-elevation grid for surface-following heights. */
  private heights: Float64Array | null = null;

  constructor(
    private readonly columns: number,
    private readonly rows: number,
    private readonly theme: MapTheme
  ) {}

  ensureBuilt(model: StrategicMapModel): void {
    if (this.built) return;
    this.built = true;
    this.model = model;
    this.heights = buildVertexElevationGrid(model, this.columns);
    const cellCount = model.features.biomes.length;
    const owner = model.features.cellOwner;
    const emitted = new Set<string>();
    const positions: number[] = [];
    const color = rgb(this.theme.layerColors.gridColor);
    const latticePoints = model.lattice;
    const stride = this.columns + 1;
    const heights = this.heights;
    const latticeIndexOf = (cellIndex: number, corner: 0 | 1 | 2 | 3): number => {
      const cz = Math.floor(cellIndex / this.columns);
      const cx = cellIndex - cz * this.columns;
      const nw = cz * stride + cx;
      return corner === 0 ? nw : corner === 1 ? nw + 1 : corner === 2 ? nw + stride + 1 : nw + stride;
    };
    const emitEdge = (a: number, b: number): void => {
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (emitted.has(key)) return;
      emitted.add(key);
      const pa = latticePoints[a];
      const pb = latticePoints[b];
      // The line FOLLOWS the terrain relief (max endpoint height — the
      // bilinear surface between two vertices never exceeds it) so the grid
      // stays ON the ground in every surface mode instead of sinking below
      // lifted terrain.
      const y =
        SURFACE_FILL_Y + Math.max(heights[a], heights[b]) * SURFACE_RELIEF_AMPLITUDE + GRID_LINE_LIFT;
      positions.push(pa.x, y, pa.z, pb.x, y, pb.z);
    };
    for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
      if (owner[cellIndex] < 0) continue; // ocean
      const cz = Math.floor(cellIndex / this.columns);
      const cx = cellIndex - cz * this.columns;
      // East + south neighbors: every interior lattice edge emitted once.
      const east = cx < this.columns - 1 ? cellIndex + 1 : -1;
      const south = cz < this.rows - 1 ? cellIndex + this.columns : -1;
      if (east >= 0 && owner[east] === owner[cellIndex]) {
        emitEdge(latticeIndexOf(cellIndex, 1), latticeIndexOf(cellIndex, 2));
      }
      if (south >= 0 && owner[south] === owner[cellIndex]) {
        emitEdge(latticeIndexOf(cellIndex, 3), latticeIndexOf(cellIndex, 2));
      }
    }
    if (positions.length > 0) {
      this.geometry = new THREE.BufferGeometry();
      this.geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      this.geometry.computeBoundingSphere();
      this.material = new THREE.LineBasicMaterial({
        vertexColors: false,
        color: new THREE.Color(color.r, color.g, color.b),
        transparent: true,
        opacity: this.theme.layerColors.gridOpacity,
        depthWrite: false
      });
      const segments = new THREE.LineSegments(this.geometry, this.material);
      segments.renderOrder = 5;
      this.group.add(segments);
    }

    // —— interaction overlays: the SELECTED and HOVERED cell are drawn as
    // the EXACT visible cell polygon (visibleCellPolygon — the same geometry
    // picking resolves), deliberately ABOVE every map level with
    // depthTest off, so terrain relief, water, country fills or tints can
    // never bury or cut them ("half-selected cell" is impossible). ——
    const selectColor = rgb(this.theme.layerColors.gridSelectColor);
    this.selectFillMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(selectColor.r, selectColor.g, selectColor.b),
      transparent: true,
      opacity: this.theme.layerColors.gridSelectOpacity,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide
    });
    const selectFill = new THREE.Mesh(new THREE.BufferGeometry(), this.selectFillMaterial);
    selectFill.renderOrder = 15;
    selectFill.visible = false;
    selectFill.frustumCulled = false;
    this.group.add(selectFill);
    this.selectFillMesh = selectFill;

    const outlineColor = rgb(this.theme.layerColors.gridSelectOutlineColor);
    this.selectOutlineMaterial = new THREE.LineBasicMaterial({
      color: new THREE.Color(outlineColor.r, outlineColor.g, outlineColor.b),
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      depthTest: false
    });
    const selectOutline = new THREE.LineLoop(new THREE.BufferGeometry(), this.selectOutlineMaterial);
    selectOutline.renderOrder = 16;
    selectOutline.visible = false;
    selectOutline.frustumCulled = false;
    this.group.add(selectOutline);
    this.selectOutlineMesh = selectOutline;

    const hoverColor = rgb(this.theme.layerColors.gridHoverColor);
    this.hoverFillMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(hoverColor.r, hoverColor.g, hoverColor.b),
      transparent: true,
      opacity: this.theme.layerColors.gridHoverOpacity,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide
    });
    const hoverFill = new THREE.Mesh(new THREE.BufferGeometry(), this.hoverFillMaterial);
    hoverFill.renderOrder = 14;
    hoverFill.visible = false;
    hoverFill.frustumCulled = false;
    this.group.add(hoverFill);
    this.hoverFillMesh = hoverFill;

    this.built = true;
    // Re-apply any selection/hover that arrived before the lazy build.
    this.redrawSelection();
    this.redrawHover();
  }

  /**
   * Marks a cell as SELECTED (fill + bright outline over the EXACT visible
   * polygon). Pass −1/null to clear. Safe to call before ensureBuilt
   * (applied on the lazy build). Rebuilds only on CHANGE — never per frame.
   */
  setSelectedCell(cellIndex: number | null): void {
    const next = cellIndex ?? -1;
    if (next === this.selectedCell) return;
    this.selectedCell = next;
    if (!this.built) return;
    this.redrawSelection();
  }

  /**
   * Marks the HOVERED cell (light fill over the exact visible polygon, no
   * outline). Rebuilds only when the hovered cell CHANGES — pointer moves
   * across a static map do no geometry work.
   */
  setHoveredCell(cellIndex: number | null): void {
    const next = cellIndex ?? -1;
    if (next === this.hoveredCell) return;
    this.hoveredCell = next;
    if (!this.built) return;
    this.redrawHover();
  }

  /** Surface-following overlay height for a cell (+ a small lift). */
  private overlayY(cellIndex: number, lift: number): number {
    if (this.heights === null || this.model === null) return SURFACE_FILL_Y + lift;
    return surfaceTopY(this.heights, this.columns, cellIndex) + lift;
  }

  /** Rebuilds the selection fill + outline from the visible polygon. */
  private redrawSelection(): void {
    const fillMesh = this.selectFillMesh;
    const outlineMesh = this.selectOutlineMesh;
    if (fillMesh === null || outlineMesh === null) return;
    const cell = this.selectedCell;
    if (cell < 0 || this.model === null) {
      fillMesh.visible = false;
      outlineMesh.visible = false;
      this.swapGeometry(fillMesh, null);
      this.swapGeometry(outlineMesh, null);
      return;
    }
    // THE shared geometry: exactly what picking resolves and the map shows.
    const { points } = visibleCellPolygon(this.model, cell, this.columns);
    this.swapGeometry(fillMesh, polygonFillGeometry(points, this.overlayY(cell, SELECT_FILL_LIFT)));
    fillMesh.visible = true;
    this.swapGeometry(outlineMesh, polygonOutlineGeometry(points, this.overlayY(cell, SELECT_OUTLINE_LIFT)));
    outlineMesh.visible = true;
  }

  /** Rebuilds the hover fill from the visible polygon. */
  private redrawHover(): void {
    const hoverMesh = this.hoverFillMesh;
    if (hoverMesh === null) return;
    const cell = this.hoveredCell;
    if (cell < 0 || cell === this.selectedCell || this.model === null) {
      hoverMesh.visible = false;
      this.swapGeometry(hoverMesh, null);
      return;
    }
    const { points } = visibleCellPolygon(this.model, cell, this.columns);
    this.swapGeometry(hoverMesh, polygonFillGeometry(points, this.overlayY(cell, HOVER_LIFT)));
    hoverMesh.visible = true;
  }

  /** Swaps a mesh's geometry (disposing the old) — selection-change only. */
  private swapGeometry(
    mesh: THREE.Mesh | THREE.LineLoop,
    next: THREE.BufferGeometry | null
  ): void {
    const previous = mesh.geometry;
    mesh.geometry = next ?? new THREE.BufferGeometry();
    if (previous !== mesh.geometry) previous.dispose();
  }

  dispose(): void {
    this.group.clear();
    this.geometry?.dispose();
    this.geometry = null;
    this.material?.dispose();
    this.material = null;
    this.selectFillMesh = null;
    this.selectOutlineMesh = null;
    this.hoverFillMesh = null;
    this.selectFillMaterial?.dispose();
    this.selectFillMaterial = null;
    this.selectOutlineMaterial?.dispose();
    this.selectOutlineMaterial = null;
    this.hoverFillMaterial?.dispose();
    this.hoverFillMaterial = null;
    this.model = null;
    this.heights = null;
    this.built = false;
  }
}

/**
 * Flat triangulated fill for a polygon at height `y` (ShapeUtils/earcut —
 * robust for the concave clipped-border polygons). Built only when the
 * selection or hover CHANGES — never per frame.
 */
function polygonFillGeometry(points: readonly MapPoint[], y: number): THREE.BufferGeometry {
  const contour = points.map((point) => new THREE.Vector2(point.x, point.z));
  const triangles = THREE.ShapeUtils.triangulateShape(contour, []);
  const positions = new Float32Array(triangles.length * 9);
  let offset = 0;
  for (const [a, b, c] of triangles) {
    for (const index of [a, b, c]) {
      positions[offset++] = points[index].x;
      positions[offset++] = y;
      positions[offset++] = points[index].z;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geometry;
}

/** Closed loop outline for a polygon at height `y`. */
function polygonOutlineGeometry(points: readonly MapPoint[], y: number): THREE.BufferGeometry {
  const positions = new Float32Array(points.length * 3);
  for (let index = 0; index < points.length; index++) {
    positions[index * 3] = points[index].x;
    positions[index * 3 + 1] = y;
    positions[index * 3 + 2] = points[index].z;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geometry;
}

// ———————————————————————————— site markers ————————————————————————————

type MarkerShape = 'circle' | 'square' | 'diamond' | 'pentagon';

function markerGeometry(shape: MarkerShape): THREE.BufferGeometry {
  switch (shape) {
    case 'circle': {
      const geometry = new THREE.CircleGeometry(1.1, 12);
      geometry.rotateX(-Math.PI / 2);
      return geometry;
    }
    case 'square': {
      const geometry = new THREE.PlaneGeometry(1.6, 1.6);
      geometry.rotateX(-Math.PI / 2);
      return geometry;
    }
    case 'diamond': {
      const geometry = new THREE.PlaneGeometry(1.7, 1.7);
      geometry.rotateZ(Math.PI / 4);
      geometry.rotateX(-Math.PI / 2);
      return geometry;
    }
    case 'pentagon': {
      const geometry = new THREE.CircleGeometry(1.4, 5);
      geometry.rotateX(-Math.PI / 2);
      return geometry;
    }
  }
}

/**
 * Point-site layer (ports / industry / resources / military): ONE
 * InstancedMesh with per-instance colors from the theme's siteColors.
 */
export class SiteLayer {
  readonly group = new THREE.Group();
  private mesh: THREE.InstancedMesh | null = null;
  private geometry: THREE.BufferGeometry | null = null;
  private material: THREE.MeshBasicMaterial | null = null;

  constructor(
    private readonly kinds: readonly MapSite['kind'][],
    private readonly shape: MarkerShape,
    private readonly theme: MapTheme
  ) {}

  ensureBuilt(model: StrategicMapModel): void {
    if (this.mesh !== null) return;
    const sites = model.features.sites.filter((site) => this.kinds.includes(site.kind));
    if (sites.length === 0) return;
    const colorOf = new Map<string, RGB>(
      Object.entries(this.theme.layerColors.siteColors).map(([kind, hex]) => [kind, rgb(hex)])
    );
    this.geometry = markerGeometry(this.shape);
    this.material = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: this.theme.layerColors.siteOpacity,
      depthWrite: false
    });
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, sites.length);
    const matrix = new THREE.Matrix4();
    const color = new THREE.Color();
    sites.forEach((site, index) => {
      matrix.makeTranslation(site.position.x, 1.2, site.position.z);
      this.mesh?.setMatrixAt(index, matrix);
      const siteColor = colorOf.get(site.kind);
      if (siteColor !== undefined) {
        color.setRGB(siteColor.r, siteColor.g, siteColor.b);
        this.mesh?.setColorAt(index, color);
      }
    });
    this.mesh.renderOrder = 9;
    this.group.add(this.mesh);
  }

  dispose(): void {
    this.group.clear();
    this.mesh?.dispose();
    this.mesh = null;
    this.geometry?.dispose();
    this.geometry = null;
    this.material?.dispose();
    this.material = null;
  }
}

/**
 * Buildings / facilities layer (Part 3): ONE InstancedMesh over
 * model.features.buildings with per-instance theme colors
 * (layerColors.buildingColors — data-driven, small square markers).
 */
export class BuildingsLayer {
  readonly group = new THREE.Group();
  private mesh: THREE.InstancedMesh | null = null;
  private geometry: THREE.BufferGeometry | null = null;
  private material: THREE.MeshBasicMaterial | null = null;
  private built = false;

  constructor(
    /** Kinds to render (null = every building kind). */
    private readonly kinds: readonly MapBuilding['kind'][] | null,
    private readonly theme: MapTheme
  ) {}

  ensureBuilt(model: StrategicMapModel): void {
    if (this.built) return;
    this.built = true;
    const kinds = this.kinds;
    const buildings =
      kinds === null
        ? model.features.buildings
        : model.features.buildings.filter((building) => kinds.includes(building.kind));
    if (buildings.length === 0) return;
    const colorOf = new Map<string, RGB>(
      Object.entries(this.theme.layerColors.buildingColors).map(([kind, hex]) => [kind, rgb(hex)])
    );
    this.geometry = new THREE.PlaneGeometry(1.2, 1.2);
    this.geometry.rotateX(-Math.PI / 2);
    this.material = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: this.theme.layerColors.buildingOpacity,
      depthWrite: false
    });
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, buildings.length);
    const matrix = new THREE.Matrix4();
    const color = new THREE.Color();
    buildings.forEach((building, index) => {
      matrix.makeTranslation(building.position.x, 1.05, building.position.z);
      this.mesh?.setMatrixAt(index, matrix);
      const buildingColor = colorOf.get(building.kind);
      if (buildingColor !== undefined) {
        color.setRGB(buildingColor.r, buildingColor.g, buildingColor.b);
        this.mesh?.setColorAt(index, color);
      }
    });
    this.mesh.renderOrder = 8;
    this.group.add(this.mesh);
  }

  dispose(): void {
    this.group.clear();
    this.mesh?.dispose();
    this.mesh = null;
    this.geometry?.dispose();
    this.geometry = null;
    this.material?.dispose();
    this.material = null;
    this.built = false;
  }
}

/**
 * Strategic-value tint (Strategic Information layer): a translucent
 * per-cell fill colored by the OWNING PROVINCE's strategic value
 * (model.provinces[id].strategicValue — the SAME computed value any future
 * war/economy system reads). One merged vertex-colored mesh, lazy.
 */
export function createStrategicFillLayer(
  columns: number,
  theme: MapTheme
): CellFillLayer {
  const low = rgb(theme.layerColors.strategicLow);
  const high = rgb(theme.layerColors.strategicHigh);
  let maxValue = 1;
  let maxComputed = false;
  return new CellFillLayer(columns, theme.layerColors.tintFillOpacity, (cellIndex, model) => {
    const provinceId = model.features.provinceOf[cellIndex];
    if (provinceId === null || provinceId === undefined) return null;
    const province = model.provinces[provinceId];
    if (province === undefined) return null;
    if (!maxComputed) {
      // One-time normalization anchor: the strongest province on the map.
      maxValue = Math.max(1, ...Object.values(model.provinces).map((entry) => entry.strategicValue));
      maxComputed = true;
    }
    const t = Math.pow(province.strategicValue / maxValue, 1.4);
    return lerpColor(low, high, t);
  });
}
