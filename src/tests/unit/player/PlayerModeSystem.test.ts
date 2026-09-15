import { describe, it, expect } from 'vitest';
import { PlayerModeSystem } from '../../../player/PlayerModeSystem';
import { EventBus } from '../../../events/EventBus';
import { createTestGame } from '../../helpers/testGame';
import type { GameState } from '../../../state/GameState';

function makeSystem(): { system: PlayerModeSystem; events: EventBus } {
  const game = createTestGame();
  return { system: game.playerModes, events: game.gameEvents };
}

function stateWithMode(mode: null): GameState {
  const game = createTestGame();
  game.gameState.player.mode = mode;
  return game.gameState;
}

describe('PlayerModeSystem', () => {
  it('starts with no mode and allows entering any mode', () => {
    const { system } = makeSystem();
    const state = stateWithMode(null);
    expect(system.setMode(state, 'president')).toBe(true);
    expect(state.player.mode).toBe('president');
  });

  it('enforces data-driven transitions (president → commander → soldier)', () => {
    const { system } = makeSystem();
    const state = stateWithMode(null);
    expect(system.setMode(state, 'president')).toBe(true);
    expect(system.setMode(state, 'commander')).toBe(true);
    expect(system.setMode(state, 'soldier')).toBe(true);
    // soldier can only go back to commander
    expect(system.setMode(state, 'president')).toBe(false);
    expect(state.player.mode).toBe('soldier');
  });

  it('rejects unknown modes without state changes', () => {
    const { system } = makeSystem();
    const state = stateWithMode(null);
    expect(system.setMode(state, 'dictator' as never)).toBe(false);
  });

  it('emits player.modeChanged on successful transitions', () => {
    const { system, events } = makeSystem();
    const transitions: string[] = [];
    events.on('player.modeChanged', ({ from, to }) => transitions.push(`${from}→${to}`));
    const state = stateWithMode(null);
    system.setMode(state, 'president');
    system.setMode(state, 'commander');
    expect(transitions).toEqual(['null→president', 'president→commander']);
  });

  it('all four Phase-0 modes exist with camera profiles', () => {
    const { system } = makeSystem();
    const ids = system.all.map((mode) => mode.id).sort();
    expect(ids).toEqual(['aircraft', 'commander', 'president', 'soldier']);
    expect(system.modeDef('president').camera).toBe('strategic');
    expect(system.modeDef('soldier').camera).toBe('ground');
  });

  it('Game.setPlayerMode routes through the command flow', () => {
    const game = createTestGame();
    expect(game.setPlayerMode('president')).toBe(true);
    expect(game.gameState.player.mode).toBe('president');
    game.dispose();
  });
});
