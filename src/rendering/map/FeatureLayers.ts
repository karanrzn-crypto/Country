import * as THREE from 'three';
import type { StrategicMapModel, MapSite } from '../../world/map/MapTypes';
import { cellCornerPoints } from '../../world/map/MapFeatures';
import { type MapTheme } from './MapTheme';
import { type RGB, rgb, lerpColor } from './MapSurface';

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

/** Rivers (lines) + lake basin cells (filled quads) — the water layer. */
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
    const riverGeometry = lineSegmentsFromPolylines(
      model.features.rivers.map((river) => river.polyline),
      riverColor,
      0.8
    );
    if (riverGeometry !== null) {
      this.geometries.push(riverGeometry);
      const material = new THREE.LineBasicMaterial({
        transparent: true,
        opacity: this.theme.layerColors.riverOpacity,
        depthWrite: false
      });
      this.materials.push(material);
      const lines = new THREE.LineSegments(riverGeometry, material);
      lines.renderOrder = 6;
      this.group.add(lines);
    }
    // Lakes: filled quads of the basin cells (same shared lattice geometry).
    if (model.features.lakeCells.length > 0) {
      const positions: number[] = [];
      for (const cellIndex of model.features.lakeCells) {
        const [nw, ne, se, sw] = cellCornerPoints(cellIndex, model.lattice, this.columns);
        for (const point of [nw, sw, se, nw, se, ne]) positions.push(point.x, 0.75, point.z);
      }
      const lakeGeometry = new THREE.BufferGeometry();
      lakeGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      lakeGeometry.computeBoundingSphere();
      this.geometries.push(lakeGeometry);
      const lakeMaterial = new THREE.MeshBasicMaterial({
        color: new THREE.Color(this.theme.layerColors.lakeFill),
        transparent: true,
        opacity: this.theme.layerColors.lakeOpacity,
        depthWrite: false,
        side: THREE.DoubleSide
      });
      this.materials.push(lakeMaterial);
      const lakeMesh = new THREE.Mesh(lakeGeometry, lakeMaterial);
      lakeMesh.renderOrder = 5;
      this.group.add(lakeMesh);
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
