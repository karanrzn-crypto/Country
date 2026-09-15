import type { EventBus } from '../events/EventBus';
import type { WorldConfig } from '../config/configTypes';
import type { WorldSlice } from '../state/slices/worldSlice';
import { chunksOfRegion, primaryChunkOfRegion, regionsOfCountry } from '../state/slices/worldSlice';
import type { ChunkId, RegionId } from './types';
import { ChunkManager } from './ChunkManager';
import { VisibilityManager } from './Visibility';
import { simulationLevelForChunkState } from './LODStrategy';
import type { SimulationLevel } from '../simulation/SimulationLevel';
import { WorldError } from '../utils/errors';

/**
 * Facade over the world slice + chunk streaming + visibility.
 * Systems use this for all world queries; they never touch the slice
 * internals or Three.js.
 */
export class WorldManager {
  private readonly chunkManager: ChunkManager;
  private readonly visibility = new VisibilityManager();

  constructor(
    private readonly slice: WorldSlice,
    events: EventBus,
    private readonly config: WorldConfig
  ) {
    this.chunkManager = new ChunkManager(slice, events, config);
  }

  get data(): WorldSlice {
    return this.slice;
  }

  get chunks(): ChunkManager {
    return this.chunkManager;
  }

  get regionGridStride(): number {
    return this.slice.regionGridStride;
  }

  regionOfChunk(chunkId: ChunkId): string | null {
    return this.slice.chunks[chunkId]?.regionId ?? null;
  }

  chunksOfRegion(regionId: RegionId) {
    return chunksOfRegion(this.slice, regionId);
  }

  regionsOfCountry(countryId: string) {
    return regionsOfCountry(this.slice, countryId);
  }

  neighborRegions(regionId: RegionId): readonly string[] {
    return this.slice.regions[regionId]?.neighbors ?? [];
  }

  /** Region owning the given coordinates' country capital (fallback: first region). */
  capitalChunkId(countryId: string | null): ChunkId {
    const regions = countryId !== null ? regionsOfCountry(this.slice, countryId) : Object.values(this.slice.regions);
    const candidates = regions.length > 0 ? regions : Object.values(this.slice.regions);
    const capital = candidates.find((region) => region.capitalCityId !== null);
    const target = capital ?? candidates[0];
    const chunkId = target !== undefined ? primaryChunkOfRegion(this.slice, target.id) : null;
    if (chunkId === null) {
      throw new WorldError(`No chunk available for country "${countryId ?? 'any'}"`);
    }
    return chunkId;
  }

  setFocusChunk(chunkId: ChunkId, budgetOps?: number): void {
    this.chunkManager.setFocus(chunkId, budgetOps ?? this.config.maxChunkOpsPerTick);
  }

  streamTick(): void {
    this.chunkManager.update(this.config.maxChunkOpsPerTick);
  }

  /** Best simulation level available anywhere in the region (sim-LOD input). */
  simulationLevelForRegion(regionId: RegionId): SimulationLevel {
    const chunks = chunksOfRegion(this.slice, regionId);
    let best: SimulationLevel = 'abstract';
    const order = { abstract: 0, light: 1, detailed: 2 } as const;
    for (const chunk of chunks) {
      const level = simulationLevelForChunkState(this.chunkManager.stateOf(chunk.id));
      if (order[level] > order[best]) best = level;
    }
    return best;
  }

  isVisible(chunkId: ChunkId): boolean {
    return this.visibility.isVisible({
      chunkId,
      state: this.chunkManager.streamedStateOf(chunkId),
      lod: this.chunkManager.streamedLodOf(chunkId)
    });
  }

  /** LOGICAL chunk counts (end-state of streaming). */
  counts(): { active: number; simulated: number; unloaded: number } {
    return this.chunkManager.counts();
  }

  /** RENDERER-side chunk counts (streamed progress). */
  streamedCounts(): { active: number; simulated: number; unloaded: number } {
    return this.chunkManager.streamedCounts();
  }
}
