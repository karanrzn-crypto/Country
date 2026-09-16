import { describe, it, expect } from 'vitest';
import { generateStrategicMap } from '../../../../world/map/MapGenerator';
import { DEFAULT_MAP_CONFIG } from '../../../helpers/mapTestConfig';
import { pointInRing } from '../../../../world/map/MapQueries';
import { cellCornerPoints, classifyBiome, classifyTerrain } from '../../../../world/map/MapFeatures';
import type { MapLineFeature } from '../../../../world/map/MapTypes';

/**
 * Map features (Part 3): biomes/terrain/rivers/roads/sites — all generated
 * once per seed, deterministic, and consistent with the political geometry
 * (single source of truth: every site inside its country ring, roads connect
 * every city, railways connect every capital).
 */
describe('map features generation', () => {
  const { model } = generateStrategicMap(DEFAULT_MAP_CONFIG);
  const features = model.features;
  const columns = DEFAULT_MAP_CONFIG.columns;
  const cellCount = columns * DEFAULT_MAP_CONFIG.rows;

  it('deterministic: the same config produces byte-identical features', () => {
    const second = generateStrategicMap(DEFAULT_MAP_CONFIG).model.features;
    expect(JSON.stringify(second)).toBe(JSON.stringify(features));
  });

  it('covers every cell with classification fields in range', () => {
    expect(features.biomes.length).toBe(cellCount);
    expect(features.terrain.length).toBe(cellCount);
    expect(features.cellOwner.length).toBe(cellCount);
    expect(features.elevation.length).toBe(cellCount);
    expect(features.temperature.length).toBe(cellCount);
    for (let i = 0; i < cellCount; i++) {
      const value = features.elevation[i];
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
      const temp = features.temperature[i];
      expect(temp).toBeGreaterThanOrEqual(0);
      expect(temp).toBeLessThanOrEqual(1);
    }
  });

  it('classifies every cell: ocean cells owned by nobody, land by a country', () => {
    const countryCount = model.stats.countries;
    let landCells = 0;
    for (let i = 0; i < cellCount; i++) {
      const ocean = features.biomes[i] === 'ocean';
      const owner = features.cellOwner[i];
      expect(ocean).toBe(owner < 0);
      if (!ocean) {
        landCells++;
        expect(owner).toBeGreaterThanOrEqual(0);
        expect(owner).toBeLessThan(countryCount);
      }
    }
    expect(landCells).toBe(model.stats.landCells);
  });

  it('produces a plausible biome mix across the continent', () => {
    const seen = new Set(features.biomes);
    expect(seen.has('ocean')).toBe(true);
    // The generator's noise guarantees several land biomes on the default map.
    const landBiomes = [...seen].filter((biome) => biome !== 'ocean');
    expect(landBiomes.length).toBeGreaterThanOrEqual(3);
    for (const biome of landBiomes) {
      expect(['forest', 'grassland', 'desert', 'tundra', 'drylands', 'jungle']).toContain(biome);
    }
  });

  it('classification helpers honor their documented thresholds', () => {
    expect(classifyTerrain(0.95, 0)).toBe('highMountain');
    expect(classifyTerrain(0.8, 0.3)).toBe('mountain');
    // Elevated + FLAT ground reads as a plateau even below the mountain band.
    expect(classifyTerrain(0.6, 0.02)).toBe('plateau');
    // Same elevation with rugged neighbors is hills.
    expect(classifyTerrain(0.6, 0.3)).toBe('hills');
    expect(classifyTerrain(0.4, 0.1)).toBe('plains');
    expect(classifyTerrain(0.25, 0.1)).toBe('valley');
    expect(classifyTerrain(0.1, 0.05)).toBe('lowland');
    expect(classifyBiome(0.1, 0.8)).toBe('tundra');
    expect(classifyBiome(0.9, 0.1)).toBe('desert');
    expect(classifyBiome(0.3, 0.1)).toBe('drylands');
    expect(classifyBiome(0.8, 0.8)).toBe('jungle');
    expect(classifyBiome(0.3, 0.8)).toBe('forest');
    expect(classifyBiome(0.5, 0.5)).toBe('grassland');
  });

  it('the default map exhibits every terrain class (relief is informative)', () => {
    const landTerrain = new Set<string>();
    for (let i = 0; i < cellCount; i++) {
      if (features.biomes[i] !== 'ocean') landTerrain.add(features.terrain[i]);
    }
    for (const terrainClass of [
      'lowland', 'valley', 'plains', 'plateau', 'hills', 'mountain', 'highMountain'
    ]) {
      expect(landTerrain.has(terrainClass)).toBe(true);
    }
  });

  it('rivers start on land and end at the coast, a lake, or a parent river', () => {
    expect(features.rivers.length).toBeGreaterThan(0);
    for (const river of features.rivers) {
      expect(river.polyline.length).toBeGreaterThanOrEqual(2);
      expect(river.cells.length).toBe(river.polyline.length);
      for (const cellIndex of river.cells) {
        expect(features.biomes[cellIndex]).not.toBe('ocean');
      }
      if (river.mouthType === 'lake') {
        // Inland basin: the mouth cell must belong to a real lake record.
        const inSomeLake = features.lakes.some((lake) => lake.cells.includes(river.mouthCell as number));
        expect(inSomeLake).toBe(true);
      }
      if (river.mouthType === 'river') {
        // Tributary: the confluence cell lies on the PARENT's path.
        const parent = features.rivers.find((candidate) => candidate.id === river.parentRiverId);
        expect(parent).toBeDefined();
        expect(parent?.cells.includes(river.mouthCell as number)).toBe(true);
        // Confluence geometry is continuous: the tributary's last polyline
        // point IS the parent's point at the confluence cell.
        const confluenceIndex = parent?.cells.indexOf(river.mouthCell as number) ?? -1;
        expect(river.polyline[river.polyline.length - 1]).toEqual(parent?.polyline[confluenceIndex]);
      }
    }
  });

  it('roads form a connected network over ALL cities (spanning tree)', () => {
    const roads = features.lines.filter((line) => line.kind !== 'railway' && line.kind !== 'seaRoute');
    const cityIds = Object.keys(model.cities);
    expect(roads.length).toBe(cityIds.length - 1); // tree over n nodes
    const parent = new Map<string, string>(cityIds.map((id) => [id, id]));
    const find = (id: string): string => {
      let root = id;
      while (parent.get(root) !== root) root = parent.get(root) as string;
      return root;
    };
    for (const road of roads as readonly MapLineFeature[]) {
      expect(road.cityA).not.toBeNull();
      expect(road.cityB).not.toBeNull();
      expect(['highway', 'secondary', 'dirt']).toContain(road.kind);
      const ra = find(road.cityA as string);
      const rb = find(road.cityB as string);
      if (ra !== rb) parent.set(ra, rb);
    }
    const components = new Set(cityIds.map(find));
    expect(components.size).toBe(1);
  });

  it('railways connect every capital; sea routes link different countries', () => {
    const capitals = Object.values(model.cities).filter((city) => city.isCapital);
    const railways = features.lines.filter((line) => line.kind === 'railway');
    expect(railways.length).toBe(capitals.length - 1);
    const parent = new Map(capitals.map((city) => [city.id, city.id]));
    const find = (id: string): string => {
      let root = id;
      while (parent.get(root) !== root) root = parent.get(root) as string;
      return root;
    };
    for (const rail of railways) {
      const ra = find(rail.cityA as string);
      const rb = find(rail.cityB as string);
      if (ra !== rb) parent.set(ra, rb);
    }
    expect(new Set(capitals.map((city) => find(city.id))).size).toBe(1);

    for (const route of features.lines.filter((line) => line.kind === 'seaRoute')) {
      const a = model.cities[route.cityA as string];
      const b = model.cities[route.cityB as string];
      expect(a.countryId).not.toBe(b.countryId);
    }
  });

  it('sites: every site inside its own country, kinds valid, every country supplied', () => {
    expect(features.sites.length).toBeGreaterThan(0);
    for (const site of features.sites) {
      expect(['port', 'farm', 'factory', 'mine', 'oil', 'airbase', 'base']).toContain(site.kind);
      const country = model.countries[site.countryId];
      expect(country).toBeDefined();
      expect(pointInRing(site.position, country.ring.points)).toBe(true);
      if (site.kind === 'mine' || site.kind === 'oil') {
        expect(site.resourceId).not.toBeNull();
        expect(['iron', 'coal', 'gold', 'oil']).toContain(site.resourceId);
      }
    }
    // Military infrastructure for every country; extractive resources too.
    const byCountry = new Map<string, number>();
    for (const site of features.sites) {
      byCountry.set(site.countryId, (byCountry.get(site.countryId) ?? 0) + 1);
    }
    for (const countryId of model.countryOrder) {
      expect(byCountry.get(countryId) ?? 0).toBeGreaterThanOrEqual(2);
    }
  });

  it('ports sit in coastal countries at coastal cities', () => {
    for (const port of features.sites.filter((site) => site.kind === 'port')) {
      expect(model.countries[port.countryId].coastal).toBe(true);
      expect(port.cityId).not.toBeNull();
    }
  });

  it('cell fills reference real lattice corners (geometry contract)', () => {
    const [nw, ne, se, sw] = cellCornerPoints(0, model.lattice, columns);
    expect(nw).toBeDefined();
    expect(ne).toBeDefined();
    expect(se).toBeDefined();
    expect(sw).toBeDefined();
    // NW sits above-left of SE in world space.
    expect(nw.x).toBeLessThan(se.x);
    expect(nw.z).toBeLessThan(se.z);
    expect(nw.z).toBeCloseTo(ne.z, 5);
    expect(nw.x).toBeCloseTo(sw.x, 5);
  });

  it('deterministic across a different seed (no cross-seed leakage)', () => {
    const other = generateStrategicMap({ ...DEFAULT_MAP_CONFIG, seed: DEFAULT_MAP_CONFIG.seed + 1 });
    expect(JSON.stringify(other.model.features.biomes)).not.toBe(JSON.stringify(features.biomes));
  });
});
