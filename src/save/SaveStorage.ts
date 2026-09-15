import type { SaveFile } from './SaveTypes';

export interface SaveSlotInfo {
  readonly slot: string;
  readonly label: string;
  readonly savedTick: number;
  readonly version: number;
}

/**
 * Pluggable persistence backend. Memory for tests/headless, localStorage for
 * the browser; a file or cloud backend can be added without touching the
 * SaveManager.
 */
export interface SaveStorage {
  save(slot: string, json: string): void;
  load(slot: string): string | null;
  delete(slot: string): void;
  list(): SaveSlotInfo[];
}

export class MemorySaveStorage implements SaveStorage {
  private readonly slots = new Map<string, string>();

  save(slot: string, json: string): void {
    this.slots.set(slot, json);
  }

  load(slot: string): string | null {
    return this.slots.get(slot) ?? null;
  }

  delete(slot: string): void {
    this.slots.delete(slot);
  }

  list(): SaveSlotInfo[] {
    return [...this.slots.entries()]
      .map(([slot, json]) => ({ slot, meta: parseMeta(json) }))
      .filter((entry) => entry.meta !== null)
      .map(({ slot, meta }) => ({
        slot,
        label: (meta as { label: string }).label,
        savedTick: (meta as { savedTick: number }).savedTick,
        version: (meta as { version: number }).version
      }));
  }
}

export class BrowserLocalStorageStorage implements SaveStorage {
  constructor(private readonly prefix: string) {}

  private key(slot: string): string {
    return `${this.prefix}:save:${slot}`;
  }

  save(slot: string, json: string): void {
    try {
      localStorage.setItem(this.key(slot), json);
    } catch {
      // Storage full / disabled — save silently fails (logged upstream).
    }
  }

  load(slot: string): string | null {
    try {
      return localStorage.getItem(this.key(slot));
    } catch {
      return null;
    }
  }

  delete(slot: string): void {
    try {
      localStorage.removeItem(this.key(slot));
    } catch {
      // Ignore.
    }
  }

  list(): SaveSlotInfo[] {
    const result: SaveSlotInfo[] = [];
    try {
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        if (key === null || !key.startsWith(`${this.prefix}:save:`)) continue;
        const slot = key.slice(`${this.prefix}:save:`.length);
        const json = localStorage.getItem(key);
        if (json === null) continue;
        const meta = parseMeta(json);
        if (meta === null) continue;
        result.push({ slot, label: meta.label, savedTick: meta.savedTick, version: meta.version });
      }
    } catch {
      // Ignore.
    }
    return result;
  }
}

function parseMeta(json: string): { label: string; savedTick: number; version: number } | null {
  try {
    const file = JSON.parse(json) as Partial<SaveFile>;
    if (file.meta === undefined) return null;
    return {
      label: String(file.meta.label ?? ''),
      savedTick: Number(file.meta.savedTick ?? 0),
      version: Number(file.meta.version ?? 0)
    };
  } catch {
    return null;
  }
}
