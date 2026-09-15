import type { SystemContext } from '../core/GameContext';
import type { PhaseSystem, SystemUpdate } from '../core/SystemTypes';
import type { ChunkId } from '../world/types';

/**
 * Translates held movement actions into focus-chunk changes through the
 * command bus (input never mutates state directly). Focus moves one chunk at
 * a time on a fixed cadence — the camera rig smooths it visually.
 */
export class PlayerController implements PhaseSystem {
  readonly id = 'core.playerController';
  readonly phase = 'input' as const;

  private moveAccumulator = 0;
  private readonly MOVE_INTERVAL_SECONDS = 0.12;

  update(context: SystemContext, update: SystemUpdate): void {
    if (update.kind !== 'frame') return;
    const input = context.input;
    if (input === null) return;

    const dx = (input.isDown('moveEast') ? 1 : 0) - (input.isDown('moveWest') ? 1 : 0);
    const dz = (input.isDown('moveSouth') ? 1 : 0) - (input.isDown('moveNorth') ? 1 : 0);
    if (dx === 0 && dz === 0) {
      this.moveAccumulator = 0;
      return;
    }

    this.moveAccumulator += update.frame.dtRealSeconds;
    if (this.moveAccumulator < this.MOVE_INTERVAL_SECONDS) return;
    this.moveAccumulator = 0;

    const focusId = context.state.player.focusChunkId;
    if (focusId === null) return;
    const focus = context.state.world.chunks[focusId];
    if (focus === undefined) return;

    const desiredGx = focus.gx + dx;
    const desiredGz = focus.gz + dz;
    for (const chunk of Object.values(context.state.world.chunks)) {
      if (chunk.gx === desiredGx && chunk.gz === desiredGz) {
        context.commands.send({ type: 'player.focusChunk', chunkId: chunk.id as ChunkId });
        break;
      }
    }
  }
}
