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

// Phase 2 — governance snapshot for the player's country (or the first
// strategic country while the campaign has not been confirmed yet).
const playerId = game.gameState.player.countryConfirmed
  ? game.gameState.player.countryId
  : map.countryOrder[0];
const government = game.gameState.government.countries[playerId];
const macro = game.gameState.economy.macro[playerId];
const network = game.gameState.cityAreas.network;
const countryAreas = Object.values(network.areas).filter((area) => area.countryId === playerId);
const countryLinks = Object.values(network.links).filter(
  (link) => countryAreas.some((a) => a.id === link.a) && countryAreas.some((a) => a.id === link.b)
);
if (government !== undefined && macro !== undefined) {
  console.log(
    `[headless] government: president=${government.president.name} approval=${(government.president.approval * 100).toFixed(0)}% ` +
      `parties=${Object.keys(government.politics.parties).length} corruption=${(government.politics.corruption * 100).toFixed(0)}% ` +
      `trust=${(government.politics.publicTrust * 100).toFixed(0)}% protests=${government.politics.protests}`
  );
  console.log(
    `[headless] economy: gdp=${macro.gdp.toFixed(0)}M$ growth=${(macro.gdpGrowth * 100).toFixed(1)}% ` +
      `inflation=${(macro.inflation * 100).toFixed(1)}% unemployment=${(macro.unemployment * 100).toFixed(1)}% debt=${macro.debt.toFixed(0)}M$ ` +
      `treasury=${(game.gameState.economy.treasury[playerId] ?? 0).toFixed(0)}M$`
  );
  console.log(
    `[headless] budget: revenue=${macro.lastRevenue.toFixed(1)}M$/mo spending=${macro.lastSpending.toFixed(1)}M$/mo ` +
      `nextElection=month ${government.elections.nextElectionMonth} cityAreas=${countryAreas.length} links=${countryLinks.length} ` +
      `pendingEvents=${government.events.pending.length}`
  );
}

console.log('[headless] simulation + strategic map ran WITHOUT any renderer — core is renderer-independent.');

game.dispose();
