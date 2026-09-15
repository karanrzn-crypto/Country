import type { AssetDescriptor } from './AssetTypes';
import { AssetError } from '../utils/errors';

/**
 * Declarative asset registry: descriptors + named groups. Descriptors are
 * registered at boot (code or manifest); groups load/unload together with
 * aggregate progress — the only sanctioned way to reach assets.
 */
export class AssetRegistry {
  private readonly assets = new Map<string, AssetDescriptor>();
  private readonly groups = new Map<string, string[]>();

  register(descriptor: AssetDescriptor): void {
    if (this.assets.has(descriptor.id)) {
      throw new AssetError(`Asset "${descriptor.id}" already registered`);
    }
    if (descriptor.kind === 'generated' && descriptor.generate === undefined) {
      throw new AssetError(`Generated asset "${descriptor.id}" is missing its factory`);
    }
    if (descriptor.kind !== 'generated' && (descriptor.url === undefined || descriptor.url.length === 0)) {
      throw new AssetError(`Asset "${descriptor.id}" (kind ${descriptor.kind}) is missing its url`);
    }
    this.assets.set(descriptor.id, descriptor);
  }

  registerAll(descriptors: readonly AssetDescriptor[]): void {
    for (const descriptor of descriptors) this.register(descriptor);
  }

  registerGroup(groupId: string, assetIds: readonly string[]): void {
    if (this.groups.has(groupId)) {
      throw new AssetError(`Asset group "${groupId}" already registered`);
    }
    for (const assetId of assetIds) {
      if (!this.assets.has(assetId)) {
        throw new AssetError(`Asset group "${groupId}" references unknown asset "${assetId}"`);
      }
    }
    this.groups.set(groupId, [...assetIds]);
  }

  get(assetId: string): AssetDescriptor {
    const descriptor = this.assets.get(assetId);
    if (descriptor === undefined) throw new AssetError(`Unknown asset "${assetId}"`);
    return descriptor;
  }

  groupAssetIds(groupId: string): readonly string[] {
    const ids = this.groups.get(groupId);
    if (ids === undefined) throw new AssetError(`Unknown asset group "${groupId}"`);
    return ids;
  }

  get assetIds(): readonly string[] {
    return [...this.assets.keys()];
  }

  get size(): number {
    return this.assets.size;
  }
}
