import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  naturalBiomeColor,
  hash01,
  biomeBaseColor,
  parseTerrainRamp,
  rampColorAt,
  rampGradientStops,
  rgb,
  rgbToHex,
  buildVertexElevationGrid,
  SurfaceLayer,
  SURFACE_FILL_Y,
  SURFACE_RELIEF_AMPLITUDE,
  type RGB
} from '../../../rendering/map/MapSurface';
import { generateStrategicMap } from '../../../world/map/MapGenerator';
import { DEFAULT_MAP_CONFIG } from '../../helpers/mapTestConfig';
import themeJson from '../../../data/mapTheme.json';
import type { MapThemeData } from '../../../data/types';

/** Forest base (theme-like muted green) in LINEAR rgb — same space as rgb(). */
const FOREST: RGB = { r: 0.37, g: 0.49, b: 0.29 };
const theme = themeJson as unknown as MapThemeData;

/**
 * Natural biome display + land surface:
 * - deterministic variation — tonal patches, per-cell jitter, elevation
 *   drift — all SYMMETRIC and small, so the legend's base color always
 *   reads as the same color the map shows (no hue shift, no neon);
 * - one central color definition (MapSurface) for renderer AND legends;
 * - terrain mode = ONE simple continuous elevation gradient
 *   (blue → green → yellow → orange → red), computed DIRECTLY from the
 *   elevation value — no shading, no composite — so the legend gradient
 *   matches the map exactly.
 */
