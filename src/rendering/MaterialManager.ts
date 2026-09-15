import * as THREE from 'three';
import { fnv1a32 } from '../utils/hash';

/** Deterministic pleasant palette for region tinting. */
const PALETTE: readonly number[] = [
  0x4e7a4e, 0x6b7f3f, 0x3f6d7f, 0x7f6a3f, 0x5d4e7a, 0x7a4e5d, 0x4e7a72, 0x77794a
];

/**
 * Shared material cache: one material per region id, disposed centrally.
 * Prevents per-chunk material allocation and the leaks that come with it.
 */
export class MaterialManager {
  private readonly cache = new Map<string, THREE.MeshLambertMaterial>();

  getForRegion(regionId: string): THREE.MeshLambertMaterial {
    const cached = this.cache.get(regionId);
    if (cached !== undefined) return cached;
    const color = PALETTE[fnv1a32(regionId) % PALETTE.length] ?? 0x4e7a4e;
    const material = new THREE.MeshLambertMaterial({ color });
    this.cache.set(regionId, material);
    return material;
  }

  disposeAll(): void {
    for (const material of this.cache.values()) {
      material.dispose();
    }
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}
