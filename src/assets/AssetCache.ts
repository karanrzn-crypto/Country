/**
 * Reference-counted asset cache. When the last reference is released the
 * asset's dispose callback runs — GPU textures, geometries and audio buffers
 * never leak silently.
 */
export class AssetCache {
  private readonly entries = new Map<string, { data: unknown; dispose?: () => void; refCount: number }>();

  acquire(assetId: string): unknown | undefined {
    const entry = this.entries.get(assetId);
    if (entry === undefined) return undefined;
    entry.refCount += 1;
    return entry.data;
  }

  peek(assetId: string): boolean {
    return this.entries.has(assetId);
  }

  put(assetId: string, data: unknown, dispose?: () => void): void {
    const existing = this.entries.get(assetId);
    if (existing !== undefined) {
      existing.refCount += 1;
      return;
    }
    this.entries.set(assetId, { data, dispose, refCount: 1 });
  }

  /** Decrements; disposes the asset when the last reference is gone. */
  release(assetId: string): boolean {
    const entry = this.entries.get(assetId);
    if (entry === undefined) return false;
    entry.refCount -= 1;
    if (entry.refCount <= 0) {
      try {
        entry.dispose?.();
      } catch {
        // Disposal must never break the game loop.
      }
      this.entries.delete(assetId);
      return true;
    }
    return false;
  }

  disposeAll(): void {
    for (const entry of this.entries.values()) {
      try {
        entry.dispose?.();
      } catch {
        // Ignore disposal errors during teardown.
      }
    }
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
