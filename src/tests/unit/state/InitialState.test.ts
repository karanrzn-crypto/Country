import { describe, it, expect } from 'vitest';
import { createTestGame } from '../../helpers/testGame';
import { Game } from '../../../core/Game';
import { IdGenerator } from '../../../core/IdGenerator';
import { createInitialState } from '../../../state/createInitialState';
import { DEFAULT_CONFIG } from '../../../config/configTypes';
import { DataRegistry } from '../../../data/DataRegistry';
import { MemoryLogSink, Logger } from '../../../utils/Logger';

describe('initial game state', () => {
  it('builds a valid, fully-populated state from data-driven JSON', () => {
    const game = createTestGame();
    const state = game.gameState;
    expect(state.world.worldId).toBe('demo-country');
    expect(Object.keys(state.world.countries)).toHaveLength(2);
    expect(Object.keys(state.world.provinces)).toHaveLength(3);
    expect(Object.keys(state.world.regions)).toHaveLength(4);
    // 4 regions × 2×2 chunks
    expect(Object.keys(state.world.chunks)).toHaveLength(16);
    expect(Object.keys(state.economy.factories)).toHaveLength(6);
    expect(Object.keys(state.military.units)).toHaveLength(4);
    expect(Object.keys(state.characters.characters)).toHaveLength(4);
    game.dispose();
  });

  it('units are created with data-driven equipment loadouts', () => {
    const game = createTestGame();
    const units = Object.values(game.gameState.military.units);
    for (const unit of units) {
      expect(unit.soldiersCurrent).toBe(unit.soldiersMax);
      expect(Object.keys(unit.equipment).length).toBeGreaterThan(0);
      expect(unit.operationalState).toBe('idle');
      expect(unit.regionId).not.toBeNull();
    }
    game.dispose();
  });

  it('relations are symmetric (republic ↔ neighbor hostile)', () => {
    const game = createTestGame();
    const relations = game.gameState.diplomacy.relations;
    expect(relations.republic.neighbor).toBe(-45);
    expect(relations.neighbor.republic).toBe(-45);
    game.dispose();
  });

  it('two fresh builds from the same data produce identical states', () => {
    const data = new DataRegistry();
    const idsA = new IdGenerator();
    const idsB = new IdGenerator();
    const a = createInitialState(data, DEFAULT_CONFIG, idsA);
    const b = createInitialState(data, DEFAULT_CONFIG, idsB);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('state passes its own schema validation', () => {
    const sink = new MemoryLogSink();
    void new Logger(sink);
    const game = createTestGame();
    expect(() => {
      // Recreate state and validate — createInitialState already validates;
      // this double-checks after mutation-free construction.
      const data = new DataRegistry();
      const state = createInitialState(data, game.gameConfig, new IdGenerator());
      JSON.stringify(state);
    }).not.toThrow();
    game.dispose();
  });

  it('Game exposes deterministic state hash for identical setups', () => {
    const a = createTestGame({ seed: 7 });
    const b = createTestGame({ seed: 7 });
    expect(a.stateHash()).toBe(b.stateHash());
    a.dispose();
    b.dispose();
  });

  it('refuses to run ticks before init', () => {
    const game = new Game({});
    expect(() => game.runTick()).toThrowError();
  });
});
