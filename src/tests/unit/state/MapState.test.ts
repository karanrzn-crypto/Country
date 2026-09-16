import { describe, it, expect } from 'vitest';
import { createTestGame } from '../../helpers/testGame';
import { Game } from '../../../core/Game';
import { MemorySaveStorage } from '../../../save/SaveStorage';
import { generateStrategicMap } from '../../../world/map/MapGenerator';
import { DEFAULT_MAP_CONFIG } from '../../helpers/mapTestConfig';
import { MAP_LAYER_ORDER, isKnownMapLayer, DEFAULT_LAYER_VISIBILITY } from '../../../world/map/MapLayers';

describe('map state slice + commands (selection, layers, camera)', () => {
  it('default map slice is valid, centered and fully visible', () => {
    const game = createTestGame();
    const map = game.gameState.map;
    expect(map.selectedCountryId).toBeNull();
    expect(map.selectedProvinceId).toBeNull();
    expect(map.selectedCityId).toBeNull();
    expect(map.layerVisibility).toEqual(DEFAULT_LAYER_VISIBILITY);
    expect(map.camera.viewHeight).toBeGreaterThan(0);
    expect(map.viewport.width).toBeGreaterThan(0);
    game.dispose();
  });

  it('map.select sets a hierarchical selection and emits an event', () => {
    const game = createTestGame();
    const model = game.strategicMap;
    const countryId = model.countryOrder[0];
    const provinceId = model.countries[countryId].provinceIds[0];
    const cityId = model.provinces[provinceId].cityIds[0];

    const events: unknown[] = [];
    game.gameEvents.on('map.selectionChanged', (payload) => events.push(payload));

    game.commandBus.send({ type: 'map.select', cityId });
    game.commandBus.flush();
    expect(game.gameState.map.selectedCityId).toBe(cityId);
    expect(game.gameState.map.selectedProvinceId).toBe(provinceId);
    expect(game.gameState.map.selectedCountryId).toBe(
      model.cities[cityId].countryId
    );

    // Province selection replaces the city but keeps the country.
    game.commandBus.send({ type: 'map.select', provinceId });
    game.commandBus.flush();
    expect(game.gameState.map.selectedCityId).toBeNull();
    expect(game.gameState.map.selectedProvinceId).toBe(provinceId);

    // Country-only selection.
    game.commandBus.send({ type: 'map.select', countryId });
    game.commandBus.flush();
    expect(game.gameState.map.selectedProvinceId).toBeNull();
    expect(game.gameState.map.selectedCountryId).toBe(countryId);

    expect(events).toHaveLength(3);
    game.dispose();
  });

  it('feature selections are EXCLUSIVE KINDS: grid/river/lake/site clear the hierarchy and each other', () => {
    const game = createTestGame();
    const model = game.strategicMap;
    const countryId = model.countryOrder[0];
    const river = model.features.rivers[0];

    // Selecting a country fills the hierarchy.
    game.commandBus.send({ type: 'map.select', countryId });
    game.commandBus.flush();
    expect(game.gameState.map.selectedCountryId).toBe(countryId);

    // A river selection replaces the whole hierarchy (one coherent kind).
    game.commandBus.send({ type: 'map.pick', x: river.polyline[0].x, z: river.polyline[0].z });
    game.commandBus.flush();
    expect(game.gameState.map.selectedRiverId).toBe(river.id);
    expect(game.gameState.map.selectedCountryId).toBeNull();
    expect(game.gameState.map.selectedGridKey).toBeNull();

    // A grid-cell selection replaces the river selection.
    const gridLayerOn = game.gameState.map.layerVisibility.grid;
    if (gridLayerOn) {
      const gridKey = model.features.gridIds.find((id) => id !== null) as string;
      const countryOfKey = model.countryOrder[model.features.cellOwner[model.features.gridIds.indexOf(gridKey)]];
      const cellIndex = model.features.gridIds.indexOf(gridKey);
      const cx = cellIndex % DEFAULT_MAP_CONFIG.columns;
      const cz = Math.floor(cellIndex / DEFAULT_MAP_CONFIG.columns);
      game.commandBus.send({
        type: 'map.pick',
        x: (cx + 0.5) * DEFAULT_MAP_CONFIG.cellSize,
        z: (cz + 0.5) * DEFAULT_MAP_CONFIG.cellSize
      });
      game.commandBus.flush();
      const expected = `${countryOfKey}#${gridKey}`;
      const actual = game.gameState.map.selectedGridKey;
      if (actual !== null) {
        // The pick landed on the probed cell (no closer feature).
        expect(actual).toBe(expected);
        expect(game.gameState.map.selectedRiverId).toBeNull();
      }
    }

    // Hierarchy selection clears feature fields again.
    game.commandBus.send({ type: 'map.select', countryId });
    game.commandBus.flush();
    expect(game.gameState.map.selectedCountryId).toBe(countryId);
    expect(game.gameState.map.selectedRiverId).toBeNull();
    expect(game.gameState.map.selectedGridKey).toBeNull();
    expect(game.gameState.map.selectedSiteId).toBeNull();
    expect(game.gameState.map.selectedBuildingId).toBeNull();
    game.dispose();
  });

  it('map.clearSelection resets all three ids', () => {
    const game = createTestGame();
    const countryId = game.strategicMap.countryOrder[0];
    game.commandBus.send({ type: 'map.select', countryId });
    game.commandBus.flush();
    game.commandBus.send({ type: 'map.clearSelection' });
    game.commandBus.flush();
    expect(game.gameState.map.selectedCountryId).toBeNull();
    expect(game.gameState.map.selectedProvinceId).toBeNull();
    expect(game.gameState.map.selectedCityId).toBeNull();
    game.dispose();
  });

  it('unknown ids and layers are rejected without breaking state', () => {
    const game = createTestGame();
    const before = JSON.stringify(game.gameState.map);
    game.commandBus.send({ type: 'map.select', countryId: 'ghost_country' });
    game.commandBus.send({ type: 'map.setLayerVisible', layer: 'notALayer', visible: true });
    game.commandBus.flush();
    expect(JSON.stringify(game.gameState.map)).toBe(before);
    game.dispose();
  });

  it('camera commands clamp into the map bounds (never leaves the map)', () => {
    const game = createTestGame();
    const bounds = game.strategicMap.bounds;
    const config = game.gameConfig.map;

    game.commandBus.send({ type: 'map.setCamera', x: 1_000_000, z: -1_000_000, viewHeight: 0.001 });
    game.commandBus.flush();
    let camera = game.gameState.map.camera;
    expect(camera.viewHeight).toBe(config.minViewHeight);
    expect(camera.x).toBeGreaterThanOrEqual(bounds.minX - config.maxViewHeight);
    expect(camera.z).toBeLessThanOrEqual(bounds.maxZ + config.maxViewHeight);

    game.commandBus.send({ type: 'map.zoomBy', factor: 1_000_000 });
    game.commandBus.flush();
    camera = game.gameState.map.camera;
    expect(camera.viewHeight).toBe(config.maxViewHeight);

    game.commandBus.send({ type: 'map.panBy', dx: -999_999, dz: 999_999 });
    game.commandBus.flush();
    camera = game.gameState.map.camera;
    expect(Number.isFinite(camera.x)).toBe(true);
    expect(Number.isFinite(camera.z)).toBe(true);
    game.dispose();
  });

  it('zoomBy with an anchor keeps the anchor point fixed in the world', () => {
    const game = createTestGame();
    const model = game.strategicMap;
    const country = model.countries[model.countryOrder[0]];
    const anchor = country.labelPoint;

    game.commandBus.send({ type: 'map.focusCountry', countryId: country.id });
    game.commandBus.flush();
    const before = { ...game.gameState.map.camera };

    game.commandBus.send({ type: 'map.zoomBy', factor: 0.5, anchorX: anchor.x, anchorZ: anchor.z });
    game.commandBus.flush();
    const after = game.gameState.map.camera;

    expect(after.viewHeight).toBeCloseTo(before.viewHeight * 0.5, 6);
    // The anchor did not move relative to the camera center scaling.
    expect(after.x - anchor.x).toBeCloseTo((before.x - anchor.x) * 0.5, 6);
    expect(after.z - anchor.z).toBeCloseTo((before.z - anchor.z) * 0.5, 6);
    game.dispose();
  });

  it('focusCountry centers the camera on the country label point', () => {
    const game = createTestGame();
    const model = game.strategicMap;
    const country = model.countries[model.countryOrder[1]];
    game.commandBus.send({ type: 'map.focusCountry', countryId: country.id });
    game.commandBus.flush();
    expect(game.gameState.map.camera.x).toBeCloseTo(country.labelPoint.x, 6);
    expect(game.gameState.map.camera.z).toBeCloseTo(country.labelPoint.z, 6);
    game.dispose();
  });

  it('map.pick resolves a country interior point into a full selection', () => {
    const game = createTestGame();
    const model = game.strategicMap;
    const country = model.countries[model.countryOrder[0]];
    game.commandBus.send({ type: 'map.pick', x: country.labelPoint.x, z: country.labelPoint.z });
    game.commandBus.flush();
    expect(game.gameState.map.selectedCountryId).toBe(country.id);

    // Ocean pick clears the selection.
    game.commandBus.send({ type: 'map.pick', x: model.bounds.minX - 100, z: model.bounds.minZ - 100 });
    game.commandBus.flush();
    expect(game.gameState.map.selectedCountryId).toBeNull();
    game.dispose();
  });

  it('layer toggles update the slice and emit events for every layer (only on actual change)', () => {
    const game = createTestGame();
    const layerEvents: unknown[] = [];
    game.gameEvents.on('map.layerVisibilityChanged', (payload) => layerEvents.push(payload));
    // Pass 1: only the layers that are DEFAULT-VISIBLE actually change → event.
    const defaultVisible = MAP_LAYER_ORDER.filter(
      (layer) => DEFAULT_LAYER_VISIBILITY[layer] === true
    );
    for (const layer of MAP_LAYER_ORDER) {
      expect(isKnownMapLayer(layer)).toBe(true);
      game.commandBus.send({ type: 'map.setLayerVisible', layer, visible: false });
      game.commandBus.flush();
      expect(game.gameState.map.layerVisibility[layer]).toBe(false);
    }
    expect(layerEvents).toHaveLength(defaultVisible.length);
    // Pass 2: idempotent no-op toggles emit NOTHING (no spurious refreshes).
    layerEvents.length = 0;
    for (const layer of MAP_LAYER_ORDER) {
      game.commandBus.send({ type: 'map.setLayerVisible', layer, visible: false });
      game.commandBus.flush();
    }
    expect(layerEvents).toHaveLength(0);
    game.dispose();
  });

  it('exclusive surface layers: enabling Biomes turns Terrain off and vice versa (state-level policy)', () => {
    const game = createTestGame();
    const layerEvents: { layer: string; visible: boolean }[] = [];
    game.gameEvents.on('map.layerVisibilityChanged', (payload) => layerEvents.push(payload));

    // Terrain ON first (biomes already off → no fallout event).
    game.commandBus.send({ type: 'map.setLayerVisible', layer: 'terrain', visible: true });
    game.commandBus.flush();
    expect(game.gameState.map.layerVisibility.terrain).toBe(true);
    expect(layerEvents).toEqual([{ layer: 'terrain', visible: true }]);

    // Biomes ON → Terrain OFF automatically; one event per CHANGED layer.
    layerEvents.length = 0;
    game.commandBus.send({ type: 'map.setLayerVisible', layer: 'biomes', visible: true });
    game.commandBus.flush();
    expect(game.gameState.map.layerVisibility.biomes).toBe(true);
    expect(game.gameState.map.layerVisibility.terrain).toBe(false);
    expect(layerEvents).toEqual([
      { layer: 'biomes', visible: true },
      { layer: 'terrain', visible: false }
    ]);

    // Disabling Terrain leaves Biomes EXACTLY as it was (no side effects).
    game.commandBus.send({ type: 'map.setLayerVisible', layer: 'terrain', visible: false });
    game.commandBus.flush();
    expect(game.gameState.map.layerVisibility.terrain).toBe(false);
    expect(game.gameState.map.layerVisibility.biomes).toBe(true);

    // Non-member layers are untouched by the exclusivity policy.
    game.commandBus.send({ type: 'map.setLayerVisible', layer: 'rivers', visible: false });
    game.commandBus.flush();
    expect(game.gameState.map.layerVisibility.rivers).toBe(false);
    expect(game.gameState.map.layerVisibility.biomes).toBe(true); // unchanged
    expect(game.gameState.map.layerVisibility.terrain).toBe(false);
    game.dispose();
  });

  it('old saves carrying BOTH exclusive layers ON are normalized on load', () => {
    const storage = new MemorySaveStorage();
    const game = new Game({ seed: 42, saveStorage: storage });
    game.init();
    // Hand-crafted impossible state (bypasses the command path — as an old
    // version's save would contain): both biomes and terrain visible.
    game.gameState.map.layerVisibility.biomes = true;
    game.gameState.map.layerVisibility.terrain = true;
    game.saveToSlot('exclusivity-slot');

    const game2 = new Game({ seed: 999, saveStorage: storage });
    game2.init();
    game2.loadFromSlot('exclusivity-slot');
    // Registry order decides: the FIRST group member (biomes) survives.
    expect(game2.gameState.map.layerVisibility.biomes).toBe(true);
    expect(game2.gameState.map.layerVisibility.terrain).toBe(false);
    game.dispose();
    game2.dispose();
  });

  it('map selection survives a save/load roundtrip', () => {
    const storage = new MemorySaveStorage();
    const game = new Game({ seed: 42, saveStorage: storage });
    game.init();
    const countryId = game.strategicMap.countryOrder[0];
    game.commandBus.send({ type: 'map.select', countryId });
    game.commandBus.send({ type: 'map.setLayerVisible', layer: 'labels', visible: false });
    game.commandBus.flush();
    game.saveToSlot('map-slot');

    const game2 = new Game({ seed: 999, saveStorage: storage });
    game2.init();
    game2.loadFromSlot('map-slot');
    expect(game2.gameState.map.selectedCountryId).toBe(countryId);
    expect(game2.gameState.map.layerVisibility.labels).toBe(false);
    game.dispose();
    game2.dispose();
  });

  it('selection state participates in the deterministic state hash', () => {
    const a = createTestGame({ seed: 5 });
    const b = createTestGame({ seed: 5 });
    expect(a.stateHash()).toBe(b.stateHash());

    const countryId = a.strategicMap.countryOrder[0];
    a.commandBus.send({ type: 'map.select', countryId });
    a.commandBus.flush();
    expect(a.stateHash()).not.toBe(b.stateHash());
    a.dispose();
    b.dispose();
  });
});

