import * as THREE from 'three';
import type { StrategicMapModel } from '../../world/map/MapTypes';
import { cellCornerPoints } from '../../world/map/MapFeatures';
import type { MapTheme } from './MapTheme';

/**
 * MapSurface — THE single visual definition of the map's land surface.
 *
 * Both the on-map rendering AND the UI legends consume the same accessors
 * from this module, so a legend swatch can never drift from what the map
 * actually draws:
 * - `biomeBaseColor`  — the canonical color of a biome (theme-owned data);
 * - `parseTerrainRamp` + `rampColorAt` — THE elevation→color gradient:
 *   one simple continuous ramp, blue (lowest) → green → yellow → orange →
 *   red (highest), interpolated directly from the elevation value;
 * - `rampGradientStops` — the same ramp sampled for the legend's gradient
 *   bar (map and legend are the same definition by construction).
 *
 * The SurfaceLayer mesh itself:
 * - ONE merged, vertex-colored mesh (one geometry, one material) built
 *   LAZILY on first visibility;
 * - subdivided (3×3 per cell) so the elevation field reads as GRADUAL,
 *   geographic transitions instead of flat per-cell patches;
 * - terrain mode paints the ramp color EXACTLY (no shading, no global
 *   filters) — every pixel's color is a pure function of elevation, so the
 *   legend gradient matches the map 1:1;
 * - `mode` is ONE surface coloring at a time (political | biomes | terrain)
 *   — biomes and terrain are exclusive SURFACE renderings (enforced in the
 *   layer state), while their DATA stays independent in the map model;
 * - rebuilt ONLY when the mode changes; zero per-frame cost.
 *
 * Pure view: all data comes from the static model + theme.
 */

export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** THREE.Color parse — authored sRGB → linear working space (exact display). */
export function rgb(hex: string): RGB {
  const color = new THREE.Color(hex.startsWith('#') ? hex : `#${hex}`);
  return { r: color.r, g: color.g, b: color.b };
}

/**
 * Linear RGB → sRGB hex (the inverse of `rgb`). Legends use this to show
 * the EXACT color the surface paints, straight from the same parsed values.
 */
