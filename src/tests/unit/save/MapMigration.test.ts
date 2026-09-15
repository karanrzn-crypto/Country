import { describe, it, expect } from 'vitest';
import { Game } from '../../../core/Game';
import { MemorySaveStorage } from '../../../save/SaveStorage';
import { applyMigrations } from '../../../save/migrations';
import { SAVE_VERSION } from '../../../save/SaveTypes';
import { fnv1a32, stableStringify } from '../../../utils/hash';

/**
 * v1 → v2 migration: saves created before the strategic map slice (Part 1)
 * must load cleanly with a documented default map state injected.
 */
describe('save migration v1 → v2 (map slice introduction)', () => {
  it('injects the default map slice into a v1 save', () => {
    const v1 = {
      state: {
        world: { worldId: 'demo-country' },
        player: { countryId: 'republic', mode: null, focusChunkId: null, selection: [] },
        economy: { treasury: { republic: 10_000 } }
      },
      runtime: { tick: 12, rngState: 99, ids: { counters: {} } }
    };

    const { data, version } = applyMigrations(v1, 1, SAVE_VERSION);
    expect(version).toBe(2);
    const migrated = data as typeof v1 & { state: { map?: Record<string, unknown> } };
    expect(migrated.state.map).toBeDefined();
    expect(migrated.state.map?.selectedCountryId).toBeNull();
    expect(migrated.state.map?.selectedProvinceId).toBeNull();
    expect(migrated.state.map?.selectedCityId).toBeNull();
    expect(migrated.state.map?.layerVisibility).toBeDefined();
    expect(migrated.state.map?.camera).toBeDefined();
    // Original fields untouched (no destructive migration).
    expect(migrated.state.player.countryId).toBe('republic');
    expect(migrated.runtime.tick).toBe(12);
  });

  it('v1 → v2 is a no-op for the rest of the payload (pure additive)', () => {
    const v1 = { state: { a: 1 }, runtime: { tick: 0 } };
    const { data } = applyMigrations(v1, 1, 2);
    const migrated = data as { state: Record<string, unknown> };
    expect(migrated.state.a).toBe(1);
    expect(Object.keys(migrated.state)).toEqual(['a', 'map']);
  });

  it('current-version saves load with full map selection state', () => {
    const storage = new MemorySaveStorage();
    const game = new Game({ seed: 31337, saveStorage: storage });
    game.init();
    const countryId = game.strategicMap.countryOrder[0];
    game.commandBus.send({ type: 'map.select', countryId });
    game.commandBus.send({ type: 'map.setCamera', x: 100, z: 80, viewHeight: 55 });
    game.commandBus.flush();
    game.saveToSlot('v2-slot');

    const game2 = new Game({ seed: 1, saveStorage: storage });
    game2.init();
    game2.loadFromSlot('v2-slot');
    expect(game2.gameState.map.selectedCountryId).toBe(countryId);
    expect(game2.gameState.map.camera.viewHeight).toBeCloseTo(55, 6);
    // Camera clamped to bounds.
    const bounds = game2.strategicMap.bounds;
    expect(game2.gameState.map.camera.x).toBeGreaterThanOrEqual(bounds.minX - 10);
    game.dispose();
    game2.dispose();
  });

  it('a migrated v1 state gains a schema-valid map slice', () => {
    const v1 = { state: { world: { worldId: 'x' } }, runtime: {} };
    const { data } = applyMigrations(v1, 1, 2);
    const migrated = data as { state: Record<string, unknown> };
    expect(migrated.state.map).toBeDefined();
    const map = migrated.state.map as Record<string, unknown>;
    expect(Object.keys(map).sort()).toEqual(
      ['camera', 'layerVisibility', 'selectedCityId', 'selectedCountryId', 'selectedProvinceId', 'viewport'].sort()
    );
    expect(() => fnv1a32(stableStringify(migrated))).not.toThrow();
  });
});
