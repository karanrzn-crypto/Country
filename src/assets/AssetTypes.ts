/**
 * Asset pipeline types. Assets are declared (id, kind, url/factory), loaded
 * through pluggable loaders, cached with reference counting and disposed
 * explicitly — no scattered hard-coded loads, no leaks by design.
 */

export type AssetKind = 'model' | 'texture' | 'audio' | 'animation' | 'json' | 'generated';

export interface AssetDescriptor {
  readonly id: string;
  readonly kind: AssetKind;
  readonly url?: string;
  readonly group?: string;
  /** For kind 'generated': synchronous factory creating the asset. */
  readonly generate?: () => unknown;
}

export interface LoadedAsset {
  readonly data: unknown;
  /** Optional explicit GPU/memory cleanup (called by the cache on release). */
  readonly dispose?: () => void;
}

export interface AssetLoader {
  readonly kind: AssetKind;
  load(descriptor: AssetDescriptor): Promise<LoadedAsset>;
}
