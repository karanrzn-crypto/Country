import type { EventBus } from '../events/EventBus';
import type { Logger } from '../utils/Logger';
import { fnv1a32, stableStringify } from '../utils/hash';
import { SaveError } from '../utils/errors';
import { validateGameStateOrThrow } from '../state/validate';
import type { GameState } from '../state/GameState';
import { SAVE_VERSION } from './SaveTypes';
import type { SaveData, SaveFile, SaveRuntimeSnapshot } from './SaveTypes';
import type { SaveSlotInfo, SaveStorage } from './SaveStorage';
import { applyMigrations } from './migrations';

export interface SaveManagerDeps {
  readonly storage: SaveStorage;
  readonly logger: Logger;
  readonly events: EventBus;
  readonly autoSaveIntervalTicks: number;
  /** Captures the current state + runtime (rng/ids/tick) for serialization. */
  readonly getSnapshot: () => { state: GameState; runtime: SaveRuntimeSnapshot };
  /** Applies a validated snapshot back into the running game. */
  readonly applySnapshot: (data: SaveData) => void;
}

/**
 * Versioned, validated, corruption-resistant save/load.
 *
 * - checksummed payloads (FNV-1a over stable-stringified data);
 * - schema validation of the state after migration;
 * - migration chain for old versions;
 * - fails loudly (SaveError) instead of loading broken state silently.
 */
export class SaveManager {
  constructor(private readonly deps: SaveManagerDeps) {}

  save(slot: string, label = ''): void {
    const { state, runtime } = this.deps.getSnapshot();
    const data: SaveData = { state, runtime };
    const checksum = fnv1a32(stableStringify(data));
    const meta = { version: SAVE_VERSION, label, savedTick: runtime.tick, checksum };
    const file: SaveFile = { meta, data };
    this.deps.storage.save(slot, JSON.stringify(file));
    this.deps.events.emit('save.saved', { slot, tick: runtime.tick });
  }

  load(slot: string): void {
    const json = this.deps.storage.load(slot);
    if (json === null) {
      throw new SaveError(`Save slot "${slot}" not found`);
    }
    let file: SaveFile;
    try {
      file = JSON.parse(json) as SaveFile;
    } catch (error) {
      throw new SaveError(`Corrupted save in slot "${slot}" (invalid JSON)`, {
        cause: String(error)
      });
    }
    if (
      typeof file !== 'object' ||
      file === null ||
      typeof file.meta !== 'object' ||
      file.meta === null ||
      file.data === undefined
    ) {
      throw new SaveError(`Corrupted save in slot "${slot}" (missing meta or data)`);
    }

    const recomputed = fnv1a32(stableStringify(file.data));
    if (recomputed !== file.meta.checksum) {
      throw new SaveError(`Corrupted save in slot "${slot}" (checksum mismatch)`, {
        expected: file.meta.checksum,
        actual: recomputed
      });
    }

    const migrated = applyMigrations(file.data, file.meta.version, SAVE_VERSION);
    const data = migrated.data as SaveData;
    if (data === null || typeof data !== 'object' || data.state === undefined || data.runtime === undefined) {
      throw new SaveError(`Corrupted save in slot "${slot}" (missing state or runtime)`);
    }

    // Reject structurally-invalid state before it can poison the game.
    try {
      validateGameStateOrThrow(data.state);
    } catch (error) {
      throw new SaveError(`Save in slot "${slot}" failed state validation`, {
        cause: error instanceof Error ? error.message : String(error)
      });
    }

    this.deps.applySnapshot(data);
    this.deps.events.emit('save.loaded', { slot, tick: data.runtime.tick, version: file.meta.version });
  }

  delete(slot: string): void {
    this.deps.storage.delete(slot);
  }

  list(): SaveSlotInfo[] {
    return this.deps.storage.list();
  }

  /** Auto-save hook, called by the Game once per simulation tick. */
  onTick(tick: number): void {
    const interval = this.deps.autoSaveIntervalTicks;
    if (interval <= 0 || tick === 0 || tick % interval !== 0) return;
    try {
      this.save('autosave', 'Autosave');
    } catch (error) {
      this.deps.logger.error('Auto-save failed', error);
    }
  }
}
