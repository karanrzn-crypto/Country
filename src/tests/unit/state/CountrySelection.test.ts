import { describe, it, expect } from 'vitest';
import { Game } from '../../../core/Game';
import { MemorySaveStorage } from '../../../save/SaveStorage';

/**
 * Country-selection flow (Part 3):
 * - fresh campaigns start with countryConfirmed = false;
 * - confirming registers the country in state.player (THE source of truth
 *   for every future system);
 * - the phase can be re-opened (pauses) and re-confirmed (id-agnostic);
 * - unknown countries are rejected without corrupting state;
 * - the confirmed country + new-layer defaults survive save/load roundtrips.
 */
describe('country selection flow', () => {
  it('fresh campaigns start unconfirmed', () => {
    const game = new Game({ seed: 42, saveStorage: new MemorySaveStorage() });
    game.init();
    expect(game.gameState.player.countryConfirmed).toBe(false);
    expect(game.gameState.player.mode).toBe('president');
    game.dispose();
  });

  it('confirming registers the player country and emits the confirmation event', () => {
    const game = new Game({ seed: 42, saveStorage: new MemorySaveStorage() });
    game.init();
    const countryId = game.strategicMap.countryOrder[3] ?? 'country_0';
    const events: string[] = [];
    game.gameEvents.on('player.countryConfirmed', ({ countryId: id }) => {
      events.push(id);
    });

    game.confirmCountrySelection(countryId);
    expect(game.gameState.player.countryId).toBe(countryId);
    expect(game.gameState.player.countryConfirmed).toBe(true);
    expect(events).toEqual([countryId]);
    // Selection hierarchy follows the confirmed country.
    expect(game.gameState.map.selectedCountryId).toBe(countryId);
    game.dispose();
  });

  it('rejects unknown countries without touching state', () => {
    const game = new Game({ seed: 42, saveStorage: new MemorySaveStorage() });
    game.init();
    const before = game.gameState.player.countryId;
    game.confirmCountrySelection('country_does_not_exist');
    expect(game.gameState.player.countryId).toBe(before);
    expect(game.gameState.player.countryConfirmed).toBe(false);
    game.dispose();
  });

  it('beginCountrySelection pauses; confirming resumes the campaign', () => {
    const game = new Game({ seed: 42, saveStorage: new MemorySaveStorage() });
    game.init();
    const pauseEvents: string[] = [];
    game.gameEvents.on('game.paused', () => pauseEvents.push('paused'));
    game.gameEvents.on('game.resumed', () => pauseEvents.push('resumed'));

    game.confirmCountrySelection('country_0');
    game.beginCountrySelection();
    expect(game.gameState.player.countryConfirmed).toBe(false);
    expect(pauseEvents[pauseEvents.length - 1]).toBe('paused');

    game.confirmCountrySelection('country_1');
    expect(game.gameState.player.countryId).toBe('country_1');
    expect(game.gameState.player.countryConfirmed).toBe(true);
    expect(pauseEvents[pauseEvents.length - 1]).toBe('resumed');
    game.dispose();
  });

  it('works for EVERY country in the model (data-driven, no hardcoded ids)', () => {
    const game = new Game({ seed: 42, saveStorage: new MemorySaveStorage() });
    game.init();
    for (const countryId of game.strategicMap.countryOrder) {
      game.beginCountrySelection();
      game.confirmCountrySelection(countryId);
      expect(game.gameState.player.countryId).toBe(countryId);
      expect(game.gameState.player.countryConfirmed).toBe(true);
    }
    game.dispose();
  });

  it('the confirmed country survives a save/load roundtrip', () => {
    const storage = new MemorySaveStorage();
    const game = new Game({ seed: 42, saveStorage: storage });
    game.init();
    game.confirmCountrySelection('country_2');
    game.saveToSlot('selection-slot');
    game.dispose();

    const game2 = new Game({ seed: 999, saveStorage: storage });
    game2.init();
    game2.loadFromSlot('selection-slot');
    expect(game2.gameState.player.countryId).toBe('country_2');
    expect(game2.gameState.player.countryConfirmed).toBe(true);
    game2.dispose();
  });

  it('new map layers pick up registry defaults when loading old saves', () => {
    const storage = new MemorySaveStorage();
    const game = new Game({ seed: 42, saveStorage: storage });
    game.init();
    // Toggle a base layer off + save: the record carries only known keys.
    game.mapSetLayerVisible('labels', false);
    game.saveToSlot('layer-slot');
    game.dispose();

    const game2 = new Game({ seed: 999, saveStorage: storage });
    game2.init();
    game2.loadFromSlot('layer-slot');
    // Saved toggle wins over the default…
    expect(game2.gameState.map.layerVisibility.labels).toBe(false);
    // …and new information layers receive their defaults (OFF for overlays;
    // railways default ON — the independent toggle is visible out of the box).
    expect(game2.gameState.map.layerVisibility.biomes).toBe(false);
    expect(game2.gameState.map.layerVisibility.railways).toBe(true);
    expect(game2.gameState.map.layerVisibility.rivers).toBe(true);
    game2.dispose();
  });
});
