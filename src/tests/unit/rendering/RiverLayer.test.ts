import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  RiverLayer,
  LakeLayer,
  riverWidthAt,
  buildRiverRibbons
} from '../../../rendering/map/FeatureLayers';
import { SURFACE_FILL_Y } from '../../../rendering/map/MapSurface';
import { generateStrategicMap } from '../../../world/map/MapGenerator';
import { DEFAULT_MAP_CONFIG } from '../../helpers/mapTestConfig';
import themeJson from '../../../data/mapTheme.json';
import type { MapThemeData } from '../../../data/types';

const theme = themeJson as unknown as MapThemeData;
const { model } = generateStrategicMap(DEFAULT_MAP_CONFIG);

/**
 * Water rendering: rivers are NATURAL ribbon meshes (tapering width,
 * continuous path, terrain-following height) — never 1-px artificial lines,
 * never part of the elevation gradient (water = water, terrain = elevation).
 */
describe('river ribbons (natural water in every surface mode)', () => {
  it('width grows from source to mouth, scaled by river length, and is capped', () => {
    const river = model.features.rivers.find((r) => r.cells.length >= 6);
    expect(river).toBeDefined();
    const width = theme.layerColors.riverWidth;
    const source = riverWidthAt(river!, 0, width);
    const mid = riverWidthAt(river!, 0.5, width);
    const mouth = riverWidthAt(river!, 1, width);
    expect(source).toBeCloseTo(width.source, 6);
    expect(mid).toBeGreaterThan(source);
    expect(mouth).toBeGreaterThan(mid);
    expect(mouth).toBeLessThanOrEqual(width.max);
    // Out-of-range t clamp into [0, 1].
    expect(riverWidthAt(river!, -2, width)).toBe(source);
    expect(riverWidthAt(river!, 3, width)).toBe(mouth);
  });

  it('ONE merged ribbon mesh (not LineSegments) with real width above the surface', () => {
    const layer = new RiverLayer(DEFAULT_MAP_CONFIG.columns, theme);
    layer.ensureBuilt(model);
    // The old artificial 1-px-line rendering produced LineSegments — rivers
    // must now be filled triangle ribbons.
    const lineObjects = layer.group.children.filter(
      (child) => (child as THREE.LineSegments).isLineSegments
    );
    expect(lineObjects).toHaveLength(0);
    const riverMesh = layer.group.children[0] as THREE.Mesh;
    expect(riverMesh?.isMesh).toBe(true);
    const geometry = riverMesh.geometry as THREE.BufferGeometry;
    // Merged: exactly (points − 1) segments × 6 vertices per river.
    const expectedVertices = model.features.rivers.reduce(
      (sum, river) => sum + (river.polyline.length - 1) * 6,
      0
    );
    const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
    expect(pos.count).toBe(expectedVertices);
    // Every vertex floats just above the surface plane (terrain-following).
    const array = pos.array as Float32Array;
    let minY = Infinity;
    for (let i = 1; i < array.length; i += 3) minY = Math.min(minY, array[i]);
    expect(minY).toBeGreaterThan(SURFACE_FILL_Y);
    // The ribbon has actual width: paired left/right vertices differ.
    let maxWidth = 0;
    for (let segment = 0; segment < pos.count; segment += 6) {
      const base = segment * 3;
      const dx = array[base] - array[base + 3];
      const dz = array[base + 2] - array[base + 5];
      maxWidth = Math.max(maxWidth, Math.hypot(dx, dz));
    }
    expect(maxWidth).toBeGreaterThan(0.3);
    layer.dispose();
  });

  it('builds deterministically (byte-identical geometry across builds)', () => {
    const a = buildRiverRibbons(model, DEFAULT_MAP_CONFIG.columns, theme);
    const b = buildRiverRibbons(model, DEFAULT_MAP_CONFIG.columns, theme);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    const pa = (a as THREE.BufferGeometry).getAttribute('position').array as Float32Array;
    const pb = (b as THREE.BufferGeometry).getAttribute('position').array as Float32Array;
    expect(pa.length).toBe(pb.length);
    for (let i = 0; i < pa.length; i++) expect(pa[i]).toBe(pb[i]);
  });

  it('lakes render as their own water layer, quads above the surface', () => {
    // Part 3: lakes are real MapLake records on a SEPARATE layer (Rivers
    // and Lakes/Water are independently togglable). Every lake cell quad
    // floats above the surface — never sunk into the relief.
    const layer = new LakeLayer(DEFAULT_MAP_CONFIG.columns, theme);
    layer.ensureBuilt(model);
    const lakeCellCount = model.features.lakes.reduce((sum, lake) => sum + lake.cells.length, 0);
    if (lakeCellCount === 0) {
      expect(layer.group.children.length).toBe(0);
      layer.dispose();
      return;
    }
    const lakeMesh = layer.group.children[0] as THREE.Mesh;
    expect(lakeMesh?.isMesh).toBe(true);
    const pos = lakeMesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    expect(pos.count).toBe(lakeCellCount * 6);
    const array = pos.array as Float32Array;
    for (let i = 1; i < array.length; i += 3) {
      expect(array[i]).toBeGreaterThan(SURFACE_FILL_Y);
    }
    layer.dispose();
  });

  it('rivers and lakes are SEPARATE layers (independent togglability)', () => {
    const rivers = new RiverLayer(DEFAULT_MAP_CONFIG.columns, theme);
    const lakes = new LakeLayer(DEFAULT_MAP_CONFIG.columns, theme);
    rivers.ensureBuilt(model);
    lakes.ensureBuilt(model);
    // Disposing one never touches the other (separate GPU state).
    lakes.dispose();
    expect(rivers.group.children.length).toBeGreaterThan(0);
    rivers.dispose();
  });
});
