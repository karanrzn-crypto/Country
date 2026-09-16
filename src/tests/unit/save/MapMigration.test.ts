import { describe, it, expect } from 'vitest';
import { Game } from '../../../core/Game';
import { MemorySaveStorage } from '../../../save/SaveStorage';
import { applyMigrations } from '../../../save/migrations';
import { SAVE_VERSION } from '../../../save/SaveTypes';
import { fnv1a32, stableStringify } from '../../../utils/hash';

/**
 * Save migrations:
 * - v1 → v2: strategic map slice (Part 1)
 * - v2 → v3: country data slice (Part 2)
 * Old saves must keep loading; nothing is destroyed.
 */
describe('save migrations (v1 → v2 → v3)', () => {
  const v1 = {
    state: {
      world: { worldId: 'demo-country' },
      player: { countryId: 'republic', mode: null, focusChunkId: null, selection: [] },
      economy: { treasury: { republic: 10_000 } }
    },
    runtime: { tick: 12, rngState: 99, ids: { counters: {} } }
  };

  it('v1 → current injects the default map slice AND the country slice', () => {
    const { data, version } = applyMigrations(v1, 1, SAVE_VERSION);
    expect(version).toBe(3);
    const migrated = data as typeof v1 & {
      state: { map?: Record<string, unknown>; countries?: Record<string, unknown> };
    };
    expect(migrated.state.map).toBeDefined();
    expect(migrated.state.map?.selectedCountryId).toBeNull();
    expect(migrated.state.map?.layerVisibility).toBeDefined();
    expect(migrated.state.map?.camera).toBeDefined();
    // Part 2: country slice present with complete per-country data.
    expect(migrated.state.countries).toBeDefined();
    const countries = migrated.state.countries?.countries as Record<string, Record<string, unknown>>;
    expect(Object.keys(countries).length).toBeGreaterThanOrEqual(10);
    for (const state of Object.values(countries)) {
      expect(state.population).toBeGreaterThanOrEqual(0);
      expect(state.economy).toBeDefined();
      expect(state.military).toBeDefined();
      expect(state.flag).toBeDefined();
    }
    // Original fields untouched (no destructive migration).
    expect(migrated.state.player.countryId).toBe('republic');
    expect(migrated.runtime.tick).toBe(12);
  });

  it('v2 → v3 injects only the country slice (map state untouched)', () => {
    const v2 = {
      state: {
        a: 1,
        map: { selectedCountryId: 'country_3', camera: { x: 1, z: 2, viewHeight: 50 } }
      },
      runtime: { tick: 5 }
    };
    const { data, version } = applyMigrations(v2, 2, SAVE_VERSION);
    expect(version).toBe(3);
    const migrated = data as { state: Record<string, unknown> };
    expect(migrated.state.a).toBe(1);
    expect((migrated.state.map as Record<string, unknown>).selectedCountryId).toBe('country_3');
    expect(migrated.state.countries).toBeDefined();
    expect(Object.keys(migrated.state).sort()).toEqual(['a', 'countries', 'map'].sort());
  });

  it('a migrated v1 state gains a schema-valid map slice (explicit v1→v2 stop)', () => {
    const { data } = applyMigrations(v1, 1, 2);
    const migrated = data as { state: Record<string, unknown> };
    expect(migrated.state.map).toBeDefined();
    const map = migrated.state.map as Record<string, unknown>;
    expect(Object.keys(map).sort()).toEqual(
      ['camera', 'layerVisibility', 'selectedCityId', 'selectedCountryId', 'selectedProvinceId', 'viewport'].sort()
    );
    expect(() => fnv1a32(stableStringify(migrated))).not.toThrow();
  });

  it('current-version saves load with full map selection + country data', () => {
    const storage = new MemorySaveStorage();
    const game = new Game({ seed: 31337, saveStorage: storage });
    game.init();
    const countryId = game.strategicMap.countryOrder[0];
    game.commandBus.send({ type: 'map.select', countryId });
    game.commandBus.send({ type: 'map.setCamera', x: 100, z: 80, viewHeight: 55 });
    game.commandBus.flush();
    game.saveToSlot('v3-slot');

    const game2 = new Game({ seed: 1, saveStorage: storage });
    game2.init();
    game2.loadFromSlot('v3-slot');
    expect(game2.gameState.map.selectedCountryId).toBe(countryId);
    expect(game2.gameState.map.camera.viewHeight).toBeCloseTo(55, 6);
    // Camera clamped to bounds.
    const bounds = game2.strategicMap.bounds;
    expect(game2.gameState.map.camera.x).toBeGreaterThanOrEqual(bounds.minX - 10);
    // Country data survived the roundtrip, capitals re-joined to live map.
    const loaded = game2.gameState.countries.countries[countryId];
    expect(loaded).toBeDefined();
    expect(loaded.capitalId).toBe(game2.strategicMap.countries[countryId].capitalCityId);
    expect(loaded.population).toBeGreaterThan(0);
    game.dispose();
    game2.dispose();
  });

  it('heals map selections that reference ids missing from the live map (generation drift)', () => {
    const storage = new MemorySaveStorage();
    const game = new Game({ seed: 4242, saveStorage: storage });
    game.init();
    const countryId = game.strategicMap.countryOrder[0];
    game.commandBus.send({ type: 'map.select', countryId });
    game.commandBus.flush();
    game.saveToSlot('drift-slot');

    // Simulate an older save whose generated city/province/country ids no
    // longer exist after a map-generation change (config/seed drift).
    const raw = JSON.parse(storage.load('drift-slot') as string) as {
      meta: { checksum: number };
      data: { state: { map: Record<string, unknown> } };
    };
    raw.data.state.map.selectedCountryId = 'country_does_not_exist';
    raw.data.state.map.selectedProvinceId = 'prov_does_not_exist';
    raw.data.state.map.selectedCityId = 'city_does_not_exist';
    // Re-seal the tampered payload with a VALID checksum: the save must be
    // structurally fine — only the referenced ids are stale.
    raw.meta.checksum = fnv1a32(stableStringify(raw.data));
    storage.save('drift-slot', JSON.stringify(raw));

    const game2 = new Game({ seed: 1, saveStorage: storage });
    game2.init();
    expect(() => game2.loadFromSlot('drift-slot')).not.toThrow();
    expect(game2.gameState.map.selectedCountryId).toBeNull();
    expect(game2.gameState.map.selectedProvinceId).toBeNull();
    expect(game2.gameState.map.selectedCityId).toBeNull();
    // The rest of the slice survives the heal.
    expect(game2.gameState.map.camera).toBeDefined();
    expect(game2.gameState.map.layerVisibility).toBeDefined();
    game.dispose();
    game2.dispose();
  });
});
