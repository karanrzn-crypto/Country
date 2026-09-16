import { describe, it, expect } from 'vitest';
import { Game } from '../../core/Game';
import { MemorySaveStorage } from '../../save/SaveStorage';
import { validateGameState } from '../../state/validate';
import { createTestGame } from '../helpers/testGame';

describe('Headless integration (renderer-independent core)', () => {
  it('runs hundreds of ticks without a renderer, staying valid', () => {
    const game = createTestGame({ seed: 1000 });
    game.runTicks(240);
    // Hour mode: one 60-minute clock step per 6 sim ticks → 240 ticks = 40 steps = 2400 min.
    expect(game.gameTime.tick).toBe(2400);
    expect(game.gameTime.step).toBe(240);
    expect(validateGameState(game.gameState).valid).toBe(true);
    const counts = game.gameWorld.counts();
    expect(counts.active).toBeGreaterThan(0);
    game.dispose();
  });

  it('runs full frames with a fake renderer (phase order respected)', () => {
    const seenPhases: string[] = [];
    const game = createTestGame({ seed: 1001 });
    game.gameEvents.on('time.tick', () => seenPhases.push('tick'));
    game.gameEvents.on('ai.orderIssued', () => seenPhases.push('ai'));
    // dt = 1/60 with a 30 Hz sim step → one tick every other frame.
    game.runFrames(120, 1 / 60);
    expect(seenPhases).toContain('tick');
    // 120 frames × 1/60 s at a 30 Hz sim step → 60 sim steps;
    // hour mode: 10 hour-steps → 600 game-minutes.
    expect(game.gameTime.step).toBe(60);
    expect(game.gameTime.tick).toBe(600);
    game.dispose();
  });

  it('emits the full event contract during a run', () => {
    const game = createTestGame({ seed: 1002 });
    const emitted = new Set<string>();
    game.gameEvents.on('time.tick', () => emitted.add('time.tick'));
    game.gameEvents.on('sim.economyProduced', () => emitted.add('sim.economyProduced'));
    game.gameEvents.on('sim.economyTreasuryChanged', () => emitted.add('sim.economyTreasuryChanged'));
    game.gameEvents.on('ai.orderIssued', () => emitted.add('ai.orderIssued'));
    game.gameEvents.on('world.chunkActivated', () => emitted.add('world.chunkActivated'));
    // Frames (not bare ticks) so the streaming phase runs and emits events.
    game.runFrames(120, 1 / 60);
    for (const expected of ['time.tick', 'sim.economyProduced', 'sim.economyTreasuryChanged', 'ai.orderIssued', 'world.chunkActivated']) {
      expect(emitted.has(expected)).toBe(true);
    }
    game.dispose();
  });

  it('commands flow: UI-style commands mutate state through the bus', () => {
    const game = createTestGame({ seed: 1003 });
    game.gameCommands.send({ type: 'game.setSpeed', speed: 4 });
    game.gameCommands.send({ type: 'player.setMode', mode: 'commander' });
    game.gameCommands.send({ type: 'player.focusChunk', chunkId: 'region_west.c0x0' });
    // Commands flush on the next frame's state phase. Speed values snap to
    // the nearest data-driven speed step: 4 → step ×5.
    game.frame(1 / 60);
    expect(game.gameTime.speed).toBe(5);
    expect(game.gameState.player.mode).toBe('commander');
    expect(game.gameState.player.focusChunkId).toBe('region_west.c0x0');
    game.dispose();
  });

  it('save → load → continue produces the identical continuation (integration determinism)', () => {
    const storage = new MemorySaveStorage();

    const reference = new Game({ seed: 4242, saveStorage: storage });
    reference.init();
    reference.runTicks(100);
    reference.saveToSlot('mid', 'Mid-run');
    reference.runTicks(100);
    const referenceHash = reference.stateHash();

    const resumed = new Game({ seed: 9999, saveStorage: storage });
    resumed.init();
    resumed.loadFromSlot('mid');
    resumed.runTicks(100);

    expect(resumed.stateHash()).toBe(referenceHash);
    reference.dispose();
    resumed.dispose();
  });
});
