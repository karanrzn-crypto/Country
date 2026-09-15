import type { EventBus } from '../events/EventBus';
import type { WorldConfig } from '../config/configTypes';
import type { WorldSlice, ChunkRecord } from '../state/slices/worldSlice';
import type { ChunkId, ChunkState, LODLevel } from './types';
import { computeLodForDistance } from './LODStrategy';
import { chebyshevDistance } from '../utils/math';
import { WorldError } from '../utils/errors';

interface StreamedRuntime {
  streamed: ChunkState;
  lod: LODLevel;
}

/**
 * Chunk streaming manager — the heart of the 2.5D/3D hybrid performance model.
 *
 * Two strictly separated layers:
 *
 * 1. LOGICAL state (`stateOf`) — a pure function of (chunk, focus, config).
 *    The simulation consumes this (sim-LOD), so it is fully deterministic:
 *    identical focus ⇒ identical simulation, regardless of streaming speed.
 *
 * 2. STREAMED state (`streamedStateOf`) — how far the renderer-side materiali-
 *    zation has actually progressed under the per-tick operation budget.
 *    Only this layer emits activation/deactivation/LOD events.
 */
export class ChunkManager {
  private readonly streamed = new Map<ChunkId, StreamedRuntime>();
  private focusChunkId: ChunkId | null = null;

  constructor(
    private readonly world: WorldSlice,
    private readonly events: EventBus,
    private readonly config: WorldConfig
  ) {
    for (const chunkId of Object.keys(world.chunks)) {
      this.streamed.set(chunkId, { streamed: 'unloaded', lod: 2 });
    }
  }

  get focus(): ChunkId | null {
    return this.focusChunkId;
  }

  setFocus(chunkId: ChunkId, budgetOps = Number.MAX_SAFE_INTEGER): void {
    if (this.world.chunks[chunkId] === undefined) {
      throw new WorldError(`Cannot focus unknown chunk "${chunkId}"`);
    }
    this.focusChunkId = chunkId;
    this.update(budgetOps);
    this.events.emit('world.focusChanged', {
      chunkId,
      regionId: this.world.chunks[chunkId].regionId
    });
  }

  private desiredStateFor(chunk: ChunkRecord): ChunkState {
    const focusId = this.focusChunkId;
    if (focusId === null) return 'unloaded';
    const focus = this.world.chunks[focusId];
    if (focus === undefined) return 'unloaded';
    const distance = chebyshevDistance(chunk.gx, chunk.gz, focus.gx, focus.gz);
    if (distance <= this.config.activeRadius) return 'active';
    if (distance <= this.config.simulatedRadius) return 'simulated';
    return 'unloaded';
  }

  /** LOGICAL state — pure function of focus; consumed by simulation LOD. */
  stateOf(chunkId: ChunkId): ChunkState {
    const chunk = this.world.chunks[chunkId];
    if (chunk === undefined) return 'unloaded';
    return this.desiredStateFor(chunk);
  }

  /** LOGICAL LOD — pure function of focus distance. */
  lodOf(chunkId: ChunkId): LODLevel {
    const chunk = this.world.chunks[chunkId];
    if (chunk === undefined) return 2;
    const focusId = this.focusChunkId;
    if (focusId === null) return 2;
    const focus = this.world.chunks[focusId];
    if (focus === undefined) return 2;
    return computeLodForDistance(chebyshevDistance(chunk.gx, chunk.gz, focus.gx, focus.gz));
  }

  /** RENDERER-side progress: has the chunk materialized yet? */
  streamedStateOf(chunkId: ChunkId): ChunkState {
    return this.streamed.get(chunkId)?.streamed ?? 'unloaded';
  }

  streamedLodOf(chunkId: ChunkId): LODLevel {
    return this.streamed.get(chunkId)?.lod ?? 2;
  }

  /** Advances the streamed layer toward the logical layout within the budget. */
  update(budgetOps: number): void {
    const focusId = this.focusChunkId;
    if (focusId === null) return;
    const focus = this.world.chunks[focusId];
    if (focus === undefined) return;
    let ops = budgetOps;

    for (const [chunkId, chunk] of Object.entries(this.world.chunks)) {
      const rt = this.streamed.get(chunkId);
      if (rt === undefined) continue;
      const desired = this.desiredStateFor(chunk);
      const distance = chebyshevDistance(chunk.gx, chunk.gz, focus.gx, focus.gz);

      if (rt.streamed !== desired) {
        if (ops <= 0) continue;
        ops -= 1;
        const previous = rt.streamed;
        rt.streamed = desired;
        if (desired === 'active') {
          rt.lod = computeLodForDistance(distance);
          this.events.emit('world.chunkActivated', {
            chunkId,
            regionId: chunk.regionId,
            lod: rt.lod
          });
        } else if (previous === 'active') {
          this.events.emit('world.chunkDeactivated', { chunkId, regionId: chunk.regionId });
        }
      } else if (rt.streamed === 'active') {
        const desiredLod = computeLodForDistance(distance);
        if (rt.lod !== desiredLod) {
          rt.lod = desiredLod;
          this.events.emit('world.chunkLodChanged', { chunkId, lod: desiredLod });
        }
      }
    }
  }

  activeChunkIds(): ChunkId[] {
    return this.collectByState('active');
  }

  simulatedChunkIds(): ChunkId[] {
    return this.collectByState('simulated');
  }

  private collectByState(state: ChunkState): ChunkId[] {
    const result: ChunkId[] = [];
    for (const [chunkId, chunk] of Object.entries(this.world.chunks)) {
      if (this.stateOf(chunkId) === state && chunk !== undefined) result.push(chunkId);
    }
    return result;
  }

  /** LOGICAL counts — end-state of streaming (HUD, queries). */
  counts(): { active: number; simulated: number; unloaded: number } {
    return this.countBy((chunkId) => this.stateOf(chunkId));
  }

  /** RENDERER-side counts — current streamed progress. */
  streamedCounts(): { active: number; simulated: number; unloaded: number } {
    return this.countBy((chunkId) => this.streamedStateOf(chunkId));
  }

  private countBy(selector: (chunkId: ChunkId) => ChunkState): { active: number; simulated: number; unloaded: number } {
    const counts = { active: 0, simulated: 0, unloaded: 0 };
    for (const chunkId of Object.keys(this.world.chunks)) {
      const state = selector(chunkId);
      if (state === 'active') counts.active += 1;
      else if (state === 'simulated') counts.simulated += 1;
      else counts.unloaded += 1;
    }
    return counts;
  }
}
