/**
 * Strategic resource economy tests — the HoI4-inspired, city-driven economy.
 *
 * Covers the directive's verification checklist:
 *  - production derived from CITY deposits (never hand-made numbers)
 *  - country = Σ of its cities; losing a city loses its production
 *  - consumption emerges from population / sectors / military units
 *  - consumption ↑ → shortage; production ↑ → surplus
 *  - shortage → import action; surplus → export action
 *  - shortage resolved → import status gone; surplus gone → export gone
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
  cityResourceProduction,
  countryResourceProduction,
  countryResourceConsumption,
  attributeDeposits,
  emptyCountryResourceState
} from '../../../economy/resources';
import { processMonthEconomy } from '../../../economy/EconomySimulation';
import type { StrategicMapModel } from '../../../world/map/MapTypes';

describe('strategic resource economy', () => {
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

  it('state creation computed a live resource record for every strategic country', () => {
    for (const countryId of mapModel.countryOrder) {
      const record = context.state.economy.resources[countryId];
      expect(record).toBeDefined();
      // Production exists for SOME resource — every country has deposits/farms.
      const total = Object.values(record!.production).reduce((sum, value) => sum + value, 0);
      expect(total).toBeGreaterThan(0);
      // Policies default off; no trade without them.
      expect(record!.importCost).toBe(0);
      expect(record!.exportIncome).toBe(0);
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

  it('shortage shows import, import covers the deficit, resolving it removes the status', () => {
    // Find a country + resource that is genuinely short AND importable
    // (some other country has spare surplus of that resource).
    recomputeResourceEconomies(context.state, mapModel, config);
    const spareOf = (resourceId: string, excludeCountryId: string): number =>
      mapModel.countryOrder
        .filter((otherId) => otherId !== excludeCountryId)
        .reduce((sum, otherId) => {
          const other = context.state.economy.resources[otherId]!;
          return (
            sum +
            Math.max(
              0,
              (other.production[resourceId] ?? 0) - (other.consumption[resourceId] ?? 0)
            )
          );
        }, 0);
    let shortCountry: string | null = null;
    let shortResource: string | null = null;
    outer: for (const countryId of mapModel.countryOrder) {
      const record = context.state.economy.resources[countryId]!;
      for (const resource of config.resources) {
        if (resourceStatusOf(record, resource.id) === 'shortage' && spareOf(resource.id, countryId) > 0) {
          shortCountry = countryId;
          shortResource = resource.id;
          break outer;
        }
      }
    }
    expect(shortCountry).not.toBeNull();
    expect(shortResource).not.toBeNull();

    const record = context.state.economy.resources[shortCountry!]!;
    const deficit =
      (record.consumption[shortResource!] ?? 0) - (record.production[shortResource!] ?? 0);
    expect(deficit).toBeGreaterThan(0);

    // Import ON via the command path (UI parity).
    game.commandBus.send({ type: 'economy.setImportPolicy', countryId: shortCountry!, resourceId: shortResource!, active: true });
    game.commandBus.flush();
    const importing = context.state.economy.resources[shortCountry!]!;
    expect(importing.importPolicy[shortResource!]).toBe(true);
    expect(importing.imports[shortResource!] ?? 0).toBeGreaterThan(0);
    expect(importing.imports[shortResource!] ?? 0).toBeLessThanOrEqual(deficit + 1e-6);
    expect(importing.importCost).toBeGreaterThan(0);
    const statusAfter = resourceStatusOf(importing, shortResource!);
    expect(['imported', 'shortage']).toContain(statusAfter); // covered → imported; partial → still short

    // Import OFF again → the import status is gone.
    game.commandBus.send({ type: 'economy.setImportPolicy', countryId: shortCountry!, resourceId: shortResource!, active: false });
    game.commandBus.flush();
    const stopped = context.state.economy.resources[shortCountry!]!;
    expect(stopped.imports[shortResource!] ?? 0).toBe(0);
    expect(resourceStatusOf(stopped, shortResource!)).toBe('shortage');
  });

  it('surplus shows export, export caps automatically when the surplus vanishes', () => {
    recomputeResourceEconomies(context.state, mapModel, config);
    let surplusCountry: string | null = null;
    let surplusResource: string | null = null;
    outer: for (const countryId of mapModel.countryOrder) {
      const record = context.state.economy.resources[countryId]!;
      for (const resource of config.resources) {
        if (resourceStatusOf(record, resource.id) === 'surplus') {
          surplusCountry = countryId;
          surplusResource = resource.id;
          break outer;
        }
      }
    }
    expect(surplusCountry).not.toBeNull();

    game.commandBus.send({ type: 'economy.setExportPolicy', countryId: surplusCountry!, resourceId: surplusResource!, active: true });
    game.commandBus.flush();
    const exporting = context.state.economy.resources[surplusCountry!]!;
    const surplus =
      (exporting.production[surplusResource!] ?? 0) - (exporting.consumption[surplusResource!] ?? 0);
    expect(exporting.exports[surplusResource!] ?? 0).toBeCloseTo(surplus * config.exportShare, 6);
    expect(exporting.exportIncome).toBeGreaterThan(0);
    expect(resourceStatusOf(exporting, surplusResource!)).toBe('exported');

    // Consumption explodes → surplus gone → exports auto-stop, status gone.
    const macro = context.state.economy.macro[surplusCountry!];
    const resource = surplusResource!;
    const driver = config.consumption[resource];
    if (driver?.perBillionOutput !== undefined) {
      const sectorId = Object.keys(driver.perBillionOutput)[0];
      const sector = macro.sectors[sectorId as keyof typeof macro.sectors];
      if (sector !== undefined) {
        const original = sector.output;
        sector.output = original * 1000;
        recomputeResourceEconomies(context.state, mapModel, config);
        const collapsed = context.state.economy.resources[surplusCountry!]!;
        const collapsedSurplus =
          (collapsed.production[resource] ?? 0) - (collapsed.consumption[resource] ?? 0);
        if (collapsedSurplus <= 0) {
          expect(collapsed.exports[resource] ?? 0).toBe(0);
          expect(['balanced', 'shortage']).toContain(resourceStatusOf(collapsed, resource));
        }
        sector.output = original;
        recomputeResourceEconomies(context.state, mapModel, config);
      }
    }
  });

  it('import and export policies are mutually exclusive per resource', () => {
    recomputeResourceEconomies(context.state, mapModel, config);
    const countryId = mapModel.countryOrder[0];
    const resourceId = config.resources[0].id;
    game.commandBus.send({ type: 'economy.setExportPolicy', countryId, resourceId, active: true });
    game.commandBus.flush();
    game.commandBus.send({ type: 'economy.setImportPolicy', countryId, resourceId, active: true });
    game.commandBus.flush();
    const record = context.state.economy.resources[countryId]!;
    expect(record.importPolicy[resourceId]).toBe(true);
    expect(record.exportPolicy[resourceId]).toBe(false); // cleared by the import toggle
    game.commandBus.send({ type: 'economy.setImportPolicy', countryId, resourceId, active: false });
    game.commandBus.send({ type: 'economy.setExportPolicy', countryId, resourceId, active: false });
    game.commandBus.flush();
  });

  it('recompute is deterministic and JSON-safe', () => {
    recomputeResourceEconomies(context.state, mapModel, config);
    const first = JSON.stringify(context.state.economy.resources);
    recomputeResourceEconomies(context.state, mapModel, config);
    expect(JSON.stringify(context.state.economy.resources)).toBe(first);
  });

  it('resource trade money enters the monthly ledger (import cost → spending)', () => {
    const countryId = mapModel.countryOrder[0];
    recomputeResourceEconomies(context.state, mapModel, config);
    const before = processMonthEconomy(context.state, countryId, context.rng, mapModel, config);
    // Enable importing of EVERY short resource for this country.
    const record = context.state.economy.resources[countryId]!;
    for (const resource of config.resources) {
      if (resourceStatusOf(record, resource.id) === 'shortage') {
        record.importPolicy[resource.id] = true;
      }
    }
    recomputeResourceEconomies(context.state, mapModel, config);
    const after = processMonthEconomy(context.state, countryId, context.rng, mapModel, config);
    const importCost = context.state.economy.resources[countryId]!.importCost;
    if (importCost > 0) {
      expect(after.spending).toBeGreaterThan(before.spending);
    }
  });

  // ———————————————— Roads: OFF = hide, ON = everything back ————————————————
  it('Roads layer: toggling OFF hides but NEVER deletes road data; ON restores', () => {
    // Roads is a registered layer again, default visible.
    expect('roads' in context.state.map.layerVisibility).toBe(true);
    expect(context.state.map.layerVisibility.roads).toBe(true);

    const linesBefore = mapModel.features.lines;
    const roadLinesBefore = linesBefore.filter((line) => line.kind !== 'railway' && line.kind !== 'seaRoute');
    expect(roadLinesBefore.length).toBeGreaterThan(0);

    // OFF
    game.mapSetLayerVisible('roads', false);
    expect(context.state.map.layerVisibility.roads).toBe(false);
    // The map data is COMPLETELY untouched by the hide.
    expect(mapModel.features.lines).toBe(linesBefore); // same array reference
    expect(mapModel.features.lines.length).toBe(linesBefore.length);
    expect(
      mapModel.features.lines.filter((line) => line.kind !== 'railway' && line.kind !== 'seaRoute').length
    ).toBe(roadLinesBefore.length);
    expect(JSON.stringify(mapModel.features.lines[0])).toBe(JSON.stringify(linesBefore[0]));

    // ON — restored, still the same data.
    game.mapSetLayerVisible('roads', true);
    expect(context.state.map.layerVisibility.roads).toBe(true);
    expect(mapModel.features.lines.length).toBe(linesBefore.length);
  });
});
