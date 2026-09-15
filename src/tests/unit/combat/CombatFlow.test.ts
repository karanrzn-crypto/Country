import { describe, it, expect } from 'vitest';
import { createTestGame } from '../../helpers/testGame';

/**
 * Integration-style combat flow over the real game (headless):
 * spawn hostile units into the same region → projectiles fly →
 * damage → death → respawn. Fully deterministic with a fixed seed.
 */
describe('CombatSystem flow', () => {
  function spawnOpposingUnits(game: ReturnType<typeof createTestGame>): void {
    game.spawnUnit('tank_platoon', 'republic', 'region_capital');
    game.spawnUnit('tank_platoon', 'neighbor', 'region_capital');
  }

  it('engages hostile units sharing a region: projectiles are fired and damage dealt', () => {
    const game = createTestGame({ seed: 21, configOverrides: { combat: { baseAccuracy: 1 } } });
    spawnOpposingUnits(game);

    let projectiles = 0;
    let damaged = 0;
    game.gameEvents.on('combat.projectileFired', () => projectiles++);
    game.gameEvents.on('combat.entityDamaged', () => damaged++);
    game.runTicks(30);

    expect(projectiles).toBeGreaterThan(0);
    expect(damaged).toBeGreaterThan(0);
    game.dispose();
  });

  it('units eventually die and are marked destroyed in state', () => {
    const game = createTestGame({ seed: 21, configOverrides: { combat: { baseAccuracy: 1 } } });
    spawnOpposingUnits(game);
    let destroyed = 0;
    game.gameEvents.on('combat.entityDestroyed', () => destroyed++);
    game.runTicks(200);
    expect(destroyed).toBeGreaterThan(0);
    const states = Object.values(game.gameState.military.units).map((unit) => unit.operationalState);
    expect(states).toContain('destroyed');
    game.dispose();
  });

  it('destroyed units respawn after the configured delay', () => {
    const game = createTestGame({
      seed: 21,
      configOverrides: { combat: { baseAccuracy: 1, respawnDelayTicks: 10 } }
    });
    spawnOpposingUnits(game);
    const destroyedAt: number[] = [];
    const respawnedAt: number[] = [];
    game.gameEvents.on('combat.entityDestroyed', () => destroyedAt.push(game.gameTime.tick));
    game.gameEvents.on('combat.entityRespawned', () => respawnedAt.push(game.gameTime.tick));
    game.runTicks(300);
    expect(destroyedAt.length).toBeGreaterThan(0);
    expect(respawnedAt.length).toBeGreaterThan(0);
    // Respawn must happen strictly after the death that scheduled it.
    expect(respawnedAt[respawnedAt.length - 1]).toBeGreaterThanOrEqual(destroyedAt[0] + 10);
    game.dispose();
  });

  it('emits engagementStarted exactly once per region engagement', () => {
    const game = createTestGame({ seed: 21, configOverrides: { combat: { baseAccuracy: 1 } } });
    spawnOpposingUnits(game);
    let engagements = 0;
    game.gameEvents.on('combat.engagementStarted', () => engagements++);
    game.runTicks(50);
    expect(engagements).toBe(1);
    game.dispose();
  });

  it('friendly units never fight each other', () => {
    const game = createTestGame({ seed: 21 });
    game.spawnUnit('tank_platoon', 'republic', 'region_capital');
    game.spawnUnit('infantry_squad', 'republic', 'region_capital');
    let projectiles = 0;
    game.gameEvents.on('combat.projectileFired', () => projectiles++);
    game.runTicks(30);
    expect(projectiles).toBe(0);
    game.dispose();
  });

  it('combat can be toggled off', () => {
    const game = createTestGame({ seed: 21, configOverrides: { combat: { baseAccuracy: 1 } } });
    spawnOpposingUnits(game);
    game.toggleCombat();
    let projectiles = 0;
    game.gameEvents.on('combat.projectileFired', () => projectiles++);
    game.runTicks(30);
    expect(projectiles).toBe(0);
    game.dispose();
  });
});
