import { Game } from '../../core/Game';
import { MemorySaveStorage } from '../../save/SaveStorage';
import type { DeepPartial } from '../../config/GameConfig';
import type { GameConfig } from '../../config/configTypes';

export interface TestGameOptions {
  seed?: number;
  configOverrides?: DeepPartial<GameConfig>;
}

/** Headless test game: no renderer, no DOM, no input, in-memory saves. */
export function createTestGame(options: TestGameOptions = {}): Game {
  const game = new Game({
    seed: options.seed ?? 42,
    saveStorage: new MemorySaveStorage(),
    configOverrides: options.configOverrides
  });
  game.init();
  return game;
}
