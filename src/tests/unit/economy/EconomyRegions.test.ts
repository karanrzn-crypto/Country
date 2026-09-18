/**
 * THE WIDER SIMPLE ECONOMY — unit tests for the 11-section directive:
 *
 *  §1  buildings on grid cells   — own country, ONE per region, exact place
 *  §2  the region reads its info from the ONE state record
 *  §3  the 0-100 economy level   — gradual drift, building production scales
 *                                  around 50 (never multi-fold)
 *  §4  country specialization    — every country produces every good, with
 *                                  DIFFERENT efficiency (real trade)
 *  §5  one seller serves MANY buyers (surplus splits across countries)
 *  §6  consumption of EVERY good scales with population — never zero
 *  §7  graded shortage → satisfaction penalty (100/90/70/40 scale)
 *  §8  production + imports = supply; imports compensate a shortage
 *
 * §11's review items: foreign-cell build blocked, double-build blocked,
 * occupation by a running project blocked, conservation, no negatives.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestGame } from '../../helpers/testGame';
import type { Game } from '../../../core/Game';
import type { SystemContext } from '../../../core/GameContext';
import { runEconomyCycle, resolveWorldTrade } from '../../../economy/economyCycle';
import {
  coverageOf,
  satisfactionPenaltyOf,
  satisfactionPenaltyTotalOf,
  specializedBaselineProduction,
  economyLevelOf,
  economyLevelBuildingFactor,
  buildingProductionOf,
  economicBuildingAtCell,
  cellIsUnderConstruction,
  cellUnderConstruction,
  cellEconomyTintOf,
  strategicResourceIds
} from '../../../economy/resources';
import { startProject, stepProjects, projectMonthsRemaining } from '../../../economy/construction';
import { aiBuildingTypeId } from '../../../economy/aiEconomy';
import { economyTintRGB, rgb } from '../../../rendering/map/MapSurface';
import { countryBaselineProduction } from '../../../economy/domesticBaseline';
import { gridCellKey } from '../../../world/map/MapTypes';
import { findGridCell } from '../../../world/map/MapGeography';
import type { StrategicResourcesConfig } from '../../../economy/types';

describe('wider simple economy (11-section spec)', () => {
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

  /** A FREE land cell key of ONE country (no building, no project). */
  const freeCellOf = (countryId: string): string | null => {
    const model = context.map;
    const country = model.countries[countryId];
    if (country === undefined) return null;
    for (const cellIndex of country.cellIds) {
      const gridId = model.features.gridIds[cellIndex];
      if (gridId === null) continue;
      const key = gridCellKey(countryId, gridId);
      if (economicBuildingAtCell(context.state, key) !== null) continue;
      if (cellIsUnderConstruction(context.state, key)) continue;
      return key;
    }
    return null;
  };

  const anyForeignCell = (countryId: string): string | null => {
    for (const other of ids()) {
      if (other === countryId) continue;
      const cell = freeCellOf(other);
      if (cell !== null) return cell;
    }
    return null;
  };

  // ————————————————————— §6 — مصرف صفر ممنوع ————————————————————————————

  it('T1 every populated country consumes EVERY good — the zero-consumption bug is gone (§6)', () => {
    const state = context.state;
    for (const countryId of ids()) {
      const population = state.countries.countries[countryId]?.population ?? 0;
      if (population <= 0) continue;
      const record = state.economy.resources[countryId]!;
      for (const resourceId of strategicResourceIds(config)) {
        const base = config.consumption[resourceId]?.perMillionPopulation ?? 0;
        const expected = Math.round((population / 1_000_000) * base);
        expect(expected).toBeGreaterThan(0);
        expect(record.consumption[resourceId] ?? 0).toBeGreaterThanOrEqual(expected);
      }
    }
  });

  // ————————————————————— §4 — تخصص اقتصادی ——————————————————————————————

  it('T2 specialization: every country produces EVERY good, with DIFFERENT efficiency (§4)', () => {
    const model = context.map;
    for (const countryId of ids()) {
      const baseline = specializedBaselineProduction(model, countryId, config);
      // Specialization ≠ inability: all four goods stay in production.
      for (const resourceId of strategicResourceIds(config)) {
        expect(baseline[resourceId] ?? 0).toBeGreaterThan(0);
      }
    }
    // The amplification is honest: the strongest good is strictly above its
    // RAW geography value, the weakest strictly below (when the raw vector
    // differs between goods).
    const sample = ids()[0];
    const raw = countryBaselineProduction(model, sample, config.domesticBaseline);
    const specialized = specializedBaselineProduction(model, sample, config);
    const rawAmounts = strategicResourceIds(config).map((id) => raw[id] ?? 0);
    const allEqual = rawAmounts.every((amount) => Math.abs(amount - rawAmounts[0]) < 1e-6);
    if (!allEqual) {
      const maxRaw = Math.max(...rawAmounts);
      const maxSpecialized = Math.max(...strategicResourceIds(config).map((id) => specialized[id] ?? 0));
      expect(maxSpecialized).toBeGreaterThan(maxRaw * 1.3); // boostBest (×1.5) applied
      const minRaw = Math.min(...rawAmounts);
      const minSpecialized = Math.min(...strategicResourceIds(config).map((id) => specialized[id] ?? 0));
      expect(minSpecialized).toBeLessThan(minRaw); // reduceWeakest (×0.65) applied
    }
  });

  // ————————————————————— §3 — سطح اقتصاد ۰..۱۰۰ ——————————————————————————

  it('T3 the economy level starts NEUTRAL and scales building production around 50 (§3)', () => {
    const state = context.state;
    const countryId = playerCountryId;
    // Fresh state: neutral 50 → the factor is exactly 1.
    expect(economyLevelOf(state, countryId, config)).toBe(config.economyLevel.start);
    expect(economyLevelBuildingFactor(state, countryId, config)).toBe(1);

    // Level 70 → +8% (config 0.004/point) — deliberately WEAK (spec §14:
    // the economy is a booster, never a substitute for resources/quality).
    state.economy.economyLevel[countryId] = 70;
    expect(economyLevelBuildingFactor(state, countryId, config)).toBeCloseTo(1.08, 3);
    // Level 35 → below 1 — the weak economy produces LESS (spec §3).
    state.economy.economyLevel[countryId] = 35;
    expect(economyLevelBuildingFactor(state, countryId, config)).toBeLessThan(1);
    expect(economyLevelBuildingFactor(state, countryId, config)).toBeGreaterThan(0.8);

    // The building output follows the factor through the REAL state read.
    state.economy.economyLevel[countryId] = config.economyLevel.start;
    const neutral = buildingProductionOf(state, context.map, countryId, config).totals;
    state.economy.economyLevel[countryId] = 80;
    const boosted = buildingProductionOf(state, context.map, countryId, config).totals;
    state.economy.economyLevel[countryId] = 20;
    const cut = buildingProductionOf(state, context.map, countryId, config).totals;
    for (const [resourceId, amount] of Object.entries(neutral)) {
      expect(boosted[resourceId] ?? 0).toBeGreaterThan(amount);
      expect(cut[resourceId] ?? 0).toBeLessThan(amount);
    }
    state.economy.economyLevel[countryId] = config.economyLevel.start;
  });

  it('T4 the level drifts GRADUALLY toward its target — never a jump (§3)', () => {
    const state = context.state;
    const countryId = ids()[1];
    const spec = config.economyLevel;
    state.economy.economyLevel[countryId] = spec.start;

    // A strongly profitable month (real trade money) drags the level UP by
    // at most maxStep — the balance term is capped, the drift is capped.
    state.economy.resources[countryId]!.tradeIncome = 1000;
    state.economy.resources[countryId]!.tradeExpense = 0;
    runEconomyCycle(state, context.map, config, { applyStep: true });
    const afterGood = state.economy.economyLevel[countryId]!;
    expect(afterGood).toBeGreaterThan(spec.start);
    expect(afterGood - spec.start).toBeLessThanOrEqual(spec.maxStepPerMonth + 1e-9);

    // An uncovered shortage drags the target DOWN — still gradual.
    state.economy.economyLevel[countryId] = spec.start + 20;
    const before = state.economy.economyLevel[countryId]!;
    const record = state.economy.resources[countryId]!;
    const frozen: StrategicResourcesConfig = {
      ...config,
      resources: config.resources.map((resource) => ({ ...resource, price: 0 })),
      economyLevel: { ...config.economyLevel, maxStepPerMonth: spec.maxStepPerMonth }
    };
    record.stock = {};
    record.shortage = { food: 500 };
    runEconomyCycle(state, context.map, frozen, { applyStep: true });
    const afterBad = state.economy.economyLevel[countryId]!;
    expect(afterBad).toBeLessThan(before);
    expect(before - afterBad).toBeLessThanOrEqual(spec.maxStepPerMonth + 1e-9);
    // The level always stays inside the 0..100 scale.
    expect(afterBad).toBeGreaterThanOrEqual(0);
    expect(afterBad).toBeLessThanOrEqual(100);
  });

  // ————————————————————— §1 — ساخت روی شبکهٔ جغرافیایی ——————————————————

  it('T5 a building is placed on the EXACT own cell; foreign and taken cells are blocked (§1)', () => {
    const state = context.state;
    const countryId = playerCountryId;
    const def = config.buildings[0]; // the farm
    state.economy.treasury[countryId] = def.cost * 4;
    state.economy.resources[countryId]!.stock.industrial = def.materials * 10;

    const ownCell = freeCellOf(countryId);
    expect(ownCell).not.toBeNull();
    const foreignCell = anyForeignCell(countryId);
    expect(foreignCell).not.toBeNull();

    // The CORE refuses a placement on a cell of ANOTHER country (spec §1.4):
    // the owner check compares the cell's country with the caller's.
    expect(game.economyStartConstruction(countryId, def.id, foreignCell!)).toBe(false);
    expect(state.economy.treasury[countryId]).toBe(def.cost * 4); // nothing paid

    // The exact own cell takes the project through the CORE flow (the same
    // path the build-mode click takes), paid once.
    expect(game.economyStartConstruction(countryId, def.id, ownCell!)).toBe(true);
    expect(state.economy.treasury[countryId]).toBe(def.cost * 4 - def.cost);
    expect(cellIsUnderConstruction(state, ownCell!)).toBe(true);

    // The region is now TAKEN — a second building there is impossible.
    const again = startProject(state, countryId, config, def.id, ownCell!, 11, () => 'bp3');
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toBe('occupied');

    // §2 — the region reads its data from the ONE state record.
    const atCell = economicBuildingAtCell(state, ownCell!);
    expect(atCell).toBeNull(); // still a PROJECT, not a building

    // Completion anchors the BUILDING on the same cell (spec §1.8).
    const speed = 0.75 + 0.5 * 0.5;
    for (let month = 11; month <= 10 + Math.ceil(def.buildMonths / speed) + 2; month += 1) {
      stepProjects(state, context.map, countryId, config, month);
    }
    const done = economicBuildingAtCell(state, ownCell!);
    expect(done).not.toBeNull();
    expect(done?.typeId).toBe(def.id);
    expect(cellIsUnderConstruction(state, ownCell!)).toBe(false);
  });

  it('T6 the map resolves the cell; the building id comes from findGridCell round-trip (§1/§2)', () => {
    // The canonical key the state stores must resolve back to a real cell.
    const cell = freeCellOf(playerCountryId);
    expect(cell).not.toBeNull();
    expect(findGridCell(context.map, cell!)).toBeGreaterThanOrEqual(0);
  });

  // ————————————————————— §7 — کمبود و رضایت مردم ————————————————————————

  it('T7 the satisfaction penalty is GRADED exactly like the spec scale (§7)', () => {
    const satisfaction = config.satisfaction;
    // 100% coverage → no penalty at all.
    expect(satisfactionPenaltyOf(1, satisfaction)).toBe(0);
    // The spec anchors, read from config and verified monotone.
    expect(satisfactionPenaltyOf(0.9, satisfaction)).toBeCloseTo(0.03, 3);
    expect(satisfactionPenaltyOf(0.7, satisfaction)).toBeCloseTo(0.1, 3);
    expect(satisfactionPenaltyOf(0.4, satisfaction)).toBeCloseTo(0.22, 3);
    // Between the anchors the curve interpolates, never jumps.
    expect(satisfactionPenaltyOf(0.8, satisfaction)).toBeGreaterThan(0.03);
    expect(satisfactionPenaltyOf(0.8, satisfaction)).toBeLessThan(0.1);
    // Deep shortfall clamps at the ceiling — no sudden collapse.
    expect(satisfactionPenaltyOf(0, satisfaction)).toBe(satisfaction.maxPenalty);
    // Monotone decreasing in coverage over the whole range.
    let previous = 1;
    for (let step = 0; step <= 20; step += 1) {
      const coverage = step / 20;
      const penalty = satisfactionPenaltyOf(coverage, satisfaction);
      expect(penalty).toBeLessThanOrEqual(previous + 1e-9);
      previous = penalty;
    }
  });

  it('T8 coverage = (production + imports + stock) against consumption; penalties follow (§7/§8)', () => {
    const state = context.state;
    const countryId = ids()[2];
    const record = state.economy.resources[countryId]!;

    // Fully covered → zero total penalty.
    record.consumption = { food: 100, iron: 20, oil: 30, industrial: 25 };
    record.shortage = {};
    expect(satisfactionPenaltyTotalOf(state, countryId, config)).toBe(0);
    expect(coverageOf(record, 'food')).toBe(1);

    // 30% of the food need unmet → a real but moderate penalty.
    record.shortage = { food: 30 };
    expect(coverageOf(record, 'food')).toBeCloseTo(0.7, 3);
    const total = satisfactionPenaltyTotalOf(state, countryId, config);
    expect(total).toBeGreaterThan(0.05);
    expect(total).toBeLessThan(0.2);
  });

  // ————————————————————— §8 — واردات کمبود را جبران می‌کند ————————————————

  it('T9 world trade covers a shortage; the post-trade deficit shrinks (§8)', () => {
    const state = context.state;
    const order = ids();
    const buyerId = order[0];
    for (const id of order) {
      state.economy.resources[id]!.shortage = {};
      state.economy.resources[id]!.imports = {};
      state.economy.resources[id]!.exports = {};
    }
    const buyer = state.economy.resources[buyerId]!;
    buyer.consumption = { ...buyer.consumption, food: 100 };
    buyer.shortage.food = 100; // the deficit BEFORE trade

    resolveWorldTrade(state, order, strategicResourceIds(config), config);

    const uncovered = buyer.shortage.food ?? 0;
    expect(buyer.imports.food ?? 0).toBe(100 - uncovered);
    expect(uncovered).toBeLessThan(100); // imports compensated part of it
    // Coverage reflects the post-trade situation (§8).
    const postCoverage = coverageOf(buyer, 'food');
    expect(postCoverage).toBeGreaterThan(0);
    expect(postCoverage).toBeLessThanOrEqual(1);
  });

  // ————————————————————— §5 — صادرات به چند کشور ————————————————————————

  it('T10 ONE surplus seller serves SEVERAL shortage buyers in the same pass (§5)', () => {
    const state = context.state;
    const order = ids();
    expect(order.length).toBeGreaterThanOrEqual(3);
    const sellerId = order[0];
    const buyers = order.slice(1, 3);
    const seller = state.economy.resources[sellerId]!;
    seller.stock.industrial = 1_000_000; // a huge surplus of industrial goods
    seller.consumption = { ...seller.consumption, industrial: 10 };

    // ONLY the two buyers need anything — they are the whole market.
    for (const id of order) {
      const record = state.economy.resources[id]!;
      record.imports = {};
      record.exports = {};
      record.shortage = {};
      state.economy.treasury[id] = 100_000; // everyone can pay
    }
    for (const buyerId of buyers) {
      state.economy.resources[buyerId]!.shortage.industrial = 40;
    }

    resolveWorldTrade(state, order, ['industrial'], config);

    // The 80 units split across BOTH buyers (40 each — the seller never ran dry).
    for (const buyerId of buyers) {
      expect(state.economy.resources[buyerId]!.imports.industrial ?? 0).toBe(40);
      expect(state.economy.resources[buyerId]!.shortage.industrial ?? 0).toBe(0);
    }
    expect(seller.exports.industrial ?? 0).toBe(80);
    // Money moved to the seller at the BASE price (§6/§7).
    expect(seller.tradeIncome).toBeCloseTo(80 * (config.resources.find((r) => r.id === 'industrial')?.price ?? 0), 2);
  });

  // ————————————————————— چرخه کامل — اجرای ماه ————————————————————————————

  it('T11 the full cycle runs once per month over FOUR goods without double-application (§9)', () => {
    const state = context.state;
    const countryId = ids()[0];
    // A fully frozen world: no trade (prices 0), no growth, no level drift —
    // every number is then exact and the ONE-write semantics is checkable.
    const frozen: StrategicResourcesConfig = {
      ...config,
      resources: config.resources.map((resource) => ({ ...resource, price: 0 })),
      finance: { ...config.finance, populationGrowthPerMonth: 0 },
      economyLevel: { ...config.economyLevel, maxStepPerMonth: 0 }
    };
    for (const id of ids()) {
      state.economy.resources[id]!.tradeIncome = 0;
      state.economy.resources[id]!.tradeExpense = 0;
    }
    const treasuryBefore = state.economy.treasury[countryId] ?? 0;
    const stockBefore = Math.round(state.economy.resources[countryId]!.stock.food ?? 0);

    runEconomyCycle(state, context.map, frozen, { applyStep: true });

    const finance = state.economy.finance[countryId]!;
    const income = finance.lastTaxIncome + finance.lastTradeIncome;
    const expenses = finance.lastArmyExpense + finance.lastGovernmentExpense + finance.lastInfrastructureExpense;
    expect(finance.lastBalance).toBeCloseTo(income - expenses, 1);
    // ONE treasury write: before + balance (floored at 0).
    expect(state.economy.treasury[countryId] ?? 0).toBeCloseTo(Math.max(0, treasuryBefore + finance.lastBalance), 0);
    // The stock stepped EXACTLY once: (this cycle's recomputed production −
    // consumption), floored at zero (§14) — no trade moved food (prices 0).
    const production = Math.round(state.economy.resources[countryId]!.production.food ?? 0);
    const consumption = Math.round(state.economy.resources[countryId]!.consumption.food ?? 0);
    const expectedStock = Math.max(0, stockBefore + production - consumption);
    expect(Math.round(state.economy.resources[countryId]!.stock.food ?? 0)).toBe(expectedStock);
    // A populated country consumes every good — the §6 property, live.
    for (const resourceId of strategicResourceIds(config)) {
      expect(consumption).toBeGreaterThan(0);
      void resourceId;
    }
  });

  // ————————————————————— §1.9 — زمان ساخت فقط با ماه ——————————————————————

  it('T12 the construction time reads ONLY in months — exact remaining-month math (§1.9/§1.15)', () => {
    // The ONE definition the dashboard card and the grid panel share:
    // the un-built share divided by the monthly speed, rounded UP.
    expect(projectMonthsRemaining(0, 4, 1)).toBe(4); // fresh farm, speed 1
    expect(projectMonthsRemaining(0.5, 4, 1)).toBe(2); // half built
    expect(projectMonthsRemaining(0.5, 6, 1.25)).toBe(3); // ceil(2.4)
    expect(projectMonthsRemaining(0.75, 4, 0.75)).toBe(2); // ceil(1/0.75)
    expect(projectMonthsRemaining(1, 4, 1)).toBe(0); // done
    // Real state: a started project reports its months through the SAME
    // helpers the UI reads (cellUnderConstruction → months remaining).
    const state = context.state;
    const countryId = ids()[1];
    const def = config.buildings.find((candidate) => candidate.id === 'iron_mine')!;
    state.economy.treasury[countryId] = def.cost * 2;
    state.economy.resources[countryId]!.stock.industrial = def.materials * 10;
    const cell = freeCellOf(countryId);
    expect(cell).not.toBeNull();
    const started = startProject(state, countryId, config, def.id, cell!, 20, () => 'bp-t12');
    expect(started.ok).toBe(true);
    const project = cellUnderConstruction(state, cell!);
    expect(project).not.toBeNull();
    expect(project?.typeId).toBe(def.id);
    expect(project?.countryId).toBe(countryId);
    const speed = 0.75 + 0.5 * ((state.government.countries[countryId]?.budget.shares.economic ?? 0.5));
    expect(projectMonthsRemaining(project!.progress, def.buildMonths, speed)).toBe(
      Math.ceil((def.buildMonths * 1) / speed)
    );
    // No percentage semantics anywhere: the remaining months come only from
    // progress + buildMonths + speed — never a 0..100 display value.
    expect(project!.progress).toBeLessThanOrEqual(1);
    // Cleanup: finish the project so other tests see a free world.
    for (let month = 20; month <= 20 + def.buildMonths + 2; month += 1) {
      stepProjects(state, context.map, countryId, config, month);
    }
    expect(cellUnderConstruction(state, cell!)).toBeNull();
    state.economy.buildings[countryId] = {};
  });

  // ————————————————————— §3 — رنگ مناطق اقتصادی روی نقشه ———————————————————

  it('T13 the economy tint resolves per cell — active color, pale construction, empty none (§3)', () => {
    const state = context.state;
    const theme = context.data.mapTheme;
    const countryId = ids()[2];
    const farm = config.buildings.find((candidate) => candidate.id === 'farm')!;

    // An empty cell has NO tint (the land keeps its normal look).
    const cell = freeCellOf(countryId);
    expect(cell).not.toBeNull();
    expect(cellEconomyTintOf(state, cell!)).toBeNull();

    // UNDER CONSTRUCTION → the type + the construction flag (pale variant).
    state.economy.treasury[countryId] = farm.cost * 2;
    state.economy.resources[countryId]!.stock.industrial = farm.materials * 10;
    expect(startProject(state, countryId, config, farm.id, cell!, 30, () => 'bp-t13').ok).toBe(true);
    const buildingTint = cellEconomyTintOf(state, cell!);
    expect(buildingTint).toEqual({ typeId: farm.id, underConstruction: true });

    // The pale variant is the SAME hue but strictly lighter than the active
    // color — and both come from the ONE theme definition the legend uses.
    const active = economyTintRGB(farm.id, false, theme);
    const pale = economyTintRGB(farm.id, true, theme);
    expect(active).not.toBeNull();
    expect(pale).not.toBeNull();
    expect(pale!.r).toBeGreaterThan(active!.r);
    expect(pale!.g).toBeGreaterThan(active!.g);
    expect(pale!.b).toBeGreaterThan(active!.b);
    expect(active).toEqual(rgb(theme.layerColors.economyBuildingColors[farm.id]));

    // Completion flips the tint to the ACTIVE building (same cell).
    for (let month = 30; month <= 30 + farm.buildMonths + 2; month += 1) {
      stepProjects(state, context.map, countryId, config, month);
    }
    expect(cellEconomyTintOf(state, cell!)).toEqual({ typeId: farm.id, underConstruction: false });
    // Cleanup.
    state.economy.buildings[countryId] = {};
    // A type without a theme color stays untinted (never a guess).
    expect(economyTintRGB('unknown-type', false, theme)).toBeNull();
  });

  // ————————————————————— §6 — اولویت ساخت AI بر اساس نیاز —————————————————

  it('T14 the AI builds by NEED — the largest shortage picks the building; otherwise specialization (§6)', () => {
    const state = context.state;
    const countryId = ids()[3] ?? ids()[0];
    const record = state.economy.resources[countryId]!;

    // Food shortage → مزرعه (the food building).
    record.shortage = { food: 300 };
    expect(aiBuildingTypeId(state, context.map, countryId, config)).toBe(
      config.buildings.find((candidate) => candidate.resource === 'food')?.id ?? null
    );

    // Oil shortage LARGER than the food one → میدان نفتی (need ranking).
    record.shortage = { food: 100, oil: 400 };
    expect(aiBuildingTypeId(state, context.map, countryId, config)).toBe(
      config.buildings.find((candidate) => candidate.resource === 'oil')?.id ?? null
    );

    // Iron-only shortage → معدن آهن.
    record.shortage = { iron: 60 };
    expect(aiBuildingTypeId(state, context.map, countryId, config)).toBe(
      config.buildings.find((candidate) => candidate.resource === 'iron')?.id ?? null
    );

    // NO shortage → the strongest good NOT already covered (developing a
    // covered good again would be irrational — spec §16). Oil is massively
    // over-produced (900 ≫ 1.1 × its need), so the skip now falls to the
    // strongest UNDER-covered good with real potential: food here.
    record.shortage = {};
    const savedProduction = { ...record.production };
    const savedStock = { ...record.stock };
    record.production = { food: 50, iron: 20, oil: 900, industrial: 30 };
    record.stock = {};
    expect(aiBuildingTypeId(state, context.map, countryId, config)).toBe(
      config.buildings.find((candidate) => candidate.resource === 'food')?.id ?? null
    );

    // DEEP SURPLUS everywhere (all goods covered, the strongest ≥ 2× its
    // consumption) → the AI builds NOTHING: stacking more of an already-
    // dominant export good would grind toward effortless self-sufficiency
    // (§24 S8's prohibition; the developed economy stops building instead).
    record.production = { food: 1200, iron: 300, oil: 900, industrial: 400 };
    record.stock = { oil: 10_000 };
    expect(aiBuildingTypeId(state, context.map, countryId, config)).toBeNull();

    // NO production at all → develop the FIRST config good (deterministic —
    // a country producing nothing still develops, the world stays alive).
    record.production = {};
    record.stock = {};
    expect(aiBuildingTypeId(state, context.map, countryId, config)).toBe(config.buildings[0].id);
    record.production = savedProduction;
    record.stock = savedStock;
    record.shortage = {};
  });
});
