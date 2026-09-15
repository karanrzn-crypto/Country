import type { AssetDescriptor, AssetLoader } from './AssetTypes';
import type { AssetRegistry } from './AssetRegistry';
import type { AssetCache } from './AssetCache';
import type { EventBus } from '../events/EventBus';
import type { Logger } from '../utils/Logger';
import { AssetError } from '../utils/errors';

/**
 * Asset pipeline orchestrator: registry (what exists) + loaders (how to load)
 * + cache (lifetime & disposal) + progress events (UI loading screens).
 */
export class AssetManager {
  private readonly loaders = new Map<string, AssetLoader>();

  constructor(
    private readonly registry: AssetRegistry,
    private readonly cache: AssetCache,
    private readonly events: EventBus,
    private readonly logger: Logger
  ) {}

  registerLoader(loader: AssetLoader): void {
    this.loaders.set(loader.kind, loader);
  }

  registerAssets(descriptors: readonly AssetDescriptor[]): void {
    this.registry.registerAll(descriptors);
  }

  registerGroup(groupId: string, assetIds: readonly string[]): void {
    this.registry.registerGroup(groupId, assetIds);
  }

  async load(assetId: string): Promise<unknown> {
    const cached = this.cache.acquire(assetId);
    if (cached !== undefined) return cached;

    const descriptor = this.registry.get(assetId);
    const loader = this.loaders.get(descriptor.kind);
    if (loader === undefined) {
      throw new AssetError(`No loader registered for asset kind "${descriptor.kind}" (${assetId})`);
    }

    const startedAt = performance.now();
    try {
      const loaded = await loader.load(descriptor);
      this.cache.put(assetId, loaded.data, loaded.dispose);
      this.events.emit('assets.assetLoaded', {
        assetId,
        kind: descriptor.kind,
        durationMs: Math.round(performance.now() - startedAt)
      });
      return loaded.data;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.events.emit('assets.assetError', { assetId, message });
      this.logger.error(`Asset load failed: ${assetId}`, error);
      throw new AssetError(`Failed to load asset "${assetId}": ${message}`);
    }
  }

  /** Loads a whole group with per-asset progress events. */
  async loadGroup(groupId: string, onProgress?: (loaded: number, total: number) => void): Promise<unknown[]> {
    const assetIds = this.registry.groupAssetIds(groupId);
    const results: unknown[] = [];
    let loadedCount = 0;
    for (const assetId of assetIds) {
      results.push(await this.load(assetId));
      loadedCount += 1;
      this.events.emit('assets.groupProgress', { groupId, loaded: loadedCount, total: assetIds.length });
      onProgress?.(loadedCount, assetIds.length);
    }
    return results;
  }

  release(assetId: string): boolean {
    return this.cache.release(assetId);
  }

  disposeAll(): void {
    this.cache.disposeAll();
  }

  get stats(): { registered: number; cached: number; loaders: number } {
    return {
      registered: this.registry.size,
      cached: this.cache.size,
      loaders: this.loaders.size
    };
  }
}
