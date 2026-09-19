/**
 * THE YEAR-OVER-YEAR DEMAND GROWTH (the demand directive §1) — consumption
 * climbs with the campaign's years so the world stops drifting into an
 * all-exporter state, while supply grows WITH it (the coupled baseline) and
 * the world stays alive:
 *
 *  Y1  the growth factor is exact, stateless and capped: (1+perYear)^(m/12)
 *  Y2  the monthly cycle compounds the demand month by month (real records)
 *  Y3  a 20-YEAR world run: consumption grows significantly (yr 20 ≥ 1.5×
 *      yr 1), NOT everyone becomes an exporter (the reported bug), the
 *      markets show REAL variable sale quantities (never a "1" everywhere),
 *      famine stays the minority and nobody goes bankrupt
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestGame } from '../../helpers/testGame';
import type { SystemContext } from '../../../core/GameContext';
import { runEconomyCycle } from '../../../economy/economyCycle';
import { consumptionGrowthFactorOf } from '../../../economy/resources';
import { stepProjects, startProject, workforceCapacityOf, workforceUsedBy } from '../../../economy/construction';
import {
  aiTradeStep,
  aiBuildingTypeId,
  aiSecureConstructionMaterials
} from '../../../economy/aiEconomy';
import { marketOffersOf } from '../../../economy/contracts';
import { strategicResourceIds } from '../../../economy/resources';
import { cellQualityOf, countryPotentialFactor } from '../../../economy/quality';
import { Random } from '../../../utils/Random';

describe('the year-over-year demand growth (demand directive)', () => {
  let context: SystemContext;
  let config: any;

  beforeAll(() => {
    const game = createTestGame({ seed: 4242 });
    context = game.gameContext;
    config = context.data.economyData.strategicResources;
  });

  it('Y1 the factor is exact, stateless and capped: (1+perYear)^(months/12)', () => {
    expect(consumptionGrowthFactorOf(config, 0)).toBe(1);
    const perYear = config.consumptionGrowth.perYear as number;
    const year5 = Math.pow(1 + perYear, 60 / 12);
    expect(consumptionGrowthFactorOf(config, 60)).toBeCloseTo(year5, 4);
    // Monotonic in the month, capped at maxFactor.
    expect(consumptionGrowthFactorOf(config, 61)).toBeGreaterThan(consumptionGrowthFactorOf(config, 60));
    const capped = consumptionGrowthFactorOf(config, 12_000);
    expect(capped).toBe(config.consumptionGrowth.maxFactor);
    // Zero growth stays flat (config-off safety).
    const off = { ...config, consumptionGrowth: { perYear: 0, maxFactor: 4 } };
    expect(consumptionGrowthFactorOf(off, 240)).toBe(1);
  });

  it('Y2 the monthly cycle compounds the demand into the REAL records', () => {
    const game = createTestGame({ seed: 777 });
    const state = game.gameContext.state;
    const map = game.gameContext.map;
    const cfg = game.gameContext.data.economyData.strategicResources;
    const countryId = map.countryOrder[0];
    const consumptionAt = (month: number): number => {
      runEconomyCycle(state, map, cfg, { applyStep: true, month });
      return state.economy.resources[countryId]!.consumption.food ?? 0;
    };
    const early = consumptionAt(2);
    const late = consumptionAt(122);
    expect(late).toBeGreaterThan(early); // demand really climbs with the years
    // ≈ ×1.04^10 over the decade (± population rounding) — significant.
    expect(late / early).toBeGreaterThanOrEqual(1.25);
  });

  it('Y3 a 20-YEAR world: growing demand, a MIXED trade map, real sale quantities, no collapse', () => {
    const game = createTestGame({ seed: 1337 });
    const state = game.gameContext.state;
    const model = game.gameContext.map;
    const cfg = game.gameContext.data.economyData.strategicResources;
    const ids = model.countryOrder.filter((id) => state.economy.finance[id] !== undefined);
    const goods = strategicResourceIds(cfg);
    let counter = 0;
    const newId = (kind: string) => `${kind}-y3-${counter++}`;
    const rng = new Random(1337);

    const meanFoodConsumption = (): number =>
      ids.reduce((sum, id) => sum + (state.economy.resources[id]!.consumption.food ?? 0), 0) / ids.length;
    const foodExporters = (): number =>
      ids.filter((id) => {
        const record = state.economy.resources[id]!;
        return (record.production.food ?? 0) - (record.consumption.food ?? 0) > 0;
      }).length;
    const famine = (): number =>
      ids.filter((id) => (state.economy.resources[id]!.shortage.food ?? 0) > 0).length;
    const broke = (): number => ids.filter((id) => (state.economy.treasury[id] ?? 0) <= 0).length;

    const consumptionByYear = new Map<number, number>();
    const exportersByYear = new Map<number, number>();
    const famineByYear = new Map<number, number>();
    const checkpoints = new Set([12, 60, 120, 239]);

    for (let month = 0; month < 240; month += 1) {
      runEconomyCycle(state, model, cfg, { applyStep: true, month });
      for (const countryId of ids) stepProjects(state, model, countryId, cfg, month);
      for (const countryId of ids) {
        if (countryId === state.player.countryId) continue;
        aiTradeStep(state, countryId, cfg, month, rng, newId);
        // The SAME construction cadence the real GovernmentSystem runs
        // (an 8% monthly chance under the same affordability gates).
        if (!rng.chance(0.08)) continue;
        const typeId = aiBuildingTypeId(state, model, countryId, cfg);
        const def = cfg.buildings.find((candidate: { id: string }) => candidate.id === typeId);
        if (def === undefined) continue;
        const treasury = state.economy.treasury[countryId] ?? 0;
        if (treasury < def.cost * 1.5) continue;
        if (workforceUsedBy(state, countryId, cfg) + def.workforce > workforceCapacityOf(state, countryId, cfg)) continue;
        if (!aiSecureConstructionMaterials(state, countryId, cfg, def.materials)) continue;
        const country = model.countries[countryId]!;
        let bestKey: string | null = null;
        let bestQuality = -1;
        for (const cellIndex of country.cellIds) {
          const gridId = model.features.gridIds[cellIndex]!;
          if (gridId === null) continue;
          const key = `${countryId}#${gridId}`;
          const occupied =
            Object.values(state.economy.buildings[countryId] ?? {}).some((b) => b.cellKey === key) ||
            (state.economy.construction[countryId]?.projects ?? []).some((p) => p.cellKey === key);
          if (occupied) continue;
          const quality =
            cellQualityOf(model, cellIndex, def.resource ?? '', cfg) *
            countryPotentialFactor(model, countryId, def.resource ?? '', cfg);
          if (quality > bestQuality) {
            bestQuality = quality;
            bestKey = key;
          }
        }
        if (bestKey !== null) {
          startProject(state, countryId, cfg, def.id, bestKey, month, () => newId('building'));
        }
      }
      if (checkpoints.has(month)) {
        const year = Math.round(month / 12);
        consumptionByYear.set(year, meanFoodConsumption());
        exportersByYear.set(year, foodExporters());
        famineByYear.set(year, famine());
      }
    }

    // —— THE MANDATORY CHECKPOINTS (the directive's years 1 / 5 / 10 / 20) ——
    // (a) Consumption grew SIGNIFICANTLY year over year — the year-20 mean
    //     is ≥ 1.5× the year-1 mean (not a one-shot start-of-game bump).
    const first = consumptionByYear.get(1)!;
    const last = consumptionByYear.get(20)!;
    expect(last).toBeGreaterThanOrEqual(first * 1.5);
    for (const [year, value] of [[5, consumptionByYear.get(5)!], [10, consumptionByYear.get(10)!]] as const) {
      expect(value).toBeGreaterThan(first); // every checkpoint grew further
      void year;
    }
    // (b) NOT everyone became an exporter (the reported bug): the food
    //     exporter count FALLS from its year-1 level and importers exist.
    expect(exportersByYear.get(20)!).toBeLessThan(ids.length - 2);
    expect(exportersByYear.get(20)!).toBeLessThanOrEqual(exportersByYear.get(1)!);
    // (c) The markets show REAL, VARIABLE sale quantities — no good's market
    //     is a wall of "1" (the sale-quantity directive).
    for (const resourceId of goods) {
      const offers = ids
        .filter((id) => id !== state.player.countryId)
        .flatMap((id) => marketOffersOf(state, id, resourceId, cfg).map((offer) => offer.amount));
      if (offers.length === 0) continue; // a globally starved good has no sellers
      expect(Math.max(...offers)).toBeGreaterThanOrEqual(5);
    }
    // (d) No cascading collapse: famine stays the MINORITY and nobody is broke.
    expect(famineByYear.get(20)!).toBeLessThanOrEqual(Math.floor(ids.length * 0.5));
    expect(broke()).toBe(0);
  });
});