describe('natural biome coloring', () => {
  it('hash01 is deterministic and well-spread', () => {
    expect(hash01(3, 7, 42)).toBe(hash01(3, 7, 42));
    const values = new Set<number>();
    for (let i = 0; i < 64; i++) values.add(hash01(i, 0, 42));
    expect(values.size).toBeGreaterThan(50);
  });

  it('naturalBiomeColor is deterministic for the same inputs', () => {
    const a = naturalBiomeColor(FOREST, 0.5, 3, 4, 1234);
    const b = naturalBiomeColor(FOREST, 0.5, 3, 4, 1234);
    expect(a).toEqual(b);
  });

  it('same-biome cells vary — the fill is not flat', () => {
    const colors = new Set<string>();
    for (let i = 0; i < 64; i++) {
      const color = naturalBiomeColor(FOREST, 0.5, i % 8, Math.floor(i / 8), 1234);
      colors.add(`${color.r.toFixed(4)}|${color.g.toFixed(4)}|${color.b.toFixed(4)}`);
    }
    expect(colors.size).toBeGreaterThan(8);
  });

  it('variation stays TIGHT around the base — legend swatch comparable (±8%)', () => {
    const variation = theme.layerColors.biomeVariation;
    for (let i = 0; i < 200; i++) {
      const cx = i % 16;
      const cz = Math.floor(i / 16);
      for (const elevation of [0, 0.5, 1]) {
        const color = naturalBiomeColor(FOREST, elevation, cx, cz, 99, variation);
        // The map cell must stay within a narrow band of the base color so
        // the legend swatch (base) is always recognizable on the map.
        expect(Math.abs(color.r - FOREST.r)).toBeLessThan(0.08);
        expect(Math.abs(color.g - FOREST.g)).toBeLessThan(0.08);
        expect(Math.abs(color.b - FOREST.b)).toBeLessThan(0.08);
        expect(color.r).toBeGreaterThanOrEqual(0);
        expect(color.g).toBeGreaterThanOrEqual(0);
        expect(color.b).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('different seeds produce different patterns (seed-sensitive like the map)', () => {
    const a = naturalBiomeColor(FOREST, 0.5, 7, 9, 1);
    const b = naturalBiomeColor(FOREST, 0.5, 7, 9, 2);
    expect(a).not.toEqual(b);
  });
});

describe('central color definitions (renderer ⇄ legend single source)', () => {
  it('biomeBaseColor parses the theme hex exactly (sRGB roundtrip)', () => {
    const palette = theme.layerColors.biomes as Record<string, string>;
    for (const [biome, hex] of Object.entries(palette)) {
      expect(rgbToHex(biomeBaseColor(theme, biome))).toBe(hex.toLowerCase());
    }
  });

  it('rgbToHex inverts rgb() exactly for 8-bit sRGB colors', () => {
    for (const hex of ['#5e7d4a', '#a9ad6d', '#d3c092', '#000000', '#ffffff', '#f2c94c']) {
      expect(rgbToHex(rgb(hex))).toBe(hex.toLowerCase());
    }
  });
});

describe('the elevation gradient (blue → green → yellow → orange → red)', () => {
  it('is ONE simple continuous 5-stop ramp, low = blue, high = red', () => {
    const ramp = parseTerrainRamp(theme);
    expect(ramp.map((stop) => stop.at)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    const [blue, green, yellow, orange, red] = ramp.map((stop) => stop.color);
    // blue (lowest): clearly blue-dominant
    expect(blue.b).toBeGreaterThan(blue.g);
    expect(blue.g).toBeGreaterThan(blue.r);
    // green: green-dominant
    expect(green.g).toBeGreaterThan(green.r);
    expect(green.g).toBeGreaterThan(green.b);
    // yellow: warm, blue nearly gone
    expect(yellow.r).toBeGreaterThan(yellow.b);
    expect(yellow.g).toBeGreaterThan(yellow.b);
    // orange: red > green > blue
    expect(orange.r).toBeGreaterThan(orange.g);
    expect(orange.g).toBeGreaterThan(orange.b);
    // red (highest): red-dominant
    expect(red.r).toBeGreaterThan(red.g);
    expect(red.g).toBeGreaterThanOrEqual(red.b);
  });

  it('interpolates CONTINUOUSLY between stops (not discrete color buckets)', () => {
    const ramp = parseTerrainRamp(theme);
    // A sample between two stops is a genuine mix of its neighbours.
    const quarter = rampColorAt(ramp, 0.125);
    const blue = rampColorAt(ramp, 0);
    const green = rampColorAt(ramp, 0.25);
    expect(quarter.b).toBeGreaterThan(green.b); // still carries blue
    expect(quarter.g).toBeGreaterThan(blue.g); // already carries green
    expect(quarter.b).toBeLessThan(blue.b);
    // The blue channel NEVER rises as elevation grows — cold tones only at
    // the bottom, warm tones only at the top (linear-space monotonicity).
    const blueChannel = (elevation: number): number => rampColorAt(ramp, elevation).b;
    for (let i = 1; i <= 10; i++) {
      expect(blueChannel(i / 10)).toBeLessThanOrEqual(blueChannel((i - 1) / 10) + 1e-9);
    }
  });

  it('clamps below the first and above the last stop; deterministic', () => {
    const ramp = parseTerrainRamp(theme);
    expect(rampColorAt(ramp, -0.5)).toEqual(ramp[0].color);
    expect(rampColorAt(ramp, 1.5)).toEqual(ramp[ramp.length - 1].color);
    expect(rampColorAt(ramp, 0.42)).toEqual(rampColorAt(ramp, 0.42));
  });

  it('rampGradientStops samples THE SAME canonical function for the legend', () => {
    const ramp = parseTerrainRamp(theme);
    const stops = rampGradientStops(theme, 12);
    expect(stops.length).toBe(12);
    expect(stops[0].at).toBe(0);
    expect(stops[stops.length - 1].at).toBe(1);
    for (const stop of stops) {
      expect(stop.color).toBe(rgbToHex(rampColorAt(ramp, stop.at)));
    }
  });
});

describe('SurfaceLayer (exclusive surface colorings)', () => {
  it('biomes mode: ONE merged mesh covering exactly the land cells (9 sub-quads each)', () => {
    const { model } = generateStrategicMap(DEFAULT_MAP_CONFIG);
    const columns = DEFAULT_MAP_CONFIG.columns;
    const layer = new SurfaceLayer(columns);
    layer.setMode('biomes');
    layer.ensureBuilt(model, theme);
    const mesh = layer.group.children[0] as THREE.Mesh;
    const geometry = mesh.geometry as THREE.BufferGeometry;
    const attr = geometry.getAttribute('color') as THREE.BufferAttribute;
    const verticesPerCell = 9 /* sub-quads */ * 6 /* verts */;
    expect(attr.count / verticesPerCell).toBe(model.stats.landCells);
    layer.dispose();
  });

  it('biomes mode colors stay within ±8% of the biome base (legend match)', () => {
    const { model } = generateStrategicMap(DEFAULT_MAP_CONFIG);
    const columns = DEFAULT_MAP_CONFIG.columns;
    const layer = new SurfaceLayer(columns);
    layer.setMode('biomes');
    layer.ensureBuilt(model, theme);
    const mesh = layer.group.children[0] as THREE.Mesh;
    const attr = mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    let checked = 0;
    for (let cellIndex = 0; cellIndex < model.features.biomes.length && checked < 120; cellIndex++) {
      const biome = model.features.biomes[cellIndex];
      if (biome === 'ocean') continue;
      const base = biomeBaseColor(theme, biome);
      const offset = checked * 9 * 6 * 3; // 9 sub-quads × 6 verts × 3 floats
      expect(Math.abs(attr.array[offset] - base.r)).toBeLessThan(0.08);
      expect(Math.abs(attr.array[offset + 1] - base.g)).toBeLessThan(0.08);
      expect(Math.abs(attr.array[offset + 2] - base.b)).toBeLessThan(0.08);
      checked++;
    }
    layer.dispose();
  });

  it('terrain mode paints the ramp EXACTLY — color is a pure function of elevation (legend match)', () => {
    const { model } = generateStrategicMap(DEFAULT_MAP_CONFIG);
    const columns = DEFAULT_MAP_CONFIG.columns;
    const layer = new SurfaceLayer(columns);
    layer.setMode('terrain');
    layer.ensureBuilt(model, theme);
    const mesh = layer.group.children[0] as THREE.Mesh;
    const attr = mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    const ramp = parseTerrainRamp(theme);
    const heights = buildVertexElevationGrid(model, columns);
    const stride = columns + 1;
    const sampleHeight = (ch: number[], u: number, v: number): number => {
      const hTop = ch[0] + (ch[1] - ch[0]) * u;
      const hBottom = ch[3] + (ch[2] - ch[3]) * u;
      return hTop + (hBottom - hTop) * v;
    };
    // Replicate the renderer's color for the FIRST sub-quad of many cells
    // and require EXACT agreement (no shading may perturb the ramp color).
    let landIndex = 0;
    let checked = 0;
    for (
      let cellIndex = 0;
      cellIndex < model.features.biomes.length && checked < 40;
      cellIndex++
    ) {
      if (model.features.biomes[cellIndex] === 'ocean') continue;
      const cz = Math.floor(cellIndex / columns);
      const cx = cellIndex - cz * columns;
      const ch = [
        heights[cz * stride + cx],
        heights[cz * stride + cx + 1],
        heights[(cz + 1) * stride + cx + 1],
        heights[(cz + 1) * stride + cx]
      ];
      const mid = (sampleHeight(ch, 0, 0) + sampleHeight(ch, 1 / 3, 1 / 3)) / 2;
      const expected = rampColorAt(ramp, mid);
      const offset = (landIndex * 54 + 0) * 3; // cell 54 verts, sub-quad 0, vertex 0
      expect(Math.abs(attr.array[offset] - expected.r)).toBeLessThan(1e-5);
      expect(Math.abs(attr.array[offset + 1] - expected.g)).toBeLessThan(1e-5);
      expect(Math.abs(attr.array[offset + 2] - expected.b)).toBeLessThan(1e-5);
      landIndex++;
      checked++;
    }
    expect(checked).toBe(40);
    layer.dispose();
  });

  it('low ground is blue-ish, high ground red-ish — elevation reads at a glance', () => {
    const { model } = generateStrategicMap(DEFAULT_MAP_CONFIG);
    const columns = DEFAULT_MAP_CONFIG.columns;
    const layer = new SurfaceLayer(columns);
    layer.setMode('terrain');
    layer.ensureBuilt(model, theme);
    const mesh = layer.group.children[0] as THREE.Mesh;
    const attr = mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    let hasBlue = false;
    let hasRed = false;
    for (let vertex = 0; vertex < attr.count; vertex += 54) { // one vertex per cell
      const base = vertex * 3;
      const r = attr.array[base];
      const b = attr.array[base + 2];
      if (b > r + 0.15) hasBlue = true;
      if (r > b + 0.15) hasRed = true;
    }
    expect(hasBlue).toBe(true);
    expect(hasRed).toBe(true);
    layer.dispose();
  });

  it('mesh geometry is shared-safe: dispose clears GPU objects and rebuild works', () => {
    const { model } = generateStrategicMap(DEFAULT_MAP_CONFIG);
    const layer = new SurfaceLayer(DEFAULT_MAP_CONFIG.columns);
    layer.setMode('terrain');
    layer.ensureBuilt(model, theme);
    expect(layer.isBuilt).toBe(true);
    layer.dispose();
    expect(layer.isBuilt).toBe(false);
    expect(layer.group.children.length).toBe(0);
    layer.setMode('biomes');
    layer.ensureBuilt(model, theme);
    expect(layer.isBuilt).toBe(true);
    layer.dispose();
  });

  it('political mode builds nothing; surface plane constants stay shared', () => {
    const { model } = generateStrategicMap(DEFAULT_MAP_CONFIG);
    const layer = new SurfaceLayer(DEFAULT_MAP_CONFIG.columns);
    layer.setMode('political');
    layer.ensureBuilt(model, theme);
    expect(layer.isBuilt).toBe(false);
    expect(SURFACE_FILL_Y).toBe(0.7);
    expect(SURFACE_RELIEF_AMPLITUDE).toBeGreaterThan(0);
    layer.dispose();
  });
});
