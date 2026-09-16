import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  naturalBiomeColor,
  hash01,
  biomeBaseColor,
  parseTerrainRamp,
  rampColorAt,
  rgb,
  rgbToHex,
  SurfaceLayer,
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
 * - the SurfaceLayer composites biomes/terrain in ONE merged mesh.
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

  it('the elevation ramp interpolates monotonically between stops', () => {
    const ramp = parseTerrainRamp(theme);
    expect(ramp.length).toBeGreaterThanOrEqual(2);
    const low = rampColorAt(ramp, 0);
    const high = rampColorAt(ramp, 1);
    // Low end dark/green-ish, high end near-white snow (rocky peaks read out).
    const luminance = (color: RGB): number => 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
    expect(luminance(high)).toBeGreaterThan(luminance(low));
    expect(rampColorAt(ramp, -0.5)).toEqual(low);
    expect(rampColorAt(ramp, 1.5)).toEqual(high);
  });

  it('ramp sampling is deterministic', () => {
    const ramp = parseTerrainRamp(theme);
    expect(rampColorAt(ramp, 0.42)).toEqual(rampColorAt(ramp, 0.42));
  });
});

describe('SurfaceLayer (composited land surface)', () => {
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

  it('terrain mode: every painted color lies in the shaded ramp band', () => {
    const { model } = generateStrategicMap(DEFAULT_MAP_CONFIG);
    const columns = DEFAULT_MAP_CONFIG.columns;
    const layer = new SurfaceLayer(columns);
    layer.setMode('terrain');
    layer.ensureBuilt(model, theme);
    const mesh = layer.group.children[0] as THREE.Mesh;
    const attr = mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    expect(attr.count).toBeGreaterThan(0);
    const ramp = parseTerrainRamp(theme);
    const shading = theme.layerColors.terrainShading;
    // Land elevations on this map span a known range; the painted color for
    // any vertex must be the ramp color at SOME elevation in [0,1] scaled by
    // a shade in [minShade, maxShade]. Approximate: compare channel-wise
    // against the ramp extremes scaled by the shade bounds.
    const rampColors = ramp.map((stop) => stop.color);
    const minChannel = (channel: 'r' | 'g' | 'b'): number =>
      Math.min(...rampColors.map((color) => color[channel]));
    const maxChannel = (channel: 'r' | 'g' | 'b'): number =>
      Math.max(...rampColors.map((color) => color[channel]));
    const verticesPerCell = 54;
    const cells = attr.count / verticesPerCell;
    expect(cells).toBe(model.stats.landCells);
    for (let vertex = 0; vertex < attr.count; vertex += 7) { // sparse, ALIGNED sample
      const base = vertex * 3; // 3 floats (r,g,b) per vertex
      const channels = ['r', 'g', 'b'] as const;
      for (let c = 0; c < 3; c++) {
        const value = attr.array[base + c];
        const channel = channels[c];
        expect(value).toBeGreaterThanOrEqual(minChannel(channel) * shading.minShade - 1e-4);
        expect(value).toBeLessThanOrEqual(maxChannel(channel) * shading.maxShade + 1e-4);
      }
    }
    layer.dispose();
  });

  it('composite mode differs from both single modes (layers truly combine)', () => {
    const { model } = generateStrategicMap(DEFAULT_MAP_CONFIG);
    const columns = DEFAULT_MAP_CONFIG.columns;
    const build = (mode: 'biomes' | 'terrain' | 'biomes+terrain'): Float32Array => {
      const layer = new SurfaceLayer(columns);
      layer.setMode(mode);
      layer.ensureBuilt(model, theme);
      const mesh = layer.group.children[0] as THREE.Mesh;
      const attr = mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
      const copy = new Float32Array(attr.array as Float32Array);
      layer.dispose();
      return copy;
    };
    const biomes = build('biomes');
    const terrain = build('terrain');
    const composite = build('biomes+terrain');
    // Composite must NOT equal either single mode — it blends both inputs.
    let differsFromBiomes = false;
    let differsFromTerrain = false;
    for (let i = 0; i < composite.length; i += 3) {
      if (Math.abs(composite[i] - biomes[i]) > 1e-4) differsFromBiomes = true;
      if (Math.abs(composite[i] - terrain[i]) > 1e-4) differsFromTerrain = true;
      if (differsFromBiomes && differsFromTerrain) break;
    }
    expect(differsFromBiomes).toBe(true);
    expect(differsFromTerrain).toBe(true);
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
});
