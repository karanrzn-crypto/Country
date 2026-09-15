/**
 * Headless entry point: runs the full game core (simulation, AI, combat,
 * world streaming, save/load) with NO renderer, NO DOM and NO input.
 *
 * Usage: npm run headless -- [ticks] [seed]
 * Proves Architecture Rule 1 — the core is fully renderer-independent.
 */

/// <reference types="node" />

import { Game } from './core/Game';
import { MemorySaveStorage } from './save/SaveStorage';

const args = process.argv.slice(2);
const ticks = Number.parseInt(args[0] ?? '168', 10) || 168;
const seed = Number.parseInt(args[1] ?? '42', 10) || 42;

const game = new Game({ seed, saveStorage: new MemorySaveStorage() });
game.init();
game.runTicks(ticks);

const hash = game.stateHash();
const counts = game.gameWorld.counts();
const treasury = game.gameState.economy.treasury;
const units = Object.keys(game.gameState.military.units).length;

console.log(`[headless] world=${game.gameState.world.worldId} ticks=${ticks} seed=${seed}`);
console.log(`[headless] stateHash=${hash.toString(16)}`);
console.log(`[headless] chunks active=${counts.active} simulated=${counts.simulated} unloaded=${counts.unloaded}`);
console.log(`[headless] units=${units} treasury=${JSON.stringify(treasury)}`);
console.log('[headless] simulation ran WITHOUT any renderer — core is renderer-independent.');

game.dispose();
