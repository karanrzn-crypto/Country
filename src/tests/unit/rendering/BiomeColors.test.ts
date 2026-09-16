import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  naturalBiomeColor,
  hash01,
  createBiomeFillLayer,
  type RGB
} from '../../../rendering/map/FeatureLayers';
import { generateStrategicMap } from '../../../world/map/MapGenerator';
import { DEFAULT_MAP_CONFIG } from '../../helpers/mapTestConfig';
import themeJson from '../../../data/mapTheme.json';
import type { MapThemeData } from '../../../data/types';

/** Forest base (theme-like muted green) in LINEAR rgb — same space as rgb(). */
const FOREST: RGB = { r: 0.37, g: 0.49, b: 0.29 };

/**
 * Natural biome display (Part 4): deterministic variation — tonal patches,
 * per-cell jitter, elevation lightness. The map must read like a natural
 * geographic map (no flat fills, no neon), while the legend swatch (base
 * color) still matches what the map shows.
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

  it('same-biome cells vary — the fill is not flat anymore', () => {
    const colors = new Set<string>();
    for (let i = 0; i < 64; i++) {
      const color = naturalBiomeColor(FOREST, 0.5, i % 8, Math.floor(i / 8), 1234);
      colors.add(`${color.r.toFixed(4)}|${color.g.toFixed(4)}|${color.b.toFixed(4)}`);
    }
    // A flat fill would yield exactly one distinct color.
    expect(colors.size).toBeGreaterThan(8);
  });

  it('variation stays muted — every channel close to the base color', () => {
    const variation = { patchStrength: 0.055, cellJitter: 0.03, elevationLightness: 0.14 };
    for (let i = 0; i < 200; i++) {
      const cx = i % 16;
      const cz = Math.floor(i / 16);
      for (const elevation of [0, 0.5, 1]) {
        const color = naturalBiomeColor(FOREST, elevation, cx, cz, 99, variation);
        // Generous atlas-level bound: tone + jitter + elevation + warm/cool.
        expect(Math.abs(color.r - FOREST.r)).toBeLessThan(0.12);
        expect(Math.abs(color.g - FOREST.g)).toBeLessThan(0.12);
        expect(Math.abs(color.b - FOREST.b)).toBeLessThan(0.12);
        expect(color.r).toBeGreaterThanOrEqual(0);
        expect(color.g).toBeGreaterThanOrEqual(0);
        expect(color.b).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('higher elevation renders lighter (rocky/airy drift)', () => {
    const low = naturalBiomeColor(FOREST, 0, 5, 5, 42);
    const high = naturalBiomeColor(FOREST, 1, 5, 5, 42);
    expect(high.r).toBeGreaterThan(low.r);
    expect(high.g).toBeGreaterThan(low.g);
    expect(high.b).toBeGreaterThan(low.b);
  });

  it('different seeds produce different patterns (seed-sensitive like the map)', () => {
    const a = naturalBiomeColor(FOREST, 0.5, 7, 9, 1);
    const b = naturalBiomeColor(FOREST, 0.5, 7, 9, 2);
    expect(a).not.toEqual(b);
  });

  it('integrated: the biome fill mesh varies within each biome and skips ocean', () => {
    const theme = themeJson as unknown as MapThemeData;
    const { model } = generateStrategicMap(DEFAULT_MAP_CONFIG);
    const columns = DEFAULT_MAP_CONFIG.columns;
    const layer = createBiomeFillLayer(columns, theme);
    layer.ensureBuilt(model);
    const mesh = layer.group.children[0] as THREE.Mesh;
    const geometry = mesh.geometry as THREE.BufferGeometry;
    const attr = geometry.getAttribute('color') as THREE.BufferAttribute;

    // One merged cell-fill mesh: 2 triangles × 3 vertices per land cell —
    // ocean cells contribute nothing (they are skipped by the fill).
    const vertexPerCell = 6;
    const drawnCells = attr.count / vertexPerCell;
    expect(drawnCells).toBe(model.stats.landCells);

    // Re-derive each drawn cell's biome (fills emit land cells in index order).
    const drawnBiomes: string[] = [];
    for (let i = 0; i < model.features.biomes.length; i++) {
      if (model.features.biomes[i] !== 'ocean') drawnBiomes.push(model.features.biomes[i]);
    }
    expect(drawnBiomes.length).toBe(drawnCells);

    // Per-biome distinct tone sets — a flat fill would give exactly one.
    const tonesByBiome = new Map<string, Set<string>>();
    for (let cell = 0; cell < drawnCells; cell++) {
      const offset = cell * vertexPerCell * 3;
      const key = `${attr.array[offset].toFixed(4)},${attr.array[offset + 1].toFixed(4)},${attr.array[offset + 2].toFixed(4)}`;
      const biome = drawnBiomes[cell];
      let tones = tonesByBiome.get(biome);
      if (tones === undefined) {
        tones = new Set<string>();
        tonesByBiome.set(biome, tones);
      }
      tones.add(key);
    }
    const varied = [...tonesByBiome.entries()].filter(([biome, tones]) => {
      const cells = drawnBiomes.filter((b) => b === biome).length;
      return cells > 20 && tones.size > 1;
    });
    expect(varied.length).toBeGreaterThan(0);
    layer.dispose();
  });
});
