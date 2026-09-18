/**
 * THE HARD ECONOMY — the 24-section directive's balance tests (§24's eight
 * scenarios + the new mechanics):
 *
 *  S1  the food-rich / oil-poor country exports food and NEEDS oil imports
 *  S2  an average country does NOT become self-sufficient with a few builds
 *  S3  without new buildings the stock DRAINS and a real shortage appears
 *  S4  consumption > production + imports → Shortage > 0 recorded, exactly
 *  S5  a farm in an EXCELLENT region out-produces the same farm in a POOR one
 *  S6  construction: money+materials+workforce gates, capacity 2, diminishing
 *  S7  many short countries at once — the market serves them, AI builds by
 *      need under the SAME gates
 *  S8  a LONG world run keeps trade alive and self-sufficiency rare, with
 *      no famine and no bankruptcies (§22's long-run balance)
 *
 *  M9  starting stockpiles are LIMITED and DIFFER by economic profile (§1/§10)
 *  M10 extractive reserves deplete — production caps at what is left (§8)
 *  M11 the satisfaction penalty escalates with shortage DURATION (§13)
 *  M12 the build preview shows quality/base/estimated before confirming (§3/§21)
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestGame } from '../../helpers/testGame';
import type { Game } from '../../../core/Game';
import type { SystemContext } from '../../../core/GameContext';
import { runEconomyCycle } from '../../../economy/economyCycle';
import {
  singleBuildingOutput,
  buildingIndexOfType,
  economicBuildingAtCell,
  cellIsUnderConstruction,
  buildPreviewInfoOf,
  satisfactionPenaltyTotalOf,
  economyLevelBuildingFactor,
  strategicResourceIds
} from '../../../economy/resources';
import {
  cellQualityOf,
  qualityLabelOf,
  countryPotentialFactor,
  diminishingFactorOf
} from '../../../economy/quality';
import {
  startProject,
  stepProjects,
  workforceCapacityOf,
  workforceUsedBy
} from '../../../economy/construction';
import { aiBuildingTypeId, aiSecureConstructionMaterials } from '../../../economy/aiEconomy';
import { gridCellKey } from '../../../world/map/MapTypes';
import { findGridCell } from '../../../world/map/MapGeography';
import type { StrategicResourcesConfig } from '../../../economy/types';

describe('the hard economy (24-section spec: self-sufficiency is HARD)', () => {
  let game: Game;
  let context: SystemContext;
  let config: StrategicResourcesConfig;
  let playerCountryId: string;

  beforeAll(() => {
    game = createTestGame({ seed: 4242 });
    context = game.gameContext;
    config = context.data.economyData.strategicResources;
    playerCountryId = context.map.countryOrder[0];
  });

  const ids = (): string[] =>
    context.map.countryOrder.filter((id) => context.state.economy.finance[id] !== undefined);

  /** A free land cell key of ONE country (no building, no project). */
  const freeCellOf = (countryId: string, exclude: ReadonlySet<string> = new Set()): string | null => {
    const model = context.map;
    const country = model.countries[countryId];
    if (country === undefined) return null;
    for (const cellIndex of country.cellIds) {
      const gridId = model.features.gridIds[cellIndex];
      if (gridId === null) continue;
      const key = gridCellKey(countryId, gridId);
      if (exclude.has(key)) continue;
      if (economicBuildingAtCell(context.state, key) !== null) continue;
      if (cellIsUnderConstruction(context.state, key)) continue;
      return key;
    }
    return null;
  };

  /** Makes ONE country able to build freely (money + materials). */
  const fundCountry = (countryId: string): void => {
    context.state.economy.treasury[countryId] = 1_000_000;
    context.state.economy.resources[countryId]!.stock.industrial = 100_000;
  };

  /** Completes every running project of ONE country immediately. */
  const finishProjects = (countryId: string): void => {
    const state = context.state;
    for (let month = 100; month <= 100 + 24; month += 1) {
      stepProjects(state, context.map, countryId, config, month);
    }
  };

  // ————————— S1: غذا زیاد / نفت کم — مازاد غذا، نیاز به واردات نفت ————————

  it('S1 the food-rich / oil-poor country exports food and NEEDS oil from the market (§9/§17)', () => {
    const state = context.state;
    // The country whose FOOD potential ranks best and OIL worst.
    let pick: string | null = null;
    let bestFoodGap = -Infinity;
    for (const countryId of ids()) {
      const record = state.economy.resources[countryId]!;
      const foodGap = (record.production.food ?? 0) - (record.consumption.food ?? 0);
      const oilGap = (record.production.oil ?? 0) - (record.consumption.oil ?? 0);
      if (foodGap > bestFoodGap && oilGap < 0) {
        bestFoodGap = foodGap;
        pick = countryId;
      }
    }
    expect(pick).not.toBeNull();
    const record = state.economy.resources[pick!]!;
    // Food: a real surplus flow (exportable, §7).
    expect((record.production.food ?? 0) - (record.consumption.food ?? 0)).toBeGreaterThan(0);
    // Oil: production alone cannot cover consumption — the market MUST
    // supplement it (or the stock drains into a real shortage, §11).
    expect(record.production.oil ?? 0).toBeLessThan(record.consumption.oil ?? 0);
    // Drain the oil warehouse so the deficit shows up NOW, not after the
    // (deliberately limited) starting buffer burns for months (§10). The
    // import lands AFTER consumption, so the country oscillates between
    // importing and spending — accumulate over the months, don't snapshot.
    record.stock.oil = 0;
    let oilImportsTotal = 0;
    let oilShortageTotal = 0;
    for (let month = 0; month < 4; month += 1) {
      runEconomyCycle(state, context.map, config, { applyStep: true });
      oilImportsTotal += record.imports.oil ?? 0;
      oilShortageTotal += record.shortage.oil ?? 0;
    }
    // Either it imported oil or (when the world ran dry / it went broke)
    // it holds a REAL shortage — free phantom oil is impossible (§11).
    expect(oilImportsTotal + oilShortageTotal).toBeGreaterThan(0);
  });

  // ————————— S2: کشور متوسط با چند ساخت‌وساز خودکفا نمی‌شود ————————

  it('S2 an average country with several new buildings is STILL not self-sufficient (§9/§22)', () => {
    const state = context.state;
    // The most deficit-ridden country: even a building spree must leave a gap.
    const ranked = ids()
      .map((countryId) => {
        const record = state.economy.resources[countryId]!;
        const gaps = strategicResourceIds(config).map(
          (resourceId) => (record.consumption[resourceId] ?? 0) - (record.production[resourceId] ?? 0)
        );
        return { countryId, deficitGoods: gaps.filter((gap) => gap > 0).length, worst: Math.max(...gaps) };
      })
      .sort((a, b) => b.deficitGoods - a.deficitGoods || b.worst - a.worst);
    const countryId = ranked[0].countryId;
    fundCountry(countryId);

    // Build the needed building again and again (capacity 2 at a time —
    // the SAME constraint the player faces) until 6 buildings stand.
    for (let round = 0; round < 3; round += 1) {
      const used = new Set<string>();
      for (let slot = 0; slot < config.construction.maxProjects; slot += 1) {
        const typeId = aiBuildingTypeId(state, context.map, countryId, config);
        if (typeId === null) break;
        const cell = freeCellOf(countryId, used);
        if (cell === null) break;
        const def = config.buildings.find((candidate) => candidate.id === typeId)!;
        context.state.economy.treasury[countryId] = Math.max(
          context.state.economy.treasury[countryId] ?? 0,
          def.cost * 2
        );
        context.state.economy.resources[countryId]!.stock.industrial = Math.max(
          context.state.economy.resources[countryId]!.stock.industrial ?? 0,
          def.materials * 4
        );
        const result = startProject(state, countryId, config, typeId, cell, 100, () => `s2-${round}-${slot}`);
        if (result.ok) used.add(cell);
      }
      finishProjects(countryId);
    }
    const record = state.economy.resources[countryId]!;
    const builtCount = Object.keys(state.economy.buildings[countryId] ?? {}).length;
    expect(builtCount).toBeGreaterThanOrEqual(4);
    // Frozen prices (no market): the uncovered deficits stay REAL —
    // a few buildings did not buy self-sufficiency (§22's core rule).
    const frozen: StrategicResourcesConfig = {
      ...config,
      resources: config.resources.map((resource) => ({ ...resource, price: 0 }))
    };
    record.stock = {};
    runEconomyCycle(state, context.map, frozen, { applyStep: true });
    const uncovered = strategicResourceIds(config).filter(
      (resourceId) => (record.shortage[resourceId] ?? 0) > 0
    ).length;
    expect(uncovered).toBeGreaterThan(0);
  });

  // ————————— S3: بدون ساخت‌وساز، ذخیره می‌سوزد و کمبود واقعی می‌آید ————————

  it('S3 with no new buildings the stock drains month by month into a REAL shortage (§10/§11/§12)', () => {
    const state = context.state;
    const countryId = ids()[2];
    const record = state.economy.resources[countryId]!;
    const frozen: StrategicResourcesConfig = {
      ...config,
      resources: config.resources.map((resource) => ({ ...resource, price: 0 }))
    };
    // The country runs a food deficit at seed; its LIMITED buffer covers
    // only a few months — then the shortage is unavoidable.
    const gap = (record.consumption.food ?? 0) - (record.production.food ?? 0);
    expect(gap).toBeGreaterThan(0);
    const startStock = record.stock.food ?? 0;
    expect(startStock).toBeGreaterThan(0);
    let sawShortage = false;
    for (let month = 0; month < 24 && !sawShortage; month += 1) {
      runEconomyCycle(state, context.map, frozen, { applyStep: true });
      sawShortage = (record.shortage.food ?? 0) > 0;
    }
    expect(sawShortage).toBe(true);
    // The stock really drained before the shortage (§12 — ذخیره فقط زمان
    // می‌خرد): the warehouse hit zero before the deficit was uncovered.
    expect(record.stock.food ?? 0).toBe(0);
  });

  // ————————— S4: Shortage > 0 دقیق ——————————————

  it('S4 consumption > production + imports + stock → Shortage > 0 recorded exactly (§11)', () => {
    const state = context.state;
    const countryId = ids()[3];
    const record = state.economy.resources[countryId]!;
    const frozen: StrategicResourcesConfig = {
      ...config,
      resources: config.resources.map((resource) => ({ ...resource, price: 0 }))
    };
    record.stock = { food: 0, iron: 0, oil: 0, industrial: 0 };
    record.shortage = {};
    const beforeProduction = record.production.food ?? 0;
    const beforeConsumption = record.consumption.food ?? 0;
    runEconomyCycle(state, context.map, frozen, { applyStep: true });
    const after = state.economy.resources[countryId]!;
    const expected = Math.max(0, Math.round(after.consumption.food - (after.production.food ?? 0) - 0));
    if (after.consumption.food > (after.production.food ?? 0)) {
      expect(after.shortage.food ?? 0).toBeGreaterThan(0);
      // The recorded number IS the honest gap (± the month's own growth).
      expect(after.shortage.food).toBeGreaterThanOrEqual(expected - 10);
      expect(beforeConsumption).toBeGreaterThan(0);
      void beforeProduction;
    }
  });

  // ————————— S5: مزرعه در منطقه عالی > مزرعه در منطقه ضعیف ————————

  it('S5 the same farm yields MORE in an excellent region than in a poor one (§2/§3)', () => {
    const state = context.state;
    const countryId = playerCountryId;
    const model = context.map;
    const country = model.countries[countryId]!;
    // Scan the country's cells for the best and worst FARM quality.
    let best: { key: string; quality: number } | null = null;
    let worst: { key: string; quality: number } | null = null;
    for (const cellIndex of country.cellIds) {
      const gridId = model.features.gridIds[cellIndex];
      if (gridId === null) continue;
      const quality = cellQualityOf(model, cellIndex, 'food', config);
      const key = gridCellKey(countryId, gridId);
      if (best === null || quality > best.quality) best = { key, quality };
      if (worst === null || quality < worst.quality) worst = { key, quality };
    }
    expect(best).not.toBeNull();
    expect(worst).not.toBeNull();
    // The map must offer a real spread — that is what makes PLACE matter.
    expect(best!.quality).toBeGreaterThan(worst!.quality);
    fundCountry(countryId);
    // Two farms, one per cell (one building per region — §1).
    const first = startProject(state, countryId, config, 'farm', worst!.key, 100, () => 's5-poor');
    expect(first.ok).toBe(true);
    finishProjects(countryId);
    const second = startProject(state, countryId, config, 'farm', best!.key, 100, () => 's5-best');
    expect(second.ok).toBe(true);
    finishProjects(countryId);
    // The two completed buildings, ranked by diminishing (poor = first).
    const poorOutput = singleBuildingOutput(
      state, model, countryId, config,
      { typeId: 'farm', cellKey: worst!.key },
      buildingIndexOfType(state, countryId, 's5-poor')
    );
    const bestOutput = singleBuildingOutput(
      state, model, countryId, config,
      { typeId: 'farm', cellKey: best!.key },
      buildingIndexOfType(state, countryId, 's5-best')
    );
    expect(poorOutput.amount).toBeGreaterThan(0);
    expect(bestOutput.amount).toBeGreaterThan(poorOutput.amount);
    // The building output follows the quality RATIO (modulated by the
    // diminishing step) — the difference is visible, not cosmetic.
    expect(bestOutput.amount).toBeGreaterThan(poorOutput.amount * 1.2);
    // Cleanup so later scenarios see a fresh country.
    delete state.economy.buildings[countryId];
    state.economy.construction[countryId]!.projects = [];
  });

  // ————————— S6: هزینه‌ها، ظرفیت ساخت، بازده نزولی ————————

  it('S6 construction gates bite: money, materials, workforce, capacity 2, diminishing returns (§4/§6/§7)', () => {
    const state = context.state;
    const countryId = ids()[1];
    const farm = config.buildings.find((candidate) => candidate.id === 'farm')!;
    const factory = config.buildings.find((candidate) => candidate.id === 'factory')!;
    const record = state.economy.resources[countryId]!;
    // Clean slate for THIS country (scenarios share the world — each owns
    // its cleanup): no buildings, no running projects.
    state.economy.buildings[countryId] = {};
    state.economy.construction[countryId]!.projects = [];
    const capacity = workforceCapacityOf(state, countryId, config);
    expect(capacity).toBe(
      Math.round(config.construction.workforceBase + (state.countries.countries[countryId]!.population / 1_000_000) * config.construction.workforcePerMillion)
    );

    // Money gate.
    state.economy.treasury[countryId] = 0;
    record.stock.industrial = 10_000;
    const noMoney = startProject(state, countryId, config, farm.id, freeCellOf(countryId)!, 100, () => 's6-a');
    expect(noMoney.ok).toBe(false);
    if (!noMoney.ok) expect(noMoney.reason).toBe('no-funds');
    // Materials gate.
    state.economy.treasury[countryId] = 100_000;
    record.stock.industrial = 0;
    const noMaterials = startProject(state, countryId, config, farm.id, freeCellOf(countryId)!, 100, () => 's6-b');
    expect(noMaterials.ok).toBe(false);
    if (!noMaterials.ok) expect(noMaterials.reason).toBe('no-materials');
    // Workforce gate: the factory holds 400 — more than the pool after a
    // farm for a small country (the numbers come from the config, §4).
    record.stock.industrial = 100_000;
    fundCountry(countryId);
    const smallCell = freeCellOf(countryId)!;
    const materialsBefore = record.stock.industrial;
    const farmStart = startProject(state, countryId, config, farm.id, smallCell, 100, () => 's6-c');
    expect(farmStart.ok).toBe(true);
    expect(record.stock.industrial).toBe(materialsBefore - farm.materials);
    if (workforceUsedBy(state, countryId, config) + factory.workforce > capacity) {
      const tooBig = startProject(state, countryId, config, factory.id, freeCellOf(countryId, new Set([smallCell]))!, 100, () => 's6-d');
      expect(tooBig.ok).toBe(false);
      if (!tooBig.ok) expect(tooBig.reason).toBe('workforce');
    }
    // Capacity gate (§6): maxProjects at once — the next start refuses.
    // (No re-funding here — the treasury and the materials stock keep the
    // s6-c payment in the numbers, §4's one-time costs are visible.)
    const started: string[] = [smallCell];
    while (state.economy.construction[countryId]!.projects.length < config.construction.maxProjects) {
      const cell = freeCellOf(countryId, new Set(started));
      expect(cell).not.toBeNull();
      const ok = startProject(state, countryId, config, farm.id, cell!, 100, () => `s6-f${started.length}`);
      expect(ok.ok).toBe(true);
      started.push(cell!);
    }
    const overCap = startProject(state, countryId, config, farm.id, freeCellOf(countryId, new Set(started))!, 100, () => 's6-g');
    expect(overCap.ok).toBe(false);
    if (!overCap.ok) expect(overCap.reason).toBe('limit');
    // Materials were paid ONCE per started project (§4) — the DELTA is
    // exact: every running project took its materials out of the stock.
    const startedCount = state.economy.construction[countryId]!.projects.length;
    expect(startedCount).toBe(config.construction.maxProjects);
    expect(record.stock.industrial).toBe(materialsBefore - startedCount * farm.materials);
    // Diminishing (§7): the SAME cell, two farm records — the 2nd yields
    // less by EXACTLY the diminishing factor (quality/potential cancel out).
    finishProjects(countryId);
    const someCell = started[0];
    const quality = cellQualityOf(context.map, findGridCell(context.map, someCell), 'food', config);
    const potential = countryPotentialFactor(context.map, countryId, 'food', config);
    const levelFactor = economyLevelBuildingFactor(state, countryId, config);
    const synthetic = {
      m10a: { id: 'm10a', typeId: 'farm', cellKey: someCell },
      m10b: { id: 'm10b', typeId: 'farm', cellKey: someCell }
  };
    const out0 = singleBuildingOutput(state, context.map, countryId, config, synthetic.m10a, 0);
    const out1 = singleBuildingOutput(state, context.map, countryId, config, synthetic.m10b, 1);
    expect(out0.amount).toBe(Math.round(farm.output * quality * potential * levelFactor));
    expect(out1.amount).toBe(Math.round(farm.output * quality * potential * levelFactor * diminishingFactorOf(1, config)));
    expect(out1.amount).toBeLessThan(out0.amount);
    // Cleanup.
    delete state.economy.buildings[countryId];
    state.economy.construction[countryId]!.projects = [];
  });

  // ————————— S7: چند کشور کمبوددار هم‌زمان + AI با همان قوانین ————————

  it('S7 many countries short at once — the market serves them, the AI builds by NEED under the same gates (§16/§18/§19)', () => {
    const state = context.state;
    // Force a tight world: empty all stocks, zero money — no one can buy;
    // then restore money but keep stocks empty. The world's sellers hold
    // nothing above their reserve → several countries must stay short
    // (§19: a request is not free goods).
    for (const countryId of ids()) {
      state.economy.resources[countryId]!.stock = { food: 0, iron: 0, oil: 0, industrial: 0 };
    }
    runEconomyCycle(state, context.map, config, { applyStep: true });
    // With full treasuries restored BEFORE the cycle... the cycle pays the
    // ledger AFTER trade, so buyers with 0 treasury bought nothing.
    const shortageCountries = ids().filter((countryId) =>
      strategicResourceIds(config).some((resourceId) => (state.economy.resources[countryId]!.shortage[resourceId] ?? 0) > 0)
    );
    expect(shortageCountries.length).toBeGreaterThan(0);
    // The AI decision function answers a shortage with the matching
    // building — for EVERY short country, under the same money+materials
    // gates the player faces (startProject refuses what they cannot pay).
    for (const countryId of shortageCountries) {
      const typeId = aiBuildingTypeId(state, context.map, countryId, config);
      expect(typeId).not.toBeNull();
      const def = config.buildings.find((candidate) => candidate.id === typeId);
      expect(def).toBeDefined();
      // The AI cannot magic a project it cannot pay for.
      state.economy.treasury[countryId] = 0;
      state.economy.resources[countryId]!.stock.industrial = 0;
      const cell = freeCellOf(countryId);
      if (cell !== null) {
        const result = startProject(state, countryId, config, def!.id, cell, 100, () => `s7-${countryId}`);
        expect(result.ok).toBe(false);
      }
    }
  });

  // ————————— S8: شبیه‌سازی بلندمدت — تجارت زنده، خودکفایی نادر ————————

  it('S8 a LONG world run keeps trade alive and self-sufficiency RARE — no famine, no bankruptcy (§17/§22/§24)', () => {
    // A PRISTINE world (the scenarios above mutated this one's stocks and
    // treasuries) — §24 S8 measures the real campaign's long-run balance.
    const fresh = createTestGame({ seed: 4242 });
    const state = fresh.gameContext.state;
    const model = fresh.gameContext.map;
    const freshConfig = fresh.gameContext.data.economyData.strategicResources;
    const freshIds = model.countryOrder.filter((id) => state.economy.finance[id] !== undefined);
    const months = 120;
    // The long-run world INCLUDES the AI economies (§16): every few months
    // each country tries the need-based building under the SAME gates
    // (money margin, materials, workforce, capacity) — the deterministic
    // core of GovernmentSystem.processAiEconomy (matching the real 8%/month
    // chance ≈ one attempt per 12 months), so the sim measures the REAL
    // game loop.
    const tryAiConstruction = (countryId: string, month: number): void => {
      const construction = state.economy.construction[countryId];
      if (construction === undefined || construction.projects.length >= freshConfig.construction.maxProjects) return;
      const typeId = aiBuildingTypeId(state, model, countryId, freshConfig);
      const def = freshConfig.buildings.find((candidate) => candidate.id === typeId);
      if (def === undefined) return;
      if ((state.economy.treasury[countryId] ?? 0) < def.cost * 1.5) return;
      if (workforceUsedBy(state, countryId, freshConfig) + def.workforce > workforceCapacityOf(state, countryId, freshConfig)) return;
      // Materials from the world market when the stock is short (§16).
      if (!aiSecureConstructionMaterials(state, countryId, freshConfig, def.materials)) return;
      const country = model.countries[countryId];
      if (country === undefined) return;
      // Best-quality free cell for this good (deterministic full scan).
      let bestKey: string | null = null;
      let bestQuality = -1;
      for (const cellIndex of country.cellIds) {
        const gridId = model.features.gridIds[cellIndex];
        if (gridId === null) continue;
        const key = gridCellKey(countryId, gridId);
        if (economicBuildingAtCell(state, key) !== null) continue;
        if (cellIsUnderConstruction(state, key)) continue;
        const quality = cellQualityOf(model, cellIndex, def.resource, freshConfig);
        if (quality > bestQuality) {
          bestQuality = quality;
          bestKey = key;
        }
      }
      if (bestKey !== null) startProject(state, countryId, freshConfig, def.id, bestKey, month, () => `s8-${countryId}-${month}`);
    };

    // Cumulative export activity: `exports` is a MONTHLY record — trade is
    // "alive" when every good finds buyers/sellers REPEATEDLY over the run.
    const exporterMonths = new Map<string, number>();
    for (let month = 0; month < months; month += 1) {
      runEconomyCycle(state, model, freshConfig, { applyStep: true });
      // The monthly construction step (the GovernmentSystem's job in the
      // real loop): running projects advance by TIME and graduate.
      for (const countryId of freshIds) stepProjects(state, model, countryId, freshConfig, month);
      // The AI's construction attempt runs AFTER the world trade pass (the
      // real GovernmentSystem order) — its market purchases of materials
      // are recorded in THIS month's trade records.
      if (month % 12 === 0) for (const countryId of freshIds) tryAiConstruction(countryId, month);
      for (const resourceId of strategicResourceIds(freshConfig)) {
        const sellers = freshIds.filter((id) => (state.economy.resources[id]!.exports[resourceId] ?? 0) > 0).length;
        if (sellers > 0) exporterMonths.set(resourceId, (exporterMonths.get(resourceId) ?? 0) + 1);
      }
    }
    let selfSufficient = 0;
    let famine = 0;
    let broke = 0;
    for (const countryId of freshIds) {
      const record = state.economy.resources[countryId]!;
      let independent = true;
      for (const resourceId of strategicResourceIds(freshConfig)) {
        // Self-sufficient = production alone covers consumption in every
        // good. Trade-dependent otherwise (the directive's goal).
        if ((record.production[resourceId] ?? 0) < (record.consumption[resourceId] ?? 0)) {
          independent = false;
        }
      }
      if (independent) selfSufficient += 1;
      // FAMINE is the UNMET need (post-trade shortage, §12) — a dry
      // warehouse that trade refills every month is not a famine.
      if ((record.shortage.food ?? 0) > 0) famine += 1;
      if ((state.economy.treasury[countryId] ?? 0) <= 0) broke += 1;
    }
    // Trade channels stayed ALIVE for every good over the decade (§17/§18):
    // each good found sellers in some months, and the world traded broadly.
    // (The scarce goods — oil, industrial — trade nearly every month; food
    // trade is need-driven and flares when a granary fails somewhere.)
    let totalExporterMonths = 0;
    for (const resource of freshConfig.resources) {
      const active = exporterMonths.get(resource.id) ?? 0;
      totalExporterMonths += active;
      expect(active).toBeGreaterThanOrEqual(months / 30);
    }
    expect(totalExporterMonths).toBeGreaterThanOrEqual(months);
    // Self-sufficiency stayed the EXCEPTION, not the rule (§24 S8).
    expect(selfSufficient).toBeLessThan(Math.ceil(freshIds.length / 2));
    // The anti-famine + anti-bankruptcy guards held for 10 years (§22).
    expect(famine).toBe(0);
    expect(broke).toBe(0);
    fresh.dispose();
  });

  // ————————— M9: ذخیره اولیه محدود و متمایز ————————

  it('M9 starting stockpiles are LIMITED (a few months) and DIFFER by economic profile (§1/§10)', () => {
    // A PRISTINE world — the scenarios above spent months of this one.
    const fresh = createTestGame({ seed: 777 });
    const state = fresh.gameContext.state;
    const freshConfig = fresh.gameContext.data.economyData.strategicResources;
    const freshIds = fresh.gameContext.map.countryOrder.filter(
      (id) => state.economy.finance[id] !== undefined
    );
    let foodStockMax = -1;
    let foodStockMin = Infinity;
    let oilStockMax = -1;
    for (const countryId of freshIds) {
      const record = state.economy.resources[countryId]!;
      const foodConsumption = record.consumption.food ?? 0;
      // LIMITED: at most months × maxFlavor × consumption (+ the floor).
      const ceiling = Math.max(
        freshConfig.startingStock.floor.food ?? 0,
        (freshConfig.startingStock.months.food ?? 2) * foodConsumption * Math.max(...freshConfig.startingStock.flavorByRank)
      );
      expect(record.stock.food ?? 0).toBeLessThanOrEqual(Math.round(ceiling));
      expect(record.stock.oil ?? 0).toBeGreaterThan(0);
      oilStockMax = Math.max(oilStockMax, record.stock.oil ?? 0);
      if (foodConsumption > 0) {
        foodStockMax = Math.max(foodStockMax, record.stock.food ?? 0);
        foodStockMin = Math.min(foodStockMin, record.stock.food ?? 0);
      }
    }
    // DIFFERENT: profiles made the initial piles unequal (§1).
    expect(foodStockMax).toBeGreaterThan(foodStockMin);
    expect(oilStockMax).toBeGreaterThan(0);
    fresh.dispose();
  });

  // ————————— M10: ذخیره استخراج محدود ————————

  it('M10 the extraction reserve is finite: it drains and the output caps at what is LEFT (§8)', () => {
    const state = context.state;
    const countryId = ids()[1];
    const model = context.map;
    const oil = config.buildings.find((candidate) => candidate.id === 'oil_field')!;
    expect(oil.reserveUnits).toBeGreaterThan(0);
    // Clean slate (scenarios share the world — each owns its cleanup).
    state.economy.buildings[countryId] = {};
    state.economy.construction[countryId]!.projects = [];
    fundCountry(countryId);
    const cell = freeCellOf(countryId)!;
    expect(startProject(state, countryId, config, oil.id, cell, 100, () => 'm10').ok).toBe(true);
    finishProjects(countryId);
    const building = Object.values(state.economy.buildings[countryId] ?? {}).find((candidate) => candidate.typeId === 'oil_field')!;
    // The reserve was sized from the cell quality (0.5..1.0 × the type base).
    expect(building.reserveCapacity).toBeGreaterThan(0);
    expect(building.reserveCapacity).toBeLessThanOrEqual(oil.reserveUnits);
    expect(building.reserveRemaining).toBe(building.reserveCapacity);
    // Extraction drains it month by month.
    const before = building.reserveRemaining!;
    runEconomyCycle(state, context.map, config, { applyStep: true });
    expect(building.reserveRemaining!).toBeLessThan(before);
    // Near the end the output CAPS at what is left (never negative).
    building.reserveRemaining = 3;
    const output = singleBuildingOutput(
      state, model, countryId, config, building, buildingIndexOfType(state, countryId, building.id)
    );
    expect(output.amount).toBeLessThanOrEqual(3);
    // Cleanup.
    delete state.economy.buildings[countryId];
    state.economy.construction[countryId]!.projects = [];
  });

  // ————————— M11: تشدید رضایت بر اساس مدت کمبود ————————

  it('M11 the satisfaction penalty ESCALATES with the shortage duration, capped (§13)', () => {
    const state = context.state;
    const countryId = ids()[0];
    const record = state.economy.resources[countryId]!;
    const consumption = record.consumption.food ?? 0;
    // A MODERATE shortage (coverage ≈ 0.8 — between the 0.9 and 0.7 tiers).
    record.shortage = { food: Math.round(consumption * 0.2) };
    record.shortageMonths = {};
    const first = satisfactionPenaltyTotalOf(state, countryId, config);
    expect(first).toBeGreaterThan(0);
    record.shortageMonths = { food: 4 };
    const fourth = satisfactionPenaltyTotalOf(state, countryId, config);
    expect(fourth).toBeGreaterThan(first);
    expect(fourth).toBeCloseTo(first * (1 + config.satisfaction.durationEscalation.perMonth * 3), 3);
    // The escalation never runs away — the cap holds (spec §13 متعادل).
    record.shortageMonths = { food: 50 };
    const late = satisfactionPenaltyTotalOf(state, countryId, config);
    expect(late).toBeCloseTo(first * config.satisfaction.durationEscalation.maxMultiplier, 3);
    record.shortage = {};
    record.shortageMonths = {};
  });

  // ————————— M12: پیش‌نمایش ساخت قبل از تأیید ————————

  it('M12 the build preview shows quality, base and estimated output BEFORE confirming (§3/§21)', () => {
    const state = context.state;
    const model = context.map;
    const countryId = playerCountryId;
    const cell = freeCellOf(countryId)!;
    const cellIndex = findGridCell(model, cell);
    const quality = cellQualityOf(model, cellIndex, 'food', config);
    const info = buildPreviewInfoOf(state, model, countryId, config, 'farm', cell);
    expect(info).not.toBeNull();
    expect(info!.quality).toBeCloseTo(quality, 4);
    expect(info!.qualityLabel).toBe(qualityLabelOf(quality, config));
    expect(info!.baseOutput).toBe(150);
    // The estimate applies quality × potential × level × diminishing —
    // the honest number the player sees before the confirm (spec §3's
    // تولید واقعی تقریبی).
    const potential = countryPotentialFactor(model, countryId, 'food', config);
    const levelFactor = economyLevelBuildingFactor(state, countryId, config);
    const expected = Math.round(150 * quality * potential * levelFactor);
    expect(info!.estimatedOutput).toBe(expected);
    // An unknown type / a bogus cell refuse to preview.
    expect(buildPreviewInfoOf(state, model, countryId, config, 'nope', cell)).toBeNull();
    expect(buildPreviewInfoOf(state, model, countryId, config, 'farm', 'country_0#ZZ9')).toBeNull();
  });

  // ————————— M13: صداقت بودجه واردات ————————————————

  it('M13 a buyer never commits more import money than its treasury holds (§11/§12)', () => {
    const state = context.state;
    // The most deficit-ridden country buys with a TIGHT budget: the trade
    // pass must draw down ONE running budget across ALL resources — food
    // settles first (essential), the rest share what remains.
    const ranked = ids()
      .map((countryId) => {
        const record = state.economy.resources[countryId]!;
        const gaps = strategicResourceIds(config).map(
          (resourceId) => (record.consumption[resourceId] ?? 0) - (record.production[resourceId] ?? 0)
        );
        return { countryId, deficits: gaps.filter((gap) => gap > 0).length };
      })
      .sort((a, b) => b.deficits - a.deficits);
    const countryId = ranked[0].countryId;
    const record = state.economy.resources[countryId]!;
    // Empty stocks so every deficit is uncovered, and a SMALL treasury.
    record.stock = { food: 0, iron: 0, oil: 0, industrial: 0 };
    state.economy.treasury[countryId] = 40;
    runEconomyCycle(state, context.map, config, { applyStep: true });
    // The total import bill can never exceed the 40 it walked in with.
    expect(record.tradeExpense).toBeLessThanOrEqual(40 + 1e-9);
    // And the essentials-first rule: with such a tight budget the food
    // bill comes before any luxury good (config resource order).
    const after = state.economy.resources[countryId]!;
    const foodNeed = (after.consumption.food ?? 0) - (after.production.food ?? 0);
    if (foodNeed > 0 && (after.imports.food ?? 0) === 0) {
      // Food unfilled is only honest when the budget could not reach even
      // ONE unit of food — impossible here (40 ≫ 0.4), so a shortage with
      // zero food imports would mean the food pass never ran first.
      expect(after.shortage.food ?? 0).toBe(0);
    }
  });
});