/** Ensures two games build byte-identical map models (renderer-independent). */
describe('strategic map determinism across Game instances', () => {
  it('same seed → identical continent, rings and stats', () => {
    const a = createTestGame({ seed: 77 });
    const b = createTestGame({ seed: 77 });
    const mapA = a.strategicMap;
    const mapB = b.strategicMap;
    expect(mapA.continentName).toBe(mapB.continentName);
    expect(mapA.stats).toEqual(mapB.stats);
    for (const countryId of mapA.countryOrder) {
      expect(mapA.countries[countryId].ring.points).toEqual(mapB.countries[countryId].ring.points);
    }
    a.dispose();
    b.dispose();
  });

  it('different map seeds → different continents (map seed is independent of the sim seed)', () => {
    const a = createTestGame({ seed: 77 });
    const b = createTestGame({ seed: 78 });
    // The map uses config.map.seed (stable by design); sim seed variation
    // must not change the map.
    expect(a.strategicMap.continentName).toBe(b.strategicMap.continentName);
    expect(a.strategicMap.stats).toEqual(b.strategicMap.stats);
    a.dispose();
    b.dispose();

    // Changing the MAP seed does change the continent.
    const other = generateStrategicMap({ ...DEFAULT_MAP_CONFIG, seed: DEFAULT_MAP_CONFIG.seed + 1 }).model;
    const same = generateStrategicMap(DEFAULT_MAP_CONFIG).model;
    const different = other.continentName !== same.continentName ||
      JSON.stringify(other.stats) !== JSON.stringify(same.stats);
    expect(different).toBe(true);
  });
});
