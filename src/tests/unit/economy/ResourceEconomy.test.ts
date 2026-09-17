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
  resourceRawBalanceOf,
  resourceDisplayStatusOf,
  cityResourceProduction,
  countryResourceProduction,
  countryResourceConsumption,
  attributeDeposits,
  emptyCountryResourceState
} from '../../../economy/resources';
import { processMonthEconomy } from '../../../economy/EconomySimulation';
import { sellerPriceTiersOf } from '../../../economy/market';
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

  // ————————— Supplier choice + tier pricing (spec §4/§5/§7) —————————
  it('the player can pick the seller; the market honors the pin while it has spare', () => {
    recomputeResourceEconomies(context.state, mapModel, config);
    // Find a country + short resource with at least TWO sellers on the market.
    const spareOf = (resourceId: string, excludeCountryId: string): string[] =>
      mapModel.countryOrder.filter((otherId) => {
        if (otherId === excludeCountryId) return false;
        const other = context.state.economy.resources[otherId]!;
        return (other.production[resourceId] ?? 0) - (other.consumption[resourceId] ?? 0) > 0;
      });
    let buyerId: string | null = null;
    let resourceShort: string | null = null;
    outer: for (const countryId of mapModel.countryOrder) {
      const record = context.state.economy.resources[countryId]!;
      for (const resource of config.resources) {
        if (
          resourceStatusOf(record, resource.id) === 'shortage' &&
          spareOf(resource.id, countryId).length >= 2
        ) {
          buyerId = countryId;
          resourceShort = resource.id;
          break outer;
        }
      }
    }
    if (buyerId === null || resourceShort === null) return; // map lacks such a market — nothing to prove here

    game.commandBus.send({ type: 'economy.setImportPolicy', countryId: buyerId, resourceId: resourceShort, active: true });
    game.commandBus.flush();
    const sellers = spareOf(resourceShort, buyerId);
    const pinned = sellers[sellers.length - 1]; // a specific (not auto-largest) seller
    game.commandBus.send({ type: 'economy.setSupplier', countryId: buyerId, resourceId: resourceShort, supplierId: pinned });
    game.commandBus.flush();

    const record = context.state.economy.resources[buyerId]!;
    expect(record.preferredSuppliers[resourceShort]).toBe(pinned);
    expect(record.suppliers[resourceShort]).toBe(pinned);
    expect(record.imports[resourceShort] ?? 0).toBeGreaterThan(0);

    // Unpin → automatic market choice again.
    game.commandBus.send({ type: 'economy.setSupplier', countryId: buyerId, resourceId: resourceShort, supplierId: null });
    game.commandBus.flush();
    const unpinned = context.state.economy.resources[buyerId]!;
    expect(unpinned.preferredSuppliers[resourceShort] ?? null).toBeNull();
    // Auto still buys from the LARGEST spare seller.
    let largest: string | null = null;
    let largestSpare = 0;
    for (const sellerId of sellers) {
      const seller = context.state.economy.resources[sellerId]!;
      const spare = (seller.production[resourceShort] ?? 0) - (seller.consumption[resourceShort] ?? 0);
      if (spare > largestSpare) {
        largestSpare = spare;
        largest = sellerId;
      }
    }
    expect(unpinned.suppliers[resourceShort]).toBe(largest);
  });

  it('tier pricing: a bigger seller is cheaper — the ledger reflects the tier (§4/§7)', () => {
    recomputeResourceEconomies(context.state, mapModel, config);
    const buyerId = mapModel.countryOrder[0];
    // Any resource this country imports right now (or can import) works.
    let resourceId: string | null = null;
    for (const resource of config.resources) {
      const deficit = (record0Consumption(context, buyerId, resource.id)) - (record0Production(context, buyerId, resource.id));
      const hasSellers = mapModel.countryOrder.some((otherId) => {
        if (otherId === buyerId) return false;
        const other = context.state.economy.resources[otherId]!;
        return (other.production[resource.id] ?? 0) - (other.consumption[resource.id] ?? 0) > 0;
      });
      if (deficit > 0 && hasSellers) {
        resourceId = resource.id;
        break;
      }
    }
    if (resourceId === null) return; // nothing importable on this map — nothing to prove here
    const resource = config.resources.find((candidate) => candidate.id === resourceId)!;

    // Isolate: import ONLY this resource (importCost is a per-country SUM).
    for (const other of config.resources) {
      if (other.id !== resourceId) {
        game.commandBus.send({ type: 'economy.setImportPolicy', countryId: buyerId, resourceId: other.id, active: false });
      }
    }
    game.commandBus.send({ type: 'economy.setImportPolicy', countryId: buyerId, resourceId, active: true });
    game.commandBus.flush();
    const record = context.state.economy.resources[buyerId]!;
    const imports = record.imports[resourceId] ?? 0;
    const supplierId = record.suppliers[resourceId];
    expect(imports).toBeGreaterThan(0);
    expect(supplierId).not.toBeNull();

    // The unit cost = price × markup × tierFactor(supplier tier) — exactly.
    const tiers = sellerPriceTiersOf(context.state.economy.resources, mapModel.countryOrder.filter((id) => id !== buyerId), resourceId);
    const tier = tiers[supplierId!] ?? 'medium';
    const expectedUnitCost = resource.price * config.importMarkup * config.priceTiers.supply[tier];
    expect(record.importCost).toBeGreaterThan(0);
    expect(record.importCost / imports).toBeCloseTo(expectedUnitCost, 1);

    // Export income carries the market's willingness to pay (demand tiers).
    let exporterId: string | null = null;
    let exportResource: string | null = null;
    outer: for (const countryId of mapModel.countryOrder) {
      const candidate = context.state.economy.resources[countryId]!;
      for (const candidateResource of config.resources) {
        if (
          (candidate.production[candidateResource.id] ?? 0) - (candidate.consumption[candidateResource.id] ?? 0) > 0 &&
          mapModel.countryOrder.some((otherId) => {
            const other = context.state.economy.resources[otherId]!;
            return (other.consumption[candidateResource.id] ?? 0) - (other.production[candidateResource.id] ?? 0) > 0;
          })
        ) {
          exporterId = countryId;
          exportResource = candidateResource.id;
          break outer;
        }
      }
    }
    if (exporterId === null || exportResource === null) return;
    game.commandBus.send({ type: 'economy.setExportPolicy', countryId: exporterId, resourceId: exportResource, active: true });
    game.commandBus.flush();
    const exporter = context.state.economy.resources[exporterId]!;
    const sold = exporter.exports[exportResource] ?? 0;
    expect(sold).toBeGreaterThan(0);
    const exportPrice = config.resources.find((candidate) => candidate.id === exportResource)!.price;
    // The unit income is price × (average demand factor) — a REAL market
    // reaction (≥ 0.5 of the base price whatever the mix, sanity-bounded).
    expect(exporter.exportIncome / sold).toBeGreaterThan(0);
    expect(exporter.exportIncome / sold / exportPrice).toBeGreaterThan(0.5);
    expect(exporter.exportIncome / sold / exportPrice).toBeLessThan(1.5);
  });
});

function record0Production(context: { state: import('../../../state/GameState').GameState }, countryId: string, resourceId: string): number {
  return context.state.economy.resources[countryId]?.production[resourceId] ?? 0;
}

function record0Consumption(context: { state: import('../../../state/GameState').GameState }, countryId: string, resourceId: string): number {
  return context.state.economy.resources[countryId]?.consumption[resourceId] ?? 0;
}
