/**
 * Resource economy + GLOBAL TRADE NETWORK tests (the redesigned economy).
 *
 * Covers the directive's mandatory tests that live at the WORLD level plus
 * the standing invariants of the new model:
 *  - T4: two AI countries trade with each other with NO player involvement
 *  - T6: years of simulation → NO permanent world famine, resources never
 *    all collapse to zero, trade and production stay alive
 *  - stockpiles are REAL: the monthly stock step moves them exactly by
 *    production + imports − consumption − exports (conservation)
 *  - every country owns a starting buffer; deposits are permanent capacity
 *  - the emergency FOOD safety pass moves real stock when flows fall short
 *  - unfilled shortage only when GLOBAL supply cannot cover GLOBAL demand
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestGame } from '../../helpers/testGame';
import type { Game } from '../../../core/Game';
import type { SystemContext } from '../../../core/GameContext';
import {
  recomputeResourceEconomies,
  resourceStatusOf,
  resourceRawBalanceOf,
  resourceDisplayStatusOf,
  realShortageOf
} from '../../../economy/resources';
import { resolveWorldTradeForResource } from '../../../economy/tradeNetwork';
import type { CountryResourceState } from '../../../economy/resourceTypes';
import type { StrategicMapModel } from '../../../world/map/MapTypes';

describe('resource economy (stockpiles, world trade, anti-famine)', () => {
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

  const countryIds = (): string[] =>
    mapModel.countryOrder.filter((id) => context.state.economy.resources[id] !== undefined);

  /** Σ of the TRUE surplus (max(P−C, 0)) of a resource over the given countries. */
  function globalSupplyOf(resourceId: string, ids: readonly string[]): number {
    return ids.reduce((sum, countryId) => {
      const record = context.state.economy.resources[countryId]!;
      const balance =
        (record.production[resourceId] ?? 0) - (record.consumption[resourceId] ?? 0);
      return sum + Math.max(0, balance);
    }, 0);
  }

  /** Σ of the TRUE shortage (max(C−P, 0)) of a resource over the given countries. */
  function globalDemandOf(resourceId: string, ids: readonly string[]): number {
    return ids.reduce((sum, countryId) => {
      const record = context.state.economy.resources[countryId]!;
      const balance =
        (record.production[resourceId] ?? 0) - (record.consumption[resourceId] ?? 0);
      return sum + Math.max(0, -balance);
    }, 0);
  }

  it('only the SIX directive resources exist — no gold, no legacy ids', () => {
    expect(config.resources.map((resource) => resource.id)).toEqual([
      'oil', 'iron', 'coal', 'copper', 'food', 'wood'
    ]);
    // Deposits: every deposit's resource is one of the six (no gold sites).
    for (const deposit of mapModel.features.deposits) {
      expect(config.resources.some((resource) => resource.id === deposit.resourceId)).toBe(true);
    }
  });

  it('every country owns a REAL starting stockpile of every resource (spec §2)', () => {
    for (const countryId of countryIds()) {
      const record = context.state.economy.resources[countryId]!;
      for (const resource of config.resources) {
        const stock = record.stock[resource.id] ?? 0;
        expect(stock, `${countryId} ${resource.id}`).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(stock)).toBe(true);
      }
      // The configured buffer is seeded (food at least the configured amount).
      expect(record.stock.food).toBeGreaterThanOrEqual(config.startingStock.food ?? 0);
    }
  });

  it('the WORLD produces enough of every resource — no chronic unfilled shortage', () => {
    const ids = countryIds();
    for (const resource of config.resources) {
      const supply = globalSupplyOf(resource.id, ids);
      const demand = globalDemandOf(resource.id, ids);
      expect(
        supply >= demand,
        `${resource.id}: global supply ${supply} < global demand ${demand}`
      ).toBe(true);
      for (const countryId of ids) {
        const unfilled = context.state.economy.resources[countryId]!.unfilledShortage[resource.id] ?? 0;
        expect(unfilled, `${resource.id} unfilled in ${countryId}`).toBe(0);
      }
    }
  });

  it('trade stays alive — exporters AND importers exist for every resource', () => {
    const ids = countryIds();
    for (const resource of config.resources) {
      let exporters = 0;
      let importers = 0;
      for (const countryId of ids) {
        const record = context.state.economy.resources[countryId]!;
        if ((record.exports[resource.id] ?? 0) > 0) exporters += 1;
        if ((record.imports[resource.id] ?? 0) > 0) importers += 1;
      }
      expect(exporters, `${resource.id} exporters`).toBeGreaterThan(0);
      expect(importers, `${resource.id} importers`).toBeGreaterThan(0);
    }
  });

  it('TEST 4 — two AI countries trade with each other without any player involvement', () => {
    const playerId = context.state.player.countryId;
    const ids = countryIds();
    // Conservation first: every exported unit appears as exactly one import.
    for (const resource of config.resources) {
      let exported = 0;
      let imported = 0;
      for (const countryId of ids) {
        const record = context.state.economy.resources[countryId]!;
        exported += record.exports[resource.id] ?? 0;
        imported += record.imports[resource.id] ?? 0;
      }
      expect(Math.round(exported)).toBe(Math.round(imported));
    }
    // THEN the actual Test 4: an AI→AI flow must exist somewhere.
    let aiToAi = 0;
    for (const resource of config.resources) {
      for (const buyerId of ids) {
        if (buyerId === playerId) continue;
        const record = context.state.economy.resources[buyerId]!;
        for (const [sellerId, amount] of Object.entries(record.suppliers[resource.id] ?? {})) {
          if (sellerId !== playerId && amount > 0) aiToAi += 1;
        }
      }
    }
    expect(aiToAi).toBeGreaterThan(0);
  });

  it('the monthly stock step moves stockpiles exactly by the net flow', () => {
    const state = context.state;
    const ids = countryIds();
    // Take a snapshot, run one monthly pass, verify the exact delta.
    const before: Record<string, Record<string, number>> = {};
    for (const countryId of ids) {
      before[countryId] = { ...state.economy.resources[countryId]!.stock };
    }
    recomputeResourceEconomies(state, mapModel, config, { applyStockStep: true });
    for (const countryId of ids) {
      const record = state.economy.resources[countryId]!;
      for (const resource of config.resources) {
        const id = resource.id;
        const expected =
          (before[countryId][id] ?? 0) +
          (record.production[id] ?? 0) +
          (record.imports[id] ?? 0) -
          (record.consumption[id] ?? 0) -
          (record.exports[id] ?? 0);
        const actual = record.stock[id] ?? 0;
        expect(
          Math.abs(actual - Math.max(0, expected)),
          `${countryId} ${id}: ${actual} vs ${expected}`
        ).toBeLessThanOrEqual(1);
      }
    }
  });

  it('TEST 6 — years of simulation: no world famine, trade and production alive', () => {
    // Fresh world, run through the REAL GovernmentSystem cadence (6 years).
    const longGame = createTestGame({ seed: 777 });
    longGame.setTimeMode('month');
    longGame.runTicks(72 * 15 + 30); // 72 month-units
    const longContext = longGame.gameContext;
    const longState = longContext.state;
    const ids = longContext.map.countryOrder.filter(
      (id) => longState.economy.resources[id] !== undefined
    );

    let famine = 0;
    let unfilledTotal = 0;
    let productionAlive = 0;
    let tradeAlive = 0;
    for (const countryId of ids) {
      const record = longState.economy.resources[countryId]!;
      const cons = record.consumption.food ?? 0;
      const cover =
        (record.production.food ?? 0) +
        (record.imports.food ?? 0) +
        (record.emergencyImports.food ?? 0);
      if ((record.stock.food ?? 0) <= 0 && cover < cons) famine += 1;
      unfilledTotal += Object.values(record.unfilledShortage).reduce((sum, value) => sum + value, 0);
      for (const resource of config.resources) {
        if ((record.production[resource.id] ?? 0) > 0) productionAlive += 1;
        if ((record.imports[resource.id] ?? 0) > 0 || (record.exports[resource.id] ?? 0) > 0) tradeAlive += 1;
      }
    }
    // No permanent famine anywhere.
    expect(famine).toBe(0);
    // The world market leaves (almost) nothing unfilled after years.
    expect(unfilledTotal).toBe(0);
    // Production never died (every country still produces most resources).
    expect(productionAlive).toBeGreaterThan(ids.length * (config.resources.length - 2));
    // Trade still flows somewhere (the market did not dry up).
    expect(tradeAlive).toBeGreaterThan(0);
    longGame.dispose();
  });

  it('statuses derive from REAL numbers — surplus / balanced / shortage', () => {
    const ids = countryIds();
    let sawSurplus = false;
    let sawBalanced = false;
    for (const countryId of ids) {
      const record = context.state.economy.resources[countryId]!;
      for (const resource of config.resources) {
        const status = resourceDisplayStatusOf(record, resource.id, config.displayStatus);
        const raw = resourceRawBalanceOf(record, resource.id);
        if (status === 'surplus') {
          sawSurplus = true;
          expect(raw).toBeGreaterThan(0);
          expect(resourceStatusOf(record, resource.id)).not.toBe('shortage');
          // A surplus country REALLY holds the buffer it claims (spec §2).
          expect(record.stock[resource.id] ?? 0)
            .toBeGreaterThanOrEqual(config.displayStatus.surplusBufferMonths * (record.consumption[resource.id] ?? 0));
        }
        if (status === 'balanced') sawBalanced = true;
      }
    }
    expect(sawSurplus).toBe(true);
    expect(sawBalanced).toBe(true);
  });

  it('TEST 1 — production 31, consumption 30, stockpile 0 is NOT an exporter', () => {
    const record: CountryResourceState = {
      stock: { iron: 0 },
      production: { iron: 31 },
      consumption: { iron: 30 },
      imports: {},
      exports: {},
      suppliers: {},
      unfilledShortage: {},
      emergencyImports: {},
      importCost: 0,
      exportIncome: 0
    };
    // The display status is BALANCED — a +1/month trickle is not a surplus.
    expect(resourceDisplayStatusOf(record, 'iron')).toBe('balanced');
    // And the world matcher gets NO export offer: the warehouse is empty.
    const result = resolveWorldTradeForResource(
      ['a', 'b'],
      { a: { iron: 31 }, b: { iron: 0 } },
      { a: { iron: 30 }, b: { iron: 10 } },
      'iron',
      { a: 0 } // the offer the recompute pass derives for an empty stock
    );
    expect(result.exportsBySeller['a'] ?? 0).toBe(0);
    expect(result.flows).toEqual([]);
    // A covered-by-stock deficit is a draw-down, not an emergency either.
    const stocky: CountryResourceState = {
      ...record,
      stock: { iron: 40 },
      production: { iron: 0 },
      consumption: { iron: 30 },
      imports: {}
    };
    expect(resourceDisplayStatusOf(stocky, 'iron')).toBe('balanced');
    expect(realShortageOf(stocky, 'iron')).toBe(0);
  });

  it('TEST 2 — production 50, consumption 30, stockpile 2,000 CAN export', () => {
    const record: CountryResourceState = {
      stock: { iron: 2000 },
      production: { iron: 50 },
      consumption: { iron: 30 },
      imports: {},
      exports: {},
      suppliers: {},
      unfilledShortage: {},
      emergencyImports: {},
      importCost: 0,
      exportIncome: 0
    };
    expect(resourceDisplayStatusOf(record, 'iron')).toBe('surplus');
    // The matcher sells the real offer (capped by the free stock).
    const result = resolveWorldTradeForResource(
      ['a', 'b'],
      { a: { iron: 50 }, b: { iron: 0 } },
      { a: { iron: 30 }, b: { iron: 40 } },
      'iron',
      { a: 20 }
    );
    expect(result.exportsBySeller['a']).toBe(20);
    expect(result.importsByBuyer['b']).toBe(20);
  });

  it('TEST 9 — the treasury persists month after month (never zeroed)', () => {
    const persistGame = createTestGame({ seed: 909 });
    persistGame.setTimeMode('month');
    const persistContext = persistGame.gameContext;
    const playerId = persistContext.state.player.countryId;
    const treasuryOf = (): number => persistContext.state.economy.treasury[playerId] ?? 0;
    expect(treasuryOf()).toBeGreaterThan(0);
    const samples: number[] = [];
    for (let i = 0; i < 24; i += 1) {
      persistGame.runTicks(15); // one month-unit
      samples.push(treasuryOf());
    }
    // The treasury CARRIES over: not reset to a fixed value every month.
    const allZero = samples.every((value) => value === 0);
    expect(allZero).toBe(false);
    const identical = samples.every((value) => value === samples[0]);
    expect(identical).toBe(false); // it actually moves with the ledger
    persistGame.dispose();
  });

  it('the world matcher stays deterministic and order-independent', () => {
    const production: Record<string, Record<string, number>> = {
      a: { iron: 100 }, b: { iron: 0 }, c: { iron: 30 }, d: { iron: 0 }
    };
    const consumption: Record<string, Record<string, number>> = {
      a: { iron: 20 }, b: { iron: 60 }, c: { iron: 0 }, d: { iron: 50 }
    };
    const forward = resolveWorldTradeForResource(['a', 'b', 'c', 'd'], production, consumption, 'iron');
    const reversed = resolveWorldTradeForResource(['d', 'c', 'b', 'a'], production, consumption, 'iron');
    expect(forward.flows).toEqual(reversed.flows);
    // a: surplus 80 → sells; c: surplus 30 → sells; demand b 60 + d 50 = 110 ≤ 110.
    expect(forward.unfilledByBuyer).toEqual({});
    const totalSold = Object.values(forward.exportsBySeller).reduce((sum, value) => sum + value, 0);
    expect(totalSold).toBe(110);
  });
});
