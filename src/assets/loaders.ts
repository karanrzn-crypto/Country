import type { AssetDescriptor, AssetLoader, LoadedAsset } from './AssetTypes';
import { AssetError } from '../utils/errors';

/** Loader for procedurally-created assets (no binary files in Phase 0). */
export class GeneratedAssetLoader implements AssetLoader {
  readonly kind = 'generated' as const;

  async load(descriptor: AssetDescriptor): Promise<LoadedAsset> {
    if (descriptor.generate === undefined) {
      throw new AssetError(`Generated asset "${descriptor.id}" has no factory`);
    }
    return { data: descriptor.generate() };
  }
}
