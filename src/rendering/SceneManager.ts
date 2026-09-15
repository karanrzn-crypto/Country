import * as THREE from 'three';
import type { EventBus } from '../events/EventBus';
import type { WorldSlice } from '../state/slices/worldSlice';
import type { ChunkId, LODLevel } from '../world/types';
import { MaterialManager } from './MaterialManager';

/**
 * Scene-side chunk streaming: mirrors chunk events into THREE meshes.
 * Activated chunk → plane mesh (shared LOD geometry, cached region material);
 * deactivated → removal; LOD change → geometry swap. Shared resources are
 * disposed once, centrally, on dispose().
 */
export class SceneManager {
  private readonly meshes = new Map<ChunkId, THREE.Mesh>();
  private readonly geometryCache = new Map<LODLevel, THREE.PlaneGeometry>();
  private readonly materials = new MaterialManager();
  private readonly unsubscribes: (() => void)[] = [];

  constructor(
    private readonly scene: THREE.Scene,
    private readonly world: WorldSlice,
    private readonly chunkSize: number
  ) {}

  attach(events: EventBus): void {
    this.unsubscribes.push(
      events.on('world.chunkActivated', ({ chunkId, lod }) => this.createMesh(chunkId, lod)),
      events.on('world.chunkDeactivated', ({ chunkId }) => this.removeMesh(chunkId)),
      events.on('world.chunkLodChanged', ({ chunkId, lod }) => this.applyLod(chunkId, lod))
    );
  }

  private geometryFor(lod: LODLevel): THREE.PlaneGeometry {
    const cached = this.geometryCache.get(lod);
    if (cached !== undefined) return cached;
    const segments = lod === 0 ? 4 : 1;
    const geometry = new THREE.PlaneGeometry(this.chunkSize, this.chunkSize, segments, segments);
    geometry.rotateX(-Math.PI / 2);
    this.geometryCache.set(lod, geometry);
    return geometry;
  }

  private createMesh(chunkId: ChunkId, lod: LODLevel): void {
    if (this.meshes.has(chunkId)) return;
    const chunk = this.world.chunks[chunkId];
    if (chunk === undefined) return;
    const mesh = new THREE.Mesh(
      this.geometryFor(lod),
      this.materials.getForRegion(chunk.regionId)
    );
    mesh.position.set((chunk.gx + 0.5) * this.chunkSize, 0, (chunk.gz + 0.5) * this.chunkSize);
    this.scene.add(mesh);
    this.meshes.set(chunkId, mesh);
  }

  private removeMesh(chunkId: ChunkId): void {
    const mesh = this.meshes.get(chunkId);
    if (mesh === undefined) return;
    this.scene.remove(mesh);
    this.meshes.delete(chunkId); // geometry & material are shared caches — not disposed here
  }

  private applyLod(chunkId: ChunkId, lod: LODLevel): void {
    const mesh = this.meshes.get(chunkId);
    if (mesh === undefined) return;
    mesh.geometry = this.geometryFor(lod);
  }

  get meshCount(): number {
    return this.meshes.size;
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes.length = 0;
    for (const mesh of this.meshes.values()) {
      this.scene.remove(mesh);
    }
    this.meshes.clear();
    for (const geometry of this.geometryCache.values()) {
      geometry.dispose();
    }
    this.geometryCache.clear();
    this.materials.disposeAll();
  }
}
