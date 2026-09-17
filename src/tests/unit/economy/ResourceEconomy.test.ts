/**
 * Strategic resource economy + GLOBAL TRADE NETWORK tests.
 *
 * Covers the directive's required checklist (Tests 1–7) against the LIVE
 * game state, plus the standing invariants:
 *  - production derived from CITY deposits (+ geography baseline)
 *  - country = Σ of its cities; losing a city loses its production
 *  - consumption emerges from population / sectors / military units
 *  - trade resolves at WORLD level: any surplus country ↔ any shortage
 *    country, even with NO player involvement
 *  - import only for a REAL domestic shortage (never for self-produced
 *    resources); exports are what was ACTUALLY sold (never fake offers)
 *  - unfilled shortage only when the GLOBAL supply cannot cover demand
 *  - Roads ON/OFF — OFF hides, never deletes; ON restores everything
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestGame } from '../../helpers/testGame';
import type { Game } from '../../../core/Game';
import type { SystemContext } from '../../../core/GameContext';
import {
  recomputeResourceEconomies,
  resourceStatusOf,
  resourceBalanceOf,
  resourceRawBalanceOf,
  resourceDisplayStatusOf,
  cityResourceProduction,
  countryResourceProduction,
  countryResourceConsumption,
  attributeDeposits,
  emptyCountryResourceState
} from '../../../economy/resources';
import { resolveWorldTradeForResource } from '../../../economy/tradeNetwork';
import { marketPriceTierOf } from '../../../economy/market';
import { processMonthEconomy } from '../../../economy/EconomySimulation';
import type { StrategicMapModel } from '../../../world/map/MapTypes';

describe('strategic resource economy (global trade network)', () => {
  let game: Game;
  let context: SystemContext;
  let mapModel: StrategicMapModel;
  let config: SystemContext['data']['economyData']['strategicResources'];

  beforeAll(() => {
    game = createTestGame({ seed: 4242 });
    context = game.gameContext;
    mapModel = context.map;
    config = context.data.economyData.strategicResources;
  });

  /** Σ of the TRUE surplus (max(P−C, 0)) of a resource over the given countries. */
  function globalSupplyOf(resourceId: string, countryIds: readonly string[]): number {
    return countryIds.reduce((sum, countryId) => {
      const record = context.state.economy.resources[countryId]!;
      const balance =
        (record.production[resourceId] ?? 0) - (record.consumption[resourceId] ?? 0);
      return sum + Math.max(0, balance);
    }, 0);
  }

  /** Σ of the TRUE shortage (max(C−P, 0)) of a resource over the given countries. */
  function globalDemandOf(resourceId: string, countryIds: readonly string[]): number {
    return countryIds.reduce((sum, countryId) => {
      const record = context.state.economy.resources[countryId]!;
      const balance =
        (record.production[resourceId] ?? 0) - (record.consumption[resourceId] ?? 0);
      return sum + Math.max(0, -balance);
    }, 0);
  }

  it('state creation computed a live resource record for every strategic country', () => {
    for (const countryId of mapModel.countryOrder) {
      const record = context.state.economy.resources[countryId];
      expect(record).toBeDefined();
      // Production exists for SOME resource — every country has deposits/farms.
      const total = Object.values(record!.production).reduce((sum, value) => sum + value, 0);
      expect(total).toBeGreaterThan(0);
      // Trade flows are internally consistent from the very first pass.
      const importSum = Object.values(record!.imports).reduce((sum, value) => sum + value, 0);
      expect(record!.importCost).toBeGreaterThanOrEqual(0);
      expect(importSum).toBeGreaterThanOrEqual(0);
    }
  });

  it('production comes from attributed city deposits (country = Σ cities)', () => {
    const attributions = attributeDeposits(mapModel);
    expect(attributions.length).toBe(mapModel.features.deposits.length);
    for (const countryId of mapModel.countryOrder) {
      const country = mapModel.countries[countryId];
      let citySum = 0;
      for (const cityId of country.cityIds) {
        const production = cityResourceProduction(mapModel, cityId, config);
        citySum += Object.values(production).reduce((sum, value) => sum + value, 0);
      }
      const countryProduction = countryResourceProduction(mapModel, countryId, config);
      const countrySum = Object.values(countryProduction).reduce((sum, value) => sum + value, 0);
      expect(citySum).toBeCloseTo(countrySum, 6);
    }
  });

  it('every deposit resource is a known strategic resource (map ↔ data link)', () => {
    const known = new Set(config.resources.map((resource) => resource.id));
    for (const deposit of mapModel.features.deposits) {
      expect(known.has(deposit.resourceId)).toBe(true);
    }
    // Wood (forest) and copper (mountain ores) actually exist on this map.
    const present = new Set(mapModel.features.deposits.map((deposit) => deposit.resourceId));
    expect(present.has('wood')).toBe(true);
    expect(present.has('copper')).toBe(true);
  });

  it('countries differ economically — production vectors are not uniform', () => {
    const totals = mapModel.countryOrder.map((countryId) => {
      const production = countryResourceProduction(mapModel, countryId, config);
      return Object.values(production).reduce((sum, value) => sum + value, 0);
    });
    expect(new Set(totals).size).toBeGreaterThan(1);
    // SOME resource is produced by some countries and not others — the map
    // geography (deserts, forests, mountains) differentiates economies.
    const partialProducer = config.resources.find((resource) => {
      const producers = mapModel.countryOrder.filter(
        (countryId) => (countryResourceProduction(mapModel, countryId, config)[resource.id] ?? 0) > 0
      );
      return producers.length > 0 && producers.length < mapModel.countryOrder.length;
    });
    expect(partialProducer).toBeDefined();
  });

  it('losing a city removes its production from the country (war-safe recompute)', () => {
    // Deep-clone the JSON-safe model and hand one city to another country —
    // recompute is a pure function of the live model, so this simulates a
    // border change / city loss without touching the shared model.
    const clone = JSON.parse(JSON.stringify(mapModel)) as StrategicMapModel;
    const loserId = mapModel.countryOrder[0];
    const winnerId = mapModel.countryOrder[1];
    const loserCities = [...clone.countries[loserId].cityIds];
    expect(loserCities.length).toBeGreaterThan(0);
    const transferredId = loserCities[0];
    // The JSON clone is mutable data typed as readonly — mutate through a
    // mutable view (city country + membership are the ONLY sources read).
    const mutable = clone as unknown as {
      cities: Record<string, { countryId: string }>;
      countries: Record<string, { cityIds: string[] }>;
    };
    mutable.cities[transferredId].countryId = winnerId;
    mutable.countries[loserId].cityIds = loserCities.filter((id) => id !== transferredId);
    mutable.countries[winnerId].cityIds = [...mutable.countries[winnerId].cityIds, transferredId];

    const before = countryResourceProduction(mapModel, loserId, config);
    const after = countryResourceProduction(clone, loserId, config);
    const winnerBefore = countryResourceProduction(mapModel, winnerId, config);
    const winnerAfter = countryResourceProduction(clone, winnerId, config);

    const beforeSum = Object.values(before).reduce((sum, value) => sum + value, 0);
    const afterSum = Object.values(after).reduce((sum, value) => sum + value, 0);
    expect(afterSum).toBeLessThan(beforeSum); // the lost city's production is gone
    const winnerSumBefore = Object.values(winnerBefore).reduce((sum, value) => sum + value, 0);
    const winnerSumAfter = Object.values(winnerAfter).reduce((sum, value) => sum + value, 0);
    expect(winnerSumAfter).toBeGreaterThan(winnerSumBefore); // the conqueror gains it
  });

  it('consumption emerges from population, sectors and military units', () => {
    const countryId = mapModel.countryOrder[0];
    const base = countryResourceConsumption(context.state, countryId, config);
    const baseFood = base.food ?? 0;
    expect(baseFood).toBeGreaterThan(0);

    // Population ↑ → food consumption ↑ (never manual numbers).
    const countries = context.state.countries.countries as Record<string, { population: number }>;
    const originalPopulation = countries[countryId].population;
    countries[countryId] = { ...countries[countryId], population: originalPopulation * 3 };
    const grown = countryResourceConsumption(context.state, countryId, config);
    expect(grown.food ?? 0).toBeGreaterThan(baseFood);
    countries[countryId] = { ...countries[countryId], population: originalPopulation };

    // Industry output ↑ → iron consumption ↑.
    const macro = context.state.economy.macro[countryId];
    const originalIndustry = macro.sectors.industry.output;
    macro.sectors.industry.output = originalIndustry * 10;
    const industrial = countryResourceConsumption(context.state, countryId, config);
    expect(industrial.iron ?? 0).toBeGreaterThan(base.iron ?? 0);
    macro.sectors.industry.output = originalIndustry;
  });

  it('status derivation: surplus / balanced / shortage / imported / exported', () => {
    const make = (over: Partial<Record<'production' | 'consumption' | 'imports' | 'exports', Record<string, number>>>) => ({
      ...emptyCountryResourceState(),
      ...over
    });
    expect(resourceStatusOf(make({ production: { oil: 50 }, consumption: { oil: 80 } }), 'oil')).toBe('shortage');
    expect(
      resourceStatusOf(make({ production: { oil: 50 }, consumption: { oil: 80 }, imports: { oil: 30 } }), 'oil')
    ).toBe('imported');
    expect(resourceStatusOf(make({ production: { oil: 50 }, consumption: { oil: 50 } }), 'oil')).toBe('balanced');
    expect(resourceStatusOf(make({ production: { oil: 150 }, consumption: { oil: 90 } }), 'oil')).toBe('surplus');
    expect(
      resourceStatusOf(make({ production: { oil: 150 }, consumption: { oil: 90 }, exports: { oil: 30 } }), 'oil')
    ).toBe('exported');
    // Partial import coverage is still an honest shortage.
    expect(
      resourceStatusOf(make({ production: { oil: 50 }, consumption: { oil: 80 }, imports: { oil: 10 } }), 'oil')
    ).toBe('shortage');
    expect(resourceBalanceOf(make({ production: { oil: 50 }, consumption: { oil: 80 }, imports: { oil: 30 } }), 'oil')).toBe(0);
  });

  // ———————————— THE DIRECTIVE'S TESTS 1–7 (live world state) ————————————

  it('Test 1 + 7: a country never imports a resource it produces enough of', () => {
    recomputeResourceEconomies(context.state, mapModel, config);
    let checked = 0;
    for (const countryId of mapModel.countryOrder) {
      const record = context.state.economy.resources[countryId]!;
      for (const resource of config.resources) {
        const production = record.production[resource.id] ?? 0;
        const consumption = record.consumption[resource.id] ?? 0;
        if (production >= consumption) {
          // Self-sufficient → NO imports, NO unfilled shortage, ever.
          expect(record.imports[resource.id] ?? 0).toBe(0);
          expect(record.unfilledShortage[resource.id] ?? 0).toBe(0);
          expect(Object.keys(record.suppliers[resource.id] ?? {})).toEqual([]);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0); // the invariant held on real countries
  });

  it('Test 2: shortage + seller ⇒ import = shortage, final shortage = 0', () => {
    recomputeResourceEconomies(context.state, mapModel, config);
    const order = mapModel.countryOrder;
    // When the GLOBAL supply covers the GLOBAL demand (spec §7), EVERY buyer
    // must be filled completely. Find a resource whose market clears, then
    // its LARGEST buyer (served first by the deterministic matcher).
    let found = false;
    for (const resource of config.resources) {
      const supply = globalSupplyOf(resource.id, order);
      const demand = globalDemandOf(resource.id, order);
      if (demand <= 0 || supply < demand) continue;
      let largestBuyer: string | null = null;
      let largestShortage = 0;
      for (const countryId of order) {
        const record = context.state.economy.resources[countryId]!;
        const shortage =
          (record.consumption[resource.id] ?? 0) - (record.production[resource.id] ?? 0);
        if (shortage > largestShortage) {
          largestShortage = shortage;
          largestBuyer = countryId;
        }
      }
      expect(largestBuyer).not.toBeNull();
      const record = context.state.economy.resources[largestBuyer!]!;
      // THE exact math: import fills the WHOLE shortage (P + I − C = 0).
      expect(record.imports[resource.id] ?? 0).toBe(largestShortage);
      expect(resourceBalanceOf(record, resource.id)).toBeCloseTo(0, 2);
      expect(resourceStatusOf(record, resource.id)).toBe('imported');
      expect(resourceDisplayStatusOf(record, resource.id)).toBe('balanced');
      expect(record.unfilledShortage[resource.id] ?? 0).toBe(0);
      expect(Object.keys(record.suppliers[resource.id] ?? {}).length).toBeGreaterThan(0);
      found = true;
      break;
    }
    expect(found).toBe(true); // such a market exists on this map
  });

  it('Test 3: surplus ⇒ export potential > 0 (sold when the world buys)', () => {
    recomputeResourceEconomies(context.state, mapModel, config);
    let found = false;
    for (const countryId of mapModel.countryOrder) {
      const record = context.state.economy.resources[countryId]!;
      for (const resource of config.resources) {
        const surplus =
          (record.production[resource.id] ?? 0) - (record.consumption[resource.id] ?? 0);
        if (surplus <= 0) continue;
        // Export POTENTIAL is the full true surplus; exports are only what
        // was ACTUALLY bought by someone this month.
        const sold = record.exports[resource.id] ?? 0;
        expect(sold).toBeGreaterThanOrEqual(0);
        expect(sold).toBeLessThanOrEqual(surplus);
        if (sold > 0) {
          expect(resourceStatusOf(record, resource.id)).toBe('exported');
          expect(record.exportIncome).toBeGreaterThan(0);
        }
        found = true;
        break;
      }
      if (found) break;
    }
    expect(found).toBe(true);
    // And SOMEONE in the world actually sold something (the market trades).
    const sellers = mapModel.countryOrder.filter((countryId) =>
      Object.values(context.state.economy.resources[countryId]!.exports).some((amount) => amount > 0)
    );
    expect(sellers.length).toBeGreaterThan(0);
  });

  it('Test 4 + 5: countries trade with EACH OTHER even when one country sits out', () => {
    recomputeResourceEconomies(context.state, mapModel, config);
    // For EVERY candidate "inactive" country: does the REST of the world
    // still trade among itself? At least one world must (Test 4's premise:
    // the player not being in a trade never blocks the others).
    let worldTradesWithoutSomeone = false;
    for (const excludedId of mapModel.countryOrder) {
      const others = mapModel.countryOrder.filter((id) => id !== excludedId);
      let aiToAiFlows = 0;
      for (const buyerId of others) {
        const record = context.state.economy.resources[buyerId]!;
        for (const sellers of Object.values(record.suppliers)) {
          for (const [sellerId, amount] of Object.entries(sellers)) {
            if (sellerId !== excludedId && sellerId !== buyerId && amount > 0) aiToAiFlows++;
          }
        }
      }
      if (aiToAiFlows > 0) {
        worldTradesWithoutSomeone = true;
        break;
      }
    }
    expect(worldTradesWithoutSomeone).toBe(true); // the world does NOT revolve around one country
    // Whatever country the player IS, it participates only where its own
    // economy requires it (Test 7's invariant holds world-wide — Test 1).
    for (const countryId of mapModel.countryOrder) {
      const record = context.state.economy.resources[countryId]!;
      for (const resource of config.resources) {
        const shortage =
          (record.consumption[resource.id] ?? 0) - (record.production[resource.id] ?? 0);
        if (shortage <= 0) {
          expect(record.imports[resource.id] ?? 0).toBe(0);
        } else {
          expect(record.imports[resource.id] ?? 0).toBeLessThanOrEqual(shortage);
        }
      }
    }
  });

  it('Test 6: global supply < global demand ⇒ honest unfilled shortages remain', () => {
    const order = mapModel.countryOrder;
    const resourceId = 'iron';
    // Drive ONE country's consumption to Dwarf the whole world supply —
    // the market cannot cover everyone, so the remainder stays unfilled.
    const victimId = order[0];
    const victimMacro = context.state.economy.macro[victimId];
    const originalIndustry = victimMacro.sectors.industry.output;
    victimMacro.sectors.industry.output = originalIndustry * 100_000;
    recomputeResourceEconomies(context.state, mapModel, config);

    const supply = globalSupplyOf(resourceId, order);
    const demand = globalDemandOf(resourceId, order);
    expect(demand).toBeGreaterThan(supply);
    // Every buyer's imports are capped by the market; the shortage left
    // open is exactly C − P − I, and Σ(unfilled) = global demand − supply.
    let unfilledTotal = 0;
    for (const countryId of order) {
      const record = context.state.economy.resources[countryId]!;
      const consumption = record.consumption[resourceId] ?? 0;
      const production = record.production[resourceId] ?? 0;
      const imports = record.imports[resourceId] ?? 0;
      const unfilled = record.unfilledShortage[resourceId] ?? 0;
      const trueShortage = Math.max(0, consumption - production);
      if (trueShortage > 0) {
        expect(imports).toBeLessThanOrEqual(trueShortage);
        expect(unfilled).toBe(Math.max(0, trueShortage - imports));
      } else {
        expect(unfilled).toBe(0);
      }
      unfilledTotal += unfilled;
    }
    expect(unfilledTotal).toBeCloseTo(demand - supply, 6);
    expect(unfilledTotal).toBeGreaterThan(0);

    // Restore the world and leave a clean state for the following tests.
    victimMacro.sectors.industry.output = originalIndustry;
    recomputeResourceEconomies(context.state, mapModel, config);
  });

  it('exports are ACTUAL flows: every sold unit appears on exactly one buyer', () => {
    recomputeResourceEconomies(context.state, mapModel, config);
    for (const resource of config.resources) {
      const resourceId = resource.id;
      let soldTotal = 0;
      let boughtTotal = 0;
      for (const countryId of mapModel.countryOrder) {
        const record = context.state.economy.resources[countryId]!;
        soldTotal += record.exports[resourceId] ?? 0;
        boughtTotal += record.imports[resourceId] ?? 0;
        // The supplier amounts sum EXACTLY to the recorded imports.
        const supplierSum = Object.values(record.suppliers[resourceId] ?? {}).reduce(
          (sum, amount) => sum + amount,
          0
        );
        expect(supplierSum).toBe(record.imports[resourceId] ?? 0);
      }
      expect(boughtTotal).toBe(soldTotal); // conservation: every unit lands somewhere
    }
  });

  it('billing uses the GLOBAL market tier (import unit cost = price × markup × tier factor)', () => {
    recomputeResourceEconomies(context.state, mapModel, config);
    const order = mapModel.countryOrder;
    for (const countryId of order) {
      const record = context.state.economy.resources[countryId]!;
      if (record.importCost === 0 && record.exportIncome === 0) continue;
      let expectedImportCost = 0;
      let expectedExportIncome = 0;
      for (const resource of config.resources) {
        const bought = record.imports[resource.id] ?? 0;
        const sold = record.exports[resource.id] ?? 0;
        if (bought === 0 && sold === 0) continue;
        const tier = marketPriceTierOf(context.state.economy.resources, order, resource.id);
        if (bought > 0) {
          expectedImportCost += bought * resource.price * config.importMarkup * config.priceTiers.supply[tier];
        }
        if (sold > 0) {
          expectedExportIncome += sold * resource.price * config.priceTiers.demand[tier];
        }
      }
      expect(record.importCost).toBeCloseTo(expectedImportCost, 1);
      expect(record.exportIncome).toBeCloseTo(expectedExportIncome, 1);
    }
  });

  it('recompute is deterministic and JSON-safe', () => {
    recomputeResourceEconomies(context.state, mapModel, config);
    const first = JSON.stringify(context.state.economy.resources);
    recomputeResourceEconomies(context.state, mapModel, config);
    expect(JSON.stringify(context.state.economy.resources)).toBe(first);
  });

  it('resource trade money enters the monthly ledger (the world pass bills the flows)', () => {
    const countryId = mapModel.countryOrder[0];
    recomputeResourceEconomies(context.state, mapModel, config);
    const record = context.state.economy.resources[countryId]!;
    const importCost = record.importCost;
    const exportIncome = record.exportIncome;

    // Clone the state and zero the trade billing there — the DELTA between
    // the two ledger runs is EXACTLY the trade money.
    const withTrade = context.state;
    const withoutTrade = JSON.parse(JSON.stringify(context.state)) as typeof withTrade;
    const bareRecord = withoutTrade.economy.resources[countryId];
    bareRecord.importCost = 0;
    bareRecord.exportIncome = 0;
    // Keep imports/exports (they are flows, not money) so sector dynamics
    // run identically in both clones.

    const billed = processMonthEconomy(withTrade, countryId, context.rng);
    const bare = processMonthEconomy(withoutTrade, countryId, context.rng);

    if (importCost > 0) {
      expect(billed.spending).toBeCloseTo(bare.spending + importCost, 4);
    } else {
      expect(billed.spending).toBeCloseTo(bare.spending, 4);
    }
    if (exportIncome > 0) {
      expect(billed.revenue).toBeCloseTo(bare.revenue + exportIncome, 4);
    } else {
      expect(billed.revenue).toBeCloseTo(bare.revenue, 4);
    }
  });

  // ———————— Urban Areas + Roads (ONE toggle): OFF = hide, ON = everything back ————————
  it('Urban+Roads layer: toggling OFF hides but NEVER deletes road data; ON restores', () => {
    // The merged toggle is a registered layer, default visible.
    expect('urbanRoads' in context.state.map.layerVisibility).toBe(true);
    expect(context.state.map.layerVisibility.urbanRoads).toBe(true);

    const linesBefore = mapModel.features.lines;
    const roadLinesBefore = linesBefore.filter((line) => line.kind !== 'railway' && line.kind !== 'seaRoute');
    expect(roadLinesBefore.length).toBeGreaterThan(0);

    // OFF
    game.mapSetLayerVisible('urbanRoads', false);
    expect(context.state.map.layerVisibility.urbanRoads).toBe(false);
    // The map data is COMPLETELY untouched by the hide.
    expect(mapModel.features.lines).toBe(linesBefore); // same array reference
    expect(mapModel.features.lines.length).toBe(linesBefore.length);
    expect(
      mapModel.features.lines.filter((line) => line.kind !== 'railway' && line.kind !== 'seaRoute').length
    ).toBe(roadLinesBefore.length);
    expect(JSON.stringify(mapModel.features.lines[0])).toBe(JSON.stringify(linesBefore[0]));

    // ON — restored, still the same data.
    game.mapSetLayerVisible('urbanRoads', true);
    expect(context.state.map.layerVisibility.urbanRoads).toBe(true);
    expect(mapModel.features.lines.length).toBe(linesBefore.length);
  });

  // ———————————— Balance display + the three display statuses (spec §2/§5) ————————————
  it('Balance = Production − Consumption — imports/exports NEVER distort it', () => {
    // The spec's exact example: production 14, consumption 29 → balance −15.
    const record = emptyCountryResourceState();
    record.production['iron'] = 14;
    record.consumption['iron'] = 29;
    expect(resourceRawBalanceOf(record, 'iron')).toBe(-15);
    // 15 imported → 14 + 15 − 29 = 0 post-trade … but the raw balance that
    // the Economy page shows stays production − consumption.
    record.imports['iron'] = 15;
    record.exports['iron'] = 0;
    expect(resourceRawBalanceOf(record, 'iron')).toBe(-15);
    // Exports never distort it either (oil: 26 − 20 = +6 while selling 3).
    record.production['oil'] = 26;
    record.consumption['oil'] = 20;
    record.exports['oil'] = 3;
    expect(resourceRawBalanceOf(record, 'oil')).toBe(6);
  });

  it('display status: surplus / balanced / shortage — covered shortage reads balanced', () => {
    const record = emptyCountryResourceState();
    // Surplus: production above consumption.
    record.production['a'] = 26;
    record.consumption['a'] = 20;
    expect(resourceDisplayStatusOf(record, 'a')).toBe('surplus');
    // Exact balance.
    record.production['b'] = 10;
    record.consumption['b'] = 10;
    expect(resourceDisplayStatusOf(record, 'b')).toBe('balanced');
    // Shortage: uncovered deficit.
    record.production['c'] = 14;
    record.consumption['c'] = 29;
    expect(resourceDisplayStatusOf(record, 'c')).toBe('shortage');
    // Fully covered by imports → the FINAL status is balanced (14+15−29=0).
    record.imports['c'] = 15;
    expect(resourceDisplayStatusOf(record, 'c')).toBe('balanced');
    // Partially covered → still a shortage.
    record.imports['c'] = 5;
    expect(resourceDisplayStatusOf(record, 'c')).toBe('shortage');
  });

  it('every live record agrees: raw balance + display status derived from real numbers', () => {
    recomputeResourceEconomies(context.state, mapModel, config);
    for (const countryId of mapModel.countryOrder) {
      const record = context.state.economy.resources[countryId]!;
      for (const resource of config.resources) {
        const production = record.production[resource.id] ?? 0;
        const consumption = record.consumption[resource.id] ?? 0;
        const imports = record.imports[resource.id] ?? 0;
        expect(resourceRawBalanceOf(record, resource.id)).toBeCloseTo(production - consumption, 6);
        const expected =
          production > consumption + 1e-6
            ? 'surplus'
            : production + imports >= consumption - 1e-4
              ? 'balanced'
              : 'shortage';
        expect(resourceDisplayStatusOf(record, resource.id)).toBe(expected);
      }
    }
  });

  // ————————— Domestic baseline production (spec §3) —————————
  it('every country produces SOME of most resources from its own geography', () => {
    recomputeResourceEconomies(context.state, mapModel, config);
    for (const countryId of mapModel.countryOrder) {
      const record = context.state.economy.resources[countryId]!;
      const zeroCount = config.resources.filter((resource) => (record.production[resource.id] ?? 0) <= 0).length;
      // «هیچ کشوری برای تقریباً همه چیز تولید صفر نداشته باشد» — at most one
      // genuinely rare resource (gold in flat lands) may sit at zero.
      expect(zeroCount).toBeLessThanOrEqual(1);
    }
  });

  it('baseline production is geography-driven — vectors differ, never hand-made', () => {
    recomputeResourceEconomies(context.state, mapModel, config);
    // The production recorded in state is the DEPOSIT production + the
    // geography baseline — baseline only ADDS, never replaces.
    for (const countryId of mapModel.countryOrder) {
      const record = context.state.economy.resources[countryId]!;
      const deposits = countryResourceProduction(mapModel, countryId, config);
      for (const [resourceId, depositAmount] of Object.entries(deposits)) {
        expect(record.production[resourceId] ?? 0).toBeGreaterThanOrEqual(depositAmount - 1e-6);
      }
    }
    // Different geography → different vectors (wood/food/oil spread widely).
    const wood = mapModel.countryOrder.map(
      (countryId) => context.state.economy.resources[countryId]!.production['wood'] ?? 0
    );
    expect(new Set(wood).size).toBeGreaterThan(1);
  });

  // ———————— the §12 pipeline end-to-end through the pure matcher ————————
  it('the world matcher reproduces the spec §12 example exactly (A→B=20, C→B=20)', () => {
    const production: Record<string, Record<string, number>> = {
      a: { food: 100 },
      b: { food: 50 },
      c: { food: 120 },
      d: { food: 70 }
    };
    const consumption: Record<string, Record<string, number>> = {
      a: { food: 80 },
      b: { food: 90 },
      c: { food: 100 },
      d: { food: 60 }
    };
    const result = resolveWorldTradeForResource(['a', 'b', 'c', 'd'], production, consumption, 'food');
    expect(result.globalSupply).toBe(50);
    expect(result.globalDemand).toBe(40);
    expect(result.importsByBuyer['b']).toBe(40);
    expect(result.unfilledByBuyer['b'] ?? 0).toBe(0);
    expect(result.flows.map((flow) => `${flow.sellerId}→${flow.buyerId}:${flow.amount}`)).toEqual([
      'a→b:20',
      'c→b:20'
    ]);
  });
});