export function rgbToHex(color: RGB): string {
  const three = new THREE.Color();
  three.setRGB(color.r, color.g, color.b, THREE.LinearSRGBColorSpace);
  return `#${three.getHexString(THREE.SRGBColorSpace)}`;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerpColor(a: RGB, b: RGB, t: number): RGB {
  const clamped = Math.max(0, Math.min(1, t));
  return { r: lerp(a.r, b.r, clamped), g: lerp(a.g, b.g, clamped), b: lerp(a.b, b.b, clamped) };
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

// ———————————————————— central biome color definition ————————————————————

const biomeColorCache = new WeakMap<object, Map<string, RGB>>();

/**
 * The canonical on-map color of a biome. The renderer paints every cell of
 * that biome around THIS base (subtle symmetric tonal variation only), and
 * the legend shows exactly this color — one definition, two consumers.
 */
export function biomeBaseColor(theme: MapTheme, biome: string): RGB {
  let cache = biomeColorCache.get(theme.layerColors.biomes);
  if (cache === undefined) {
    cache = new Map<string, RGB>();
    biomeColorCache.set(theme.layerColors.biomes, cache);
  }
  const cached = cache.get(biome);
  if (cached !== undefined) return cached;
  const hex = (theme.layerColors.biomes as Record<string, string>)[biome];
  const parsed = rgb(hex ?? '#808080');
  cache.set(biome, parsed);
  return parsed;
}

// ———————————————————— central terrain elevation ramp ————————————————————

export interface RampStop {
  readonly at: number;
  readonly color: RGB;
}

/** Pre-parses the theme's hypsometric ramp (stops sorted ascending by `at`). */
export function parseTerrainRamp(theme: MapTheme): RampStop[] {
  return [...theme.layerColors.terrainRamp]
    .map((stop) => ({ at: stop.at, color: rgb(stop.color) }))
    .sort((a, b) => a.at - b.at);
}

/** Canonical elevation → color (clamps below the first / above the last stop). */
export function rampColorAt(ramp: readonly RampStop[], elevation: number): RGB {
  if (ramp.length === 0) return { r: 0.5, g: 0.5, b: 0.5 };
  if (elevation <= ramp[0].at) return ramp[0].color;
  const last = ramp[ramp.length - 1];
  if (elevation >= last.at) return last.color;
  for (let index = 1; index < ramp.length; index++) {
    const stop = ramp[index];
    if (elevation <= stop.at) {
      const previous = ramp[index - 1];
      const t = (elevation - previous.at) / (stop.at - previous.at || 1);
      return lerpColor(previous.color, stop.color, t);
    }
  }
  return last.color;
}

export interface GradientStopHex {
  readonly at: number;
  /** Display sRGB hex — exactly what rampColorAt renders at `at`. */
  readonly color: string;
}

/**
 * The elevation gradient as DISPLAY stops for the legend's CSS gradient bar.
 * Samples THE SAME canonical `rampColorAt` the surface paints with (the map
 * interpolates in linear space; browsers in sRGB) — with enough samples the
 * legend bar is visually identical to the map's coloring, from one source.
 */
export function rampGradientStops(theme: MapTheme, sampleCount?: number): GradientStopHex[] {
  const ramp = parseTerrainRamp(theme);
  const samples = Math.max(2, Math.floor(sampleCount ?? theme.layerColors.elevationLegend.samples));
  const stops: GradientStopHex[] = [];
  for (let index = 0; index < samples; index++) {
    const at = index / (samples - 1);
    stops.push({ at, color: rgbToHex(rampColorAt(ramp, at)) });
  }
  return stops;
}

// ———————————————————— deterministic variation noise ————————————————————

/**
 * Deterministic 32-bit hash → [0,1). Pure integer math (Math.imul), so the
 * same (a, b, seed) yields the same value on every platform and run.
 */
export function hash01(a: number, b: number, seed: number): number {
  let h = (seed | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (a | 0), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h ^ (b | 0), 0x27d4eb2d);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Smooth bilinear value-noise over an integer lattice (pure, hash-based). */
function valueNoise01(x: number, z: number, seed: number): number {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const tx = x - x0;
  const tz = z - z0;
  const sx = tx * tx * (3 - 2 * tx);
  const sz = tz * tz * (3 - 2 * tz);
  const n00 = hash01(x0, z0, seed);
  const n10 = hash01(x0 + 1, z0, seed);
  const n01 = hash01(x0, z0 + 1, seed);
  const n11 = hash01(x0 + 1, z0 + 1, seed);
  return (n00 * (1 - sx) + n10 * sx) * (1 - sz) + (n01 * (1 - sx) + n11 * sx) * sz;
}

/** Packs cell coordinates into one stable integer key for hashing. */
function cellKey(cx: number, cz: number): number {
  return (cz * 4096 + cx) | 0;
}

export interface BiomeVariationParams {
  /** Large-scale tonal patches (lightness ± factor). */
  readonly patchStrength: number;
  /** Per-cell micro jitter (lightness ± factor). */
  readonly cellJitter: number;
  /** High cells drift lighter/rockier, low cells darker (± factor / 2). */
  readonly elevationLightness: number;
}

const DEFAULT_BIOME_VARIATION: BiomeVariationParams = {
  patchStrength: 0.035,
  cellJitter: 0.02,
  elevationLightness: 0.07
};

/**
 * Natural biome color: the biome's canonical base color modulated by small,
 * SYMMETRIC tonal variation (large patches + per-cell jitter + slight
 * elevation drift). The variation stays well inside a narrow band around
 * the base so the legend's base color always reads as the same color the
 * map shows — natural texture, never a hue shift, no neon.
 */
export function naturalBiomeColor(
  base: RGB,
  elevation: number,
  cx: number,
  cz: number,
  seed: number,
  variation: BiomeVariationParams = DEFAULT_BIOME_VARIATION
): RGB {
  const patch =
    valueNoise01(cx * 0.16, cz * 0.16, seed) * 0.65 +
    valueNoise01(cx * 0.45, cz * 0.45, seed + 1013) * 0.35;
  const tone = (patch - 0.5) * 2 * variation.patchStrength;
  const jitter = (hash01(cellKey(cx, cz), 0x5f356495, seed) - 0.5) * 2 * variation.cellJitter;
  const elevShift = (elevation - 0.5) * variation.elevationLightness;
  const light = 1 + tone + jitter + elevShift;
  // Subtle warm/cool drift between patches (warm → +R −B, cool → −R +B).
  const warm =
    (valueNoise01(cx * 0.3 + 11.7, cz * 0.3 + 4.3, seed + 7331) - 0.5) *
    2 *
    variation.patchStrength *
    0.6;
  return {
    r: clamp01(base.r * light + warm * 0.5),
    g: clamp01(base.g * light + warm * 0.1),
    b: clamp01(base.b * light - warm * 0.4)
  };
}

// ———————————————————— elevation vertex grid ————————————————————

/**
 * Vertex (lattice-corner) elevation grid, (columns+1)×(rows+1): each vertex
 * averages its adjacent LAND cell elevations (sea vertices stay at 0), so
 * bilinear sampling inside a cell is C0-continuous across the whole map —
 * gradual geographic transitions, no per-cell stair steps.
 */
export function buildVertexElevationGrid(model: StrategicMapModel, columns: number): Float64Array {
  const rows = Math.ceil(model.features.biomes.length / columns);
  const stride = columns + 1;
  const sums = new Float64Array(stride * (rows + 1));
  const counts = new Float64Array(stride * (rows + 1));
  for (let cellIndex = 0; cellIndex < model.features.biomes.length; cellIndex++) {
    if (model.features.biomes[cellIndex] === 'ocean') continue;
    const cz = Math.floor(cellIndex / columns);
    const cx = cellIndex - cz * columns;
    const elevation = model.features.elevation[cellIndex];
    for (const [dx, dz] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1]
    ] as const) {
      const vertex = (cz + dz) * stride + (cx + dx);
      sums[vertex] += elevation;
      counts[vertex] += 1;
    }
  }
  const heights = new Float64Array(stride * (rows + 1));
  for (let index = 0; index < heights.length; index++) {
    heights[index] = counts[index] > 0 ? sums[index] / counts[index] : 0;
  }
  return heights;
}

// ———————————————————— the surface layer ————————————————————

/** The ONE surface coloring currently shown (exclusive, layer-state driven). */
export type SurfaceMode = 'political' | 'biomes' | 'terrain';

/** Base height of the land surface — above all base fills, below water/borders. */
export const SURFACE_FILL_Y = 0.7;
/** Max geometric lift of the highest ground above the surface plane. */
export const SURFACE_RELIEF_AMPLITUDE = 0.3;
/** Sub-quads per cell edge — 3×3 keeps the gradient smooth at trivial cost. */
const SUBDIVISIONS = 3;

/**
 * The land surface (political base / biomes / terrain elevation gradient).
 * ONE merged mesh, rebuilt only when the mode changes. Biomes and terrain
 * are EXCLUSIVE surface colorings (layer-state policy) — the terrain mode
 * paints the continuous elevation ramp EXACTLY (color = pure function of
 * elevation), so the legend gradient matches the map 1:1. Rivers/water are
 * painted by RiverLayer above this surface, never tinted by the ramp.
 */
export class SurfaceLayer {
  readonly group = new THREE.Group();
  private mode: SurfaceMode = 'political';
  private builtMode: SurfaceMode | null = null;
  private geometry: THREE.BufferGeometry | null = null;
  private material: THREE.MeshBasicMaterial | null = null;

  /** Base height of the surface — above all base fills, below borders/rivers. */
  private static readonly FILL_Y = SURFACE_FILL_Y;

  constructor(private readonly columns: number) {}

  setMode(mode: SurfaceMode): void {
    this.mode = mode;
  }

  /** Builds (or rebuilds after a mode change) the merged surface mesh. */
  ensureBuilt(model: StrategicMapModel, theme: MapTheme): void {
    if (this.mode === 'political' || this.mode === this.builtMode) return;
    this.disposeGeometry();
    const columns = this.columns;
    const biomeVariation = theme.layerColors.biomeVariation ?? DEFAULT_BIOME_VARIATION;
    const ramp = parseTerrainRamp(theme);
    const heights = buildVertexElevationGrid(model, columns);
    const stride = columns + 1;

    const positions: number[] = [];
    const colors: number[] = [];
    const cellCount = model.features.biomes.length;

    for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
      const biome = model.features.biomes[cellIndex];
      if (biome === 'ocean') continue;
      const cz = Math.floor(cellIndex / columns);
      const cx = cellIndex - cz * columns;
      const [nw, ne, se, sw] = cellCornerPoints(cellIndex, model.lattice, columns);
      const cornerHeights = [
        heights[cz * stride + cx],
        heights[cz * stride + cx + 1],
        heights[(cz + 1) * stride + cx + 1],
        heights[(cz + 1) * stride + cx]
      ];

      // Per-cell biome color (biomes mode only).
      const base = biomeBaseColor(theme, biome);
      const elevation = model.features.elevation[cellIndex] ?? 0.5;
      const biomeColor =
        this.mode === 'terrain'
          ? null
          : naturalBiomeColor(base, elevation, cx, cz, model.seed, biomeVariation);

      /** Bilinear height sample inside the cell (raw elevation, no offsets). */
      const sampleHeight = (u: number, v: number): number => {
        const hTop = lerp(cornerHeights[0], cornerHeights[1], u);
        const hBottom = lerp(cornerHeights[3], cornerHeights[2], u);
        return lerp(hTop, hBottom, v);
      };

      /** Bilinear position sample: planar (jittered lattice) + lifted relief. */
      const sample = (u: number, v: number): { x: number; y: number; z: number } => {
        const topX = lerp(nw.x, ne.x, u);
        const topZ = lerp(nw.z, ne.z, u);
        const bottomX = lerp(sw.x, se.x, u);
        const bottomZ = lerp(sw.z, se.z, u);
        return {
          x: lerp(topX, bottomX, v),
          y: SurfaceLayer.FILL_Y + sampleHeight(u, v) * SURFACE_RELIEF_AMPLITUDE,
          z: lerp(topZ, bottomZ, v)
        };
      };

      for (let j = 0; j < SUBDIVISIONS; j++) {
        for (let i = 0; i < SUBDIVISIONS; i++) {
          const u0 = i / SUBDIVISIONS;
          const u1 = (i + 1) / SUBDIVISIONS;
          const v0 = j / SUBDIVISIONS;
          const v1 = (j + 1) / SUBDIVISIONS;
          const p0 = sample(u0, v0);
          const p1 = sample(u1, v0);
          const p2 = sample(u1, v1);
          const p3 = sample(u0, v1);

          // Terrain = THE elevation gradient: the color is computed DIRECTLY
          // from the elevation value — continuous blue → green → yellow →
          // orange → red, no shading, no extra tones, legend-exact.
          const color =
            this.mode === 'terrain'
              ? rampColorAt(ramp, (sampleHeight(u0, v0) + sampleHeight(u1, v1)) / 2)
              : (biomeColor as RGB);

          for (const point of [p0, p3, p2, p0, p2, p1]) {
            positions.push(point.x, point.y, point.z);
            colors.push(color.r, color.g, color.b);
          }
        }
      }
    }

    if (positions.length === 0) {
      this.builtMode = this.mode;
      return;
    }
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    this.geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    this.geometry.computeBoundingSphere();
    this.material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: false,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(this.geometry, this.material);
    mesh.renderOrder = 4;
    this.group.add(mesh);
    this.builtMode = this.mode;
  }

  get isBuilt(): boolean {
    return this.geometry !== null;
  }

  private disposeGeometry(): void {
    if (this.geometry === null) return;
    this.group.clear();
    this.geometry.dispose();
    this.geometry = null;
    this.material?.dispose();
    this.material = null;
  }

  dispose(): void {
    this.disposeGeometry();
    this.group.clear();
    this.builtMode = null;
  }
}
