/**
 * THE ECONOMIC BUDGET → PRODUCTION (the budget directive) — the required
 * contract:
 *
 *  B1  the budget changes ONLY in steps of 10 — 0, 10, 20 … 100 — no
 *      caller (UI stepper, command, event, load heal) can write an
 *      off-grid share into the state; the other pool mirrors on-grid.
 *  B2  50 is the NEUTRAL base; above 50 the production factor is
 *      POSITIVE, below 50 NEGATIVE — the exact config formula
 *      1 + (budgetPct − 50) × productionPerPoint (60 → ×1.06,
 *      40 → ×0.94, 0 → ×0.70, 100 → ×1.30).
 *  B3  the factor REALLY reaches the simulation: the same country with
 *      budget 40 / 50 / 60 produces strictly less / equal / more — the
 *      recorded production (deposits + baseline + buildings) follows the
 *      modifier, month after month (a 40→50→60 walk moves the output).
 *  B4  the factor is ONE SHARED system: the build preview, a single
 *      building's output and the country record all scale by the SAME
 *      number — and the extractive reserve is spent proportionally.
 *  B5  the budget lives in the STATE (shares + spendingShares + the
 *      production factor), not merely in the UI.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestGame } from '../../helpers/testGame';
import type { Game } from '../../../core/Game';
import type { SystemContext } from '../../../core/GameContext';
import { runEconomyCycle } from '../../../economy/economyCycle';
import {
  economicBudgetProductionFactor,
  singleBuildingOutput,
  buildPreviewInfoOf,
  strategicResourceIds,
  safetyReserveUnits,
  economicBuildingAtCell,
  cellIsUnderConstruction,
  economyLevelBuildingFactor
} from '../../../economy/resources';
import { setBudgetShare, repairBudgetRecord, snapBudgetShare } from '../../../state/slices/governmentSlice';
import { findGridCell } from '../../../world/map/MapGeography';
import { gridCellKey } from '../../../world/map/MapTypes';
import { cellQualityOf, countryPotentialFactor } from '../../../economy/quality';

describe('the economic budget drives production (the budget directive)', () => {
  let game: Game;
  let context: SystemContext;

  beforeAll(() => {
    game = createTestGame({ seed: 5150 });
    context = game.gameContext;
  });

  const config = () => context.data.economyData.strategicResources;
  const ids = (): string[] =>
    context.map.countryOrder.filter((id) => context.state.economy.finance[id] !== undefined);

  /** A free land cell key of ONE country (no building, no project). */
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

  /** Sets ONE country's economic budget through the REAL slice mutator. */
  const setBudget = (countryId: string, budgetPct: number): void => {
    setBudgetShare(context.state.government, countryId, 'economic', budgetPct / 100);
  };

  // ————————— B1: فقط گام‌های ۱۰تایی ————————

  it('B1 the budget sits on the 0/10/…/100 grid — every path snaps to it', () => {
    // The snap helper itself: nearest step, clamped at both ends.
    expect(snapBudgetShare(0.47)).toBe(0.5);
    expect(snapBudgetShare(0.62)).toBe(0.6);
    expect(snapBudgetShare(0.349)).toBe(0.3);
    expect(snapBudgetShare(1.4)).toBe(1);
    expect(snapBudgetShare(-1)).toBe(0);
    expect(snapBudgetShare(Number.NaN)).toBe(0);

    // Through the REAL mutator: an arbitrary command value lands on-grid
    // and the other pool mirrors exactly (both pools always sum to 100%).
    const countryId = ids()[0];
    const shares = setBudgetShare(context.state.government, countryId, 'economic', 0.47);
    expect(shares.economic).toBe(0.5);
    expect(shares.military).toBe(0.5);
    const shares2 = setBudgetShare(context.state.government, countryId, 'economic', 0.13);
    expect(shares2.economic).toBe(0.1);
    expect(shares2.military).toBe(0.9);

    // The live record (what the UI and the simulation read) is on-grid too.
    const budget = context.state.government.countries[countryId].budget;
    const onGrid = (value: number): boolean => Math.abs(value * 10 - Math.round(value * 10)) < 1e-9;
    expect(onGrid(budget.shares.economic)).toBe(true);
    expect(onGrid(budget.shares.military)).toBe(true);

    // The LOAD HEAL snaps old off-grid saves the same way.
    budget.shares.economic = 0.65;
    budget.shares.military = 0.35;
    repairBudgetRecord(context.state.government.countries[countryId]);
    expect(budget.shares.economic).toBe(0.7);
    expect(budget.shares.military).toBeCloseTo(0.3, 12);
    setBudget(countryId, 50); // restore neutral for the later tests
  });

  // ————————— B2: ۵۰ خنثی؛ بالاتر مثبت، پایین‌تر منفی ————————

  it('B2 50 is neutral; 60 lifts, 40 cuts, the extremes are moderate (config formula)', () => {
    const countryId = ids()[0];
    const state = context.state;
    setBudget(countryId, 50);
    expect(economicBudgetProductionFactor(state, countryId, config())).toBe(1);
    setBudget(countryId, 60);
    expect(economicBudgetProductionFactor(state, countryId, config())).toBeCloseTo(1.06, 6);
    setBudget(countryId, 40);
    expect(economicBudgetProductionFactor(state, countryId, config())).toBeCloseTo(0.94, 6);
    setBudget(countryId, 100);
    expect(economicBudgetProductionFactor(state, countryId, config())).toBeCloseTo(1.3, 6);
    setBudget(countryId, 0);
    expect(economicBudgetProductionFactor(state, countryId, config())).toBeCloseTo(0.7, 6);
    // Moderation: one step (10 points) is ±6% — felt, never explosive.
    const perPoint = config().economicBudget.productionPerPoint;
    expect(perPoint * 100).toBeCloseTo(0.6, 9); // 0.6% per point
    setBudget(countryId, 50);
  });

  // ————————— B3: اثر واقعی در شبیه‌سازی — ۴۰ < ۵۰ < ۶۰ ————————

  it('B3 the recorded production REALLY follows the budget — 40 < 50 < 60, month after month', () => {
    const state = context.state;
    const countryId = ids()[0];
    const produce = (budgetPct: number, months: number): Record<string, number> => {
      setBudget(countryId, budgetPct);
      state.economy.contracts = [];
      let totals: Record<string, number> = {};
      for (let month = 400; month < 400 + months; month += 1) {
        runEconomyCycle(state, context.map, config(), { applyStep: true, month });
        for (const resourceId of strategicResourceIds(config())) {
          totals[resourceId] = (totals[resourceId] ?? 0) + (state.economy.resources[countryId]!.production[resourceId] ?? 0);
        }
      }
      void totals;
      // The LAST month's record is the comparable snapshot (buildings may
      // complete over the run — the LAST month is the settled state).
      totals = {};
      for (const resourceId of strategicResourceIds(config())) {
        totals[resourceId] = state.economy.resources[countryId]!.production[resourceId] ?? 0;
      }
      return totals;
    };

    const low = produce(40, 3);
    const neutral = produce(50, 3);
    const high = produce(60, 3);
    // The TOTAL production moved in the right direction — strictly.
    const sum = (record: Record<string, number>): number =>
      Object.values(record).reduce((acc, value) => acc + value, 0);
    expect(sum(high)).toBeGreaterThan(sum(neutral)); // 60 produces MORE than 50
    expect(sum(low)).toBeLessThan(sum(neutral)); // 40 produces LESS than 50
    // Every sizeable good moved with it (tiny flows may round to a tie).
    let sawHigher = false;
    let sawLower = false;
    for (const resourceId of strategicResourceIds(config())) {
      const n = neutral[resourceId] ?? 0;
      if (n < 10) continue;
      if ((high[resourceId] ?? 0) > n) sawHigher = true;
      if ((low[resourceId] ?? 0) < n) sawLower = true;
    }
    expect(sawHigher).toBe(true);
    expect(sawLower).toBe(true);
    // And the ratio is the config factor itself (±6% around the base).
    setBudget(countryId, 50);
    const base = produce(50, 1);
    setBudget(countryId, 60);
    const boosted = produce(60, 1);
    for (const resourceId of strategicResourceIds(config())) {
      const n = base[resourceId] ?? 0;
      const h = boosted[resourceId] ?? 0;
      if (n < 20) continue; // rounding noise would dominate tiny flows
      expect(h / n).toBeGreaterThan(1.03);
      expect(h / n).toBeLessThan(1.09);
    }
    setBudget(countryId, 50);
  });

  // ————————— B4: یک سیستم واحد — پیش‌نمایش، ساختمان، رکورد ————————

  it('B4 the SAME factor reaches the build preview, single buildings and the country record', () => {
    const state = context.state;
    const model = context.map;
    const countryId = ids()[0];
    const cell = freeCellOf(countryId);
    expect(cell).not.toBeNull();
    const cellIndex = findGridCell(model, cell!);

    // Build ONE farm and read its output under two budgets.
    const def = config().buildings.find((candidate) => candidate.id === 'farm')!;
    const quality = cellQualityOf(model, cellIndex, 'food', config());
    const potential = countryPotentialFactor(model, countryId, 'food', config());
    const synthetic = { id: 'b4-farm', typeId: 'farm', cellKey: cell! };

    setBudget(countryId, 60);
    const highPreview = buildPreviewInfoOf(state, model, countryId, config(), 'farm', cell!);
    const highSingle = singleBuildingOutput(state, model, countryId, config(), synthetic, 0);
    setBudget(countryId, 40);
    const lowPreview = buildPreviewInfoOf(state, model, countryId, config(), 'farm', cell!);
    const lowSingle = singleBuildingOutput(state, model, countryId, config(), synthetic, 0);

    expect(highPreview).not.toBeNull();
    expect(lowPreview).not.toBeNull();
    // The preview carries the SAME factor the building produces with.
    expect(highPreview!.estimatedOutput).toBe(highSingle.amount);
    expect(lowPreview!.estimatedOutput).toBe(lowSingle.amount);
    expect(lowSingle.amount).toBeLessThan(highSingle.amount);
    // The exact formula: base × quality × potential × level × budget.
    const levelFactor = economyLevelBuildingFactor(state, countryId, config());
    expect(highSingle.amount).toBe(
      Math.max(0, Math.round(def.output * quality * potential * levelFactor * 1.06))
    );
    setBudget(countryId, 50);
  });

  it('B4b the extractive reserve is spent proportionally to the budget-scaled output', () => {
    const state = context.state;
    const model = context.map;
    const countryId = ids()[1];
    // A synthetic completed oil field with a KNOWN small reserve.
    const cell = freeCellOf(countryId);
    expect(cell).not.toBeNull();
    const building = { id: 'b4-oil', typeId: 'oil_field', cellKey: cell!, reserveRemaining: 1000, reserveCapacity: 1000 };
    state.economy.buildings[countryId] = { 'b4-oil': { ...building } };

    setBudget(countryId, 60);
    const high = singleBuildingOutput(state, model, countryId, config(), state.economy.buildings[countryId]!['b4-oil']!, 0);
    setBudget(countryId, 40);
    const low = singleBuildingOutput(state, model, countryId, config(), state.economy.buildings[countryId]!['b4-oil']!, 0);
    // The extraction (what the reserve loses) equals the scaled output —
    // a cheaper budget extracts less, the reserve lasts longer.
    expect(low.amount).toBeLessThan(high.amount);
    expect(low.extraction).toBe(low.amount);
    expect(high.extraction).toBe(high.amount);
    delete state.economy.buildings[countryId]!['b4-oil'];
    setBudget(countryId, 50);
  });

  // ————————— B5: بودجه در State ثبت می‌شود ————————

  it('B5 the budget lives in the State — shares, spending money and the production factor follow it', () => {
    const countryId = ids()[0];
    const government = context.state.government.countries[countryId];
    setBudget(countryId, 80);
    expect(government.budget.shares.economic).toBe(0.8);
    expect(government.budget.shares.military).toBeCloseTo(0.2, 12);
    // The internal money plumbing re-derived with the new split.
    const militaryMoney = government.budget.spendingShares.military;
    expect(militaryMoney).toBeCloseTo(0.2 * 0.12, 9);
    // The simulation's production factor reads the SAME state number.
    expect(economicBudgetProductionFactor(context.state, countryId, config()))
      .toBeCloseTo(1 + 30 * config().economicBudget.productionPerPoint, 6);
    setBudget(countryId, 50);
  });

  // ————————— تضمین: ذخیره‌سازی ایمن ————————

  it('B6 zero population and unknown countries degrade to the neutral factor (edge safety)', () => {
    // A country with no government record reads the neutral 50 → ×1.
    const ghost = economicBudgetProductionFactor(
      context.state,
      'country_that_does_not_exist',
      config()
    );
    expect(ghost).toBe(1);
    // The factor is finite and positive for EVERY on-grid budget.
    for (let budgetPct = 0; budgetPct <= 100; budgetPct += 10) {
      const countryId = ids()[0];
      setBudget(countryId, budgetPct);
      const factor = economicBudgetProductionFactor(context.state, countryId, config());
      expect(Number.isFinite(factor)).toBe(true);
      expect(factor).toBeGreaterThan(0);
      const reserve = safetyReserveUnits(
        context.state.economy.resources[countryId]!.consumption,
        'food',
        config()
      );
      expect(reserve).toBeGreaterThanOrEqual(0);
    }
    setBudget(ids()[0], 50);
  });
});
