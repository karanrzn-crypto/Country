import * as THREE from 'three';
import type { StrategicMapModel, MapSite, MapRiver, MapBuilding, MapPoint } from '../../world/map/MapTypes';
import { cellCornerPoints } from '../../world/map/MapFeatures';
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
 * definition shared with the legends): rivers/lakes, roads, railways,
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
    for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
      const color = this.colorAt(cellIndex, model);
      if (color === null) continue;
      const [nw, ne, se, sw] = cellCornerPoints(cellIndex, model.lattice, this.columns);
      // Two triangles: NW-SW-SE and NW-SE-NE (DoubleSide — winding-free).
      for (const point of [nw, sw, se, nw, se, ne]) {
        positions.push(point.x, CellFillLayer.FILL_Y, point.z);
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
    mesh.renderOrder = 5; // translucent tint ABOVE the surface (4), below rivers (6)
    this.group.add(mesh);
  }

  /** Cell-fill height — ABOVE the land surface (0.7), below borders/rivers. */
  private static readonly FILL_Y = 0.72;

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
  y: number
): THREE.BufferGeometry | null {
  const positions: number[] = [];
  const colors: number[] = [];
  for (const polyline of polylines) {
    for (let i = 1; i < polyline.length; i++) {
      const a = polyline[i - 1];
      const b = polyline[i];
      positions.push(a.x, y, a.z, b.x, y, b.z);
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

/**
 * Line-feature layer (roads vertex-colored by class, railways, sea routes) —
 * ONE merged LineSegments per color group, built lazily, disposed as one.
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
    private readonly y: number
  ) {}

  ensureBuilt(model: StrategicMapModel): void {
    if (this.geometries.length > 0) return;
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
      const geometry = lineSegmentsFromPolylines(entry.polylines, entry.color, this.y);
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

/** Roads: vertex-colored by road class (theme data). */
export function createRoadsLayer(theme: MapTheme): LineFeatureLayer {
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
    0.85
  );
}

/** Railways: single theme color. */
export function createRailwaysLayer(theme: MapTheme): LineFeatureLayer {
  const color = rgb(theme.layerColors.railwayStroke);
  return new LineFeatureLayer(
    (model) =>
      model.features.lines
        .filter((line) => line.kind === 'railway')
        .map((line) => ({ color, polyline: line.polyline })),
    theme.layerColors.railwayOpacity,
    0.87
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

/**
 * Height of the water surface for a cell: ABOVE the rendered land surface
 * within that cell (the surface's height is a convex blend of the cell's
 * four corner heights — the max corner therefore dominates everywhere in
 * the cell), so rivers/lakes stay visible in EVERY mode and never sink
 * into lifted relief.
 */
function waterSurfaceY(heights: Float64Array, columns: number, cellIndex: number): number {
  const cz = Math.floor(cellIndex / columns);
  const cx = cellIndex - cz * columns;
  const stride = columns + 1;
  const maxCorner = Math.max(
    heights[cz * stride + cx],
    heights[cz * stride + cx + 1],
    heights[(cz + 1) * stride + cx + 1],
    heights[(cz + 1) * stride + cx]
  );
  return SURFACE_FILL_Y + maxCorner * SURFACE_RELIEF_AMPLITUDE + WATER_LIFT;
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
 * ONE merged ribbon mesh for ALL rivers — a triangle strip along each
 * river polyline with a natural, tapering width (narrow at the source,
 * widest at the mouth) and smooth per-point normals, so rivers read as
 * flowing water instead of artificial 1-px lines. Ribbon height follows
 * the terrain surface (water stays on the ground in every mode).
 */
export function buildRiverRibbons(
  model: StrategicMapModel,
  columns: number,
  theme: MapTheme
): THREE.BufferGeometry | null {
  if (model.features.rivers.length === 0) return null;
  const heights = buildVertexElevationGrid(model, columns);
  const width = theme.layerColors.riverWidth;
  const positions: number[] = [];
  for (const river of model.features.rivers) {
    const polyline = river.polyline;
    if (polyline.length < 2) continue;
    // Per-point frame: tangent (central difference) → perpendicular normal.
    const left: { x: number; y: number; z: number }[] = [];
    const right: { x: number; y: number; z: number }[] = [];
    for (let i = 0; i < polyline.length; i++) {
      const previous = polyline[Math.max(0, i - 1)];
      const next = polyline[Math.min(polyline.length - 1, i + 1)];
      const tx = next.x - previous.x;
      const tz = next.z - previous.z;
      const length = Math.hypot(tx, tz) || 1;
      const nx = -tz / length;
      const nz = tx / length;
      const halfWidth = riverWidthAt(river, i / (polyline.length - 1), width) / 2;
      const point = polyline[i];
      const y = waterSurfaceY(heights, columns, river.cells[i]);
      left.push({ x: point.x + nx * halfWidth, y, z: point.z + nz * halfWidth });
      right.push({ x: point.x - nx * halfWidth, y, z: point.z - nz * halfWidth });
    }
    for (let i = 1; i < polyline.length; i++) {
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
      mesh.renderOrder = 6;
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
  // —— interaction overlay state (preallocated, updated in place) ——
  private selectFillMesh: THREE.Mesh | null = null;
  private selectOutlineMesh: THREE.LineLoop | null = null;
  private hoverFillMesh: THREE.Mesh | null = null;
  private selectFillGeometry: THREE.BufferGeometry | null = null;
  private selectOutlineGeometry: THREE.BufferGeometry | null = null;
  private hoverFillGeometry: THREE.BufferGeometry | null = null;
  private selectFillMaterial: THREE.MeshBasicMaterial | null = null;
  private selectOutlineMaterial: THREE.LineBasicMaterial | null = null;
  private hoverFillMaterial: THREE.MeshBasicMaterial | null = null;
  private selectedCell = -1;
  private hoveredCell = -1;
  /** Lattice points cache — set during ensureBuilt (the model arrives there). */
  private modelLattice: readonly MapPoint[] = [];

  constructor(
    private readonly columns: number,
    private readonly rows: number,
    private readonly theme: MapTheme
  ) {}

  ensureBuilt(model: StrategicMapModel): void {
    if (this.built) return;
    this.built = true;
    this.modelLattice = model.lattice;
    const cellCount = model.features.biomes.length;
    const owner = model.features.cellOwner;
    const emitted = new Set<string>();
    const positions: number[] = [];
    const color = rgb(this.theme.layerColors.gridColor);
    const latticePoints = model.lattice;
    const stride = this.columns + 1;
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
      positions.push(pa.x, GridLayer.LINE_Y, pa.z, pb.x, GridLayer.LINE_Y, pb.z);
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
    if (positions.length === 0) return;
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

    // —— interaction overlays: ONE preallocated fill + outline quad each for
    // the selected and the hovered cell (rewritten IN PLACE on change — no
    // per-frame allocation, no rebuild of the merged grid) ——
    const selectColor = rgb(this.theme.layerColors.gridSelectColor);
    this.selectFillMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(selectColor.r, selectColor.g, selectColor.b),
      transparent: true,
      opacity: this.theme.layerColors.gridSelectOpacity,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    this.selectFillGeometry = new THREE.BufferGeometry();
    this.selectFillGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(12), 3)
    );
    const selectFill = new THREE.Mesh(this.selectFillGeometry, this.selectFillMaterial);
    selectFill.renderOrder = 4;
    selectFill.visible = false;
    selectFill.frustumCulled = false;
    this.group.add(selectFill);
    this.selectFillMesh = selectFill;

    const outlineColor = rgb(this.theme.layerColors.gridSelectOutlineColor);
    this.selectOutlineMaterial = new THREE.LineBasicMaterial({
      color: new THREE.Color(outlineColor.r, outlineColor.g, outlineColor.b),
      transparent: true,
      opacity: 0.95,
      depthWrite: false
    });
    this.selectOutlineGeometry = new THREE.BufferGeometry();
    this.selectOutlineGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(12), 3)
    );
    const selectOutline = new THREE.LineLoop(this.selectOutlineGeometry, this.selectOutlineMaterial);
    selectOutline.renderOrder = 6;
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
      side: THREE.DoubleSide
    });
    this.hoverFillGeometry = new THREE.BufferGeometry();
    this.hoverFillGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(12), 3)
    );
    const hoverFill = new THREE.Mesh(this.hoverFillGeometry, this.hoverFillMaterial);
    hoverFill.renderOrder = 4;
    hoverFill.visible = false;
    hoverFill.frustumCulled = false;
    this.group.add(hoverFill);
    this.hoverFillMesh = hoverFill;

    this.built = true;
    // Re-apply any selection/hover that arrived before the lazy build.
    this.writeCell(this.selectFillGeometry, this.selectOutlineGeometry, this.selectedCell);
    this.writeCell(this.hoverFillGeometry, null, this.hoveredCell);
    selectFill.visible = this.selectedCell >= 0;
    selectOutline.visible = this.selectedCell >= 0;
    hoverFill.visible = this.hoveredCell >= 0 && this.hoveredCell !== this.selectedCell;
  }

  /** Sits just above the land surface, below rivers/borders. */
  static readonly LINE_Y = 0.62;

  /**
   * Marks a cell as SELECTED (clear fill + bright outline). Pass −1/null to
   * clear. Safe to call before ensureBuilt (applied on the lazy build).
   */
  setSelectedCell(cellIndex: number | null): void {
    const next = cellIndex ?? -1;
    if (next === this.selectedCell) return;
    this.selectedCell = next;
    if (!this.built) return;
    this.writeCell(this.selectFillGeometry, this.selectOutlineGeometry, next);
  }

  /**
   * Marks the HOVERED cell (light fill, no outline). Only rewrites the 12
   * floats when the hovered cell actually CHANGES — pointer moves across a
   * static map never allocate.
   */
  setHoveredCell(cellIndex: number | null): void {
    const next = cellIndex ?? -1;
    if (next === this.hoveredCell) return;
    this.hoveredCell = next;
    if (!this.built) return;
    this.writeCell(this.hoverFillGeometry, null, next);
  }

  /** Writes the 4 lattice corners of a cell into a fill + outline buffer. */
  private writeCell(
    fill: THREE.BufferGeometry | null,
    outline: THREE.BufferGeometry | null,
    cellIndex: number
  ): void {
    if (fill === null) return;
    const fillPosition = fill.getAttribute('position') as THREE.BufferAttribute;
    const outlinePosition =
      outline !== null ? (outline.getAttribute('position') as THREE.BufferAttribute) : null;
    const visible = cellIndex >= 0;
    if (this.selectFillMesh !== null && fill === this.selectFillGeometry) {
      this.selectFillMesh.visible = visible;
    }
    if (this.hoverFillMesh !== null && fill === this.hoverFillGeometry) {
      this.hoverFillMesh.visible = visible && cellIndex !== this.selectedCell;
    }
    if (this.selectOutlineMesh !== null && outline === this.selectOutlineGeometry) {
      this.selectOutlineMesh.visible = visible;
    }
    if (!visible) return;
    const corners = this.cornerLatticeOf(cellIndex);
    // Quad triangles: nw, ne, se / nw, se, sw (y = slightly below the lines).
    const y = GridLayer.LINE_Y - 0.04;
    const quad = [0, 1, 2, 0, 2, 3];
    let i = 0;
    for (const corner of quad) {
      const point = corners[corner];
      fillPosition.setXYZ(i++, point.x, y, point.z);
    }
    fillPosition.needsUpdate = true;
    if (outlinePosition !== null) {
      const oy = GridLayer.LINE_Y + 0.04;
      for (let c = 0; c < 4; c++) {
        outlinePosition.setXYZ(c, corners[c].x, oy, corners[c].z);
      }
      outlinePosition.needsUpdate = true;
    }
  }

  /** World-space lattice corners of a cell (nw, ne, se, sw). */
  private cornerLatticeOf(cellIndex: number): readonly MapPoint[] {
    const stride = this.columns + 1;
    const cz = Math.floor(cellIndex / this.columns);
    const cx = cellIndex - cz * this.columns;
    const nw = cz * stride + cx;
    const lattice = this.modelLattice;
    const at = (index: number): MapPoint => lattice[index] ?? { x: 0, z: 0 };
    return [at(nw), at(nw + 1), at(nw + stride + 1), at(nw + stride)];
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
    this.selectFillGeometry?.dispose();
    this.selectFillGeometry = null;
    this.selectOutlineGeometry?.dispose();
    this.selectOutlineGeometry = null;
    this.hoverFillGeometry?.dispose();
    this.hoverFillGeometry = null;
    this.selectFillMaterial?.dispose();
    this.selectFillMaterial = null;
    this.selectOutlineMaterial?.dispose();
    this.selectOutlineMaterial = null;
    this.hoverFillMaterial?.dispose();
    this.hoverFillMaterial = null;
    this.built = false;
  }
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
