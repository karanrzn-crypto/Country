import { describe, it, expect } from 'vitest';
import { Game } from '../../../core/Game';
import { MemorySaveStorage } from '../../../save/SaveStorage';
import { SaveError } from '../../../utils/errors';
import { fnv1a32, stableStringify } from '../../../utils/hash';
import { applyMigrations, clearMigrationsForTests, registerMigration } from '../../../save/migrations';
import type { SaveFile } from '../../../save/SaveTypes';
import { createTestGame } from '../../helpers/testGame';

function createGameWithStorage(seed: number): { game: Game; storage: MemorySaveStorage } {
  const storage = new MemorySaveStorage();
  const game = new Game({ seed, saveStorage: storage });
  game.init();
  return { game, storage };
}

describe('SaveManager (versioned, validated, corruption-resistant)', () => {
  it('saves and loads a full roundtrip preserving state and runtime', () => {
    const storage = new MemorySaveStorage();
    const game = new Game({ seed: 77, saveStorage: storage });
    game.init();
    game.runTicks(48);
    game.saveToSlot('test', 'Roundtrip');

    const game2 = new Game({ seed: 999, saveStorage: storage }); // different seed!
    game2.init();
    game2.loadFromSlot('test');

    expect(game2.gameTime.tick).toBe(48);
    expect(game2.gameState.economy.treasury.republic).toBe(game.gameState.economy.treasury.republic);
    expect(game2.stateHash()).toBe(game.stateHash());
    game.dispose();
    game2.dispose();
  });

  it('lists saves with metadata', () => {
    const game = createTestGame();
    game.saveToSlot('slot-a', 'Label A');
    game.runTicks(10);
    game.saveToSlot('slot-b', 'Label B');
    const list = game.listSaves();
    expect(list).toHaveLength(2);
    const labels = list.map((entry) => entry.label).sort();
    expect(labels).toEqual(['Label A', 'Label B']);
    game.dispose();
  });

  it('rejects corrupted JSON with SaveError', () => {
    const { game, storage } = createGameWithStorage(1);
    storage.save('broken', '{not json at all');
    expect(() => game.loadFromSlot('broken')).toThrowError(SaveError);
    game.dispose();
  });

  it('rejects tampered payloads (checksum mismatch)', () => {
    const { game, storage } = createGameWithStorage(2);
    game.saveToSlot('safe');
    const raw = JSON.parse(storage.load('safe') as string) as SaveFile;
    raw.data.state.economy.treasury.republic = 999_999_999;
    storage.save('safe', JSON.stringify(raw));
    expect(() => game.loadFromSlot('safe')).toThrowError(/checksum/i);
    game.dispose();
  });

  it('rejects missing slots', () => {
    const { game } = createGameWithStorage(3);
    expect(() => game.loadFromSlot('ghost')).toThrowError(SaveError);
    game.dispose();
  });

  it('state failing schema validation is rejected before poisoning the game', () => {
    const { game, storage } = createGameWithStorage(4);
    game.saveToSlot('v');
    const raw = JSON.parse(storage.load('v') as string) as SaveFile;
    delete (raw.data.state.player as { countryId?: string }).countryId;
    // Recompute the checksum so the corruption reaches the validation stage.
    (raw.meta as { checksum: number }).checksum = fnv1a32(stableStringify(raw.data));
    storage.save('v', JSON.stringify(raw));
    expect(() => game.loadFromSlot('v')).toThrowError(SaveError);
    game.dispose();
  });

  it('loading restores the RNG stream (determinism across save/load)', () => {
    const storage = new MemorySaveStorage();
    const reference = new Game({ seed: 8080, saveStorage: storage });
    reference.init();
    reference.runTicks(24);
    reference.saveToSlot('mid');
    reference.runTicks(24);

    const resumed = new Game({ seed: 123, saveStorage: storage });
    resumed.init();
    resumed.loadFromSlot('mid');
    resumed.runTicks(24);
    expect(resumed.stateHash()).toBe(reference.stateHash());
    reference.dispose();
    resumed.dispose();
  });
});

describe('migration framework', () => {
  it('applies a registered chain in order', () => {
    clearMigrationsForTests();
    registerMigration({ from: 1, to: 2, migrate: (data) => ({ ...(data as object), v2: true }) });
    registerMigration({ from: 2, to: 3, migrate: (data) => ({ ...(data as object), v3: true }) });
    const { data, version } = applyMigrations({ base: 1 }, 1, 3);
    expect(version).toBe(3);
    expect(data).toEqual({ base: 1, v2: true, v3: true });
  });

  it('throws when a migration step is missing', () => {
    clearMigrationsForTests();
    expect(() => applyMigrations({}, 1, 3)).toThrowError(SaveError);
  });

  it('throws when the save is from a newer version', () => {
    clearMigrationsForTests();
    expect(() => applyMigrations({}, 99, 1)).toThrowError(/newer version/);
  });
});
