import { describe, it, expect } from 'vitest';
import { createTestGame } from '../../helpers/testGame';

describe('ChunkManager streaming', () => {
  it('activates chunks around the focus on init', () => {
    const game = createTestGame();
    const counts = game.gameWorld.counts();
    expect(counts.active).toBeGreaterThan(0);
    expect(counts.unloaded).toBeGreaterThan(0);
    game.dispose();
  });

  it('streams gradually under the per-tick operation budget (renderer layer)', () => {
    const game = createTestGame({ configOverrides: { world: { maxChunkOpsPerTick: 2 } } });
    // Logical state is instant (pure function of focus)…
    expect(game.gameWorld.chunks.stateOf('region_border.c0x0')).not.toBe('unloaded');
    // …but the streamed/renderer layer progresses gradually.
    game.gameWorld.chunks.setFocus('region_border.c0x0', 2);
    const streamedBefore = game.gameWorld.streamedCounts();
    const streamedChangedBefore = streamedBefore.active + streamedBefore.simulated;

    for (let index = 0; index < 100; index++) {
      game.gameWorld.streamTick();
    }
    const streamedAfter = game.gameWorld.streamedCounts();
    expect(streamedAfter.active + streamedAfter.simulated).toBeGreaterThan(streamedChangedBefore);
    expect(game.gameWorld.chunks.streamedStateOf('region_border.c0x0')).toBe('active');
    game.dispose();
  });

  it('deactivates chunks when focus moves away', () => {
    const game = createTestGame();
    game.focusChunk('region_capital.c0x0');
    for (let index = 0; index < 100; index++) game.gameWorld.streamTick();
    expect(game.gameWorld.chunks.stateOf('region_capital.c0x0')).toBe('active');

    game.focusChunk('region_border.c0x0');
    for (let index = 0; index < 200; index++) game.gameWorld.streamTick();
    expect(game.gameWorld.chunks.stateOf('region_border.c0x0')).toBe('active');
    // Capital is now far away (opposite corner of the region grid).
    expect(game.gameWorld.chunks.stateOf('region_capital.c0x0')).not.toBe('active');
    game.dispose();
  });

  it('emits chunk lifecycle events', () => {
    const game = createTestGame();
    const activated: string[] = [];
    const deactivated: string[] = [];
    game.gameEvents.on('world.chunkActivated', ({ chunkId }) => activated.push(chunkId));
    game.gameEvents.on('world.chunkDeactivated', ({ chunkId }) => deactivated.push(chunkId));

    game.focusChunk('region_west.c0x0');
    for (let index = 0; index < 200; index++) game.gameWorld.streamTick();
    expect(activated.length).toBeGreaterThan(0);
    expect(deactivated.length).toBeGreaterThan(0);
    game.dispose();
  });

  it('assigns LOD by distance (0 near, 2 far)', () => {
    const game = createTestGame();
    game.gameWorld.chunks.setFocus('region_capital.c0x0', Number.MAX_SAFE_INTEGER);
    expect(game.gameWorld.chunks.lodOf('region_capital.c0x0')).toBe(0);
    game.dispose();
  });

  it('rejects unknown focus chunks', () => {
    const game = createTestGame();
    expect(() => game.focusChunk('nope.c0x0')).toThrowError();
    game.dispose();
  });

  it('provides simulation levels per region (sim-LOD input)', () => {
    const game = createTestGame();
    const level = game.gameWorld.simulationLevelForRegion('region_capital');
    expect(['detailed', 'light', 'abstract']).toContain(level);
    game.dispose();
  });
});
