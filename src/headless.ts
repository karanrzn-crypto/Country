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
const map = game.strategicMap;
const mapSelection = game.gameState.map;

// Prove headless map interaction: select + focus a country via commands.
const firstCountry = map.countryOrder[0];
game.commandBus.send({ type: 'map.select', countryId: firstCountry });
game.commandBus.send({ type: 'map.focusCountry', countryId: firstCountry });
game.commandBus.flush();

console.log(`[headless] world=${game.gameState.world.worldId} ticks=${ticks} seed=${seed}`);
console.log(`[headless] stateHash=${hash.toString(16)}`);
console.log(`[headless] chunks active=${counts.active} simulated=${counts.simulated} unloaded=${counts.unloaded}`);
console.log(`[headless] units=${units} treasury=${JSON.stringify(treasury)}`);
console.log(
  `[headless] map "${map.continentName}": ${map.stats.countries} countries, ${map.stats.provinces} provinces, ` +
    `${map.stats.cities} cities, coastal=${map.stats.coastalCountries} landlocked=${map.stats.landlockedCountries}, ` +
    `peninsulaCells=${map.stats.peninsulaCells}, bayCells=${map.stats.bayCells}`
);
console.log(
  `[headless] map interaction: selected="${mapSelection.selectedCountryId}" camera=${mapSelection.camera.x.toFixed(1)},${mapSelection.camera.z.toFixed(1)} view=${mapSelection.camera.viewHeight.toFixed(0)}`
);
console.log('[headless] simulation + strategic map ran WITHOUT any renderer — core is renderer-independent.');

game.dispose();
