/**
 * THE CONTRACT TRADE — the 26-section directive's mandatory scenarios:
 *
 *  T1  production 0, imports 0, stock 0, consumption 100 → Shortage = 100
 *      (zero stock NEVER means zero shortage — §13)
 *  T2  production 40, stock 0, consumption 100 → Shortage = 60 (§13/§14)
 *  T3  shortage 200, sellers 50/100/25 → imported 175, the REST stays short
 *      (§5/§21 — the market never invents the missing units)
 *  T4  a country that is itself short NEVER becomes a seller of that good;
 *      the offers never depend on the buyer's shortage (§1/§3)
 *  T5  a 50/month contract delivers 50 in month 1, 2, 3… until cancelled (§6/§18)
 *  T6  cancellation stops the delivery from the next month on (§7/§18)
 *  T7  contract 100 with a seller holding 30 real spare → delivers 30 (§9)
 *  T8  a persistent under-supply keeps the shortage EVERY month — no
 *      random vanishing/reappearing (§11/§19)
 *  T9  the starting stock drains month by month; when it is gone the
 *      shortage appears (§10/§12)
 *  T10 a LONG world run: no artificial goods, not everyone becomes a
 *      seller, contracts continue monthly, no duplicate-contract
 *      explosion, AI countries have REAL shortages and surpluses, one
 *      seller serves several buyers, one buyer imports from several
 *      sellers (§22/§23/§25)
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestGame } from '../../helpers/testGame';
import type { Game } from '../../../core/Game';
import type { SystemContext } from '../../../core/GameContext';
import { runEconomyCycle } from '../../../economy/economyCycle';
import { shortageOf, safetyReserveUnits, strategicResourceIds, resourceDisplayStatusOf, consumptionGrowthFactorOf } from '../../../economy/resources';
import {
  marketOffersOf,
  availableSurplusOf,
  exportCapacityOf,
  saleQuotaOf,
  remainingSaleOfferOf,
  signContract,
  cancelContract,
  executeMonthlyContracts,
  activeContracts,
  unitPriceOf
} from '../../../economy/contracts';
import { stepProjects, startProject, workforceCapacityOf, workforceUsedBy } from '../../../economy/construction';
import { committedExportUnitsOf } from '../../../economy/contracts';
import { aiBuildingTypeId, aiSecureConstructionMaterials, aiTradeStep } from '../../../economy/aiEconomy';
import { economicBuildingAtCell, cellIsUnderConstruction } from '../../../economy/resources';
import { cellQualityOf } from '../../../economy/quality';
import { gridCellKey } from '../../../world/map/MapTypes';
import { Random } from '../../../utils/Random';
import { roundTo } from '../../../utils/math';

describe('the contract trade (26-section spec: the market never invents goods)', () => {
  let game: Game;
  let context: SystemContext;

  beforeAll(() => {
    game = createTestGame({ seed: 777 });
    context = game.gameContext;
  });

  const config = () => context.data.economyData.strategicResources;
  const ids = (): string[] =>
    context.map.countryOrder.filter((id) => context.state.economy.finance[id] !== undefined);

  /** The country with the LARGEST REAL food flow deficit (production < consumption). */
  const biggestFoodDeficit = (): { id: string; gap: number } => {
    const ranked = ids()
      .map((id) => {
        const record = context.state.economy.resources[id]!;
        return { id, gap: (record.consumption.food ?? 0) - (record.production.food ?? 0) };
      })
      .sort((a, b) => b.gap - a.gap);
    return ranked[0];
  };

  /** Fills ONE country's stock of ONE good so its REAL spare above the
   *  reserve is exactly `spare` (the sale quota is then spare × share). */
  const giveSpare = (countryId: string, resourceId: string, spare: number): void => {
    const record = context.state.economy.resources[countryId]!;
    record.stock[resourceId] = spare + safetyReserveUnits(record.consumption, resourceId, config());
    // The capacity = stock − reserve + max(0, P − C): neutralize the flow
    // term so the quota below is EXACTLY the stock spare × share (the
    // demand-growth directive added the month's surplus flow to capacity).
    record.production[resourceId] = record.consumption[resourceId] ?? 0;
  };

  /** Fills ONE country's stock so its SALE QUOTA (the market offer) is
   *  exactly `offer` units — capacity = offer ÷ saleQuotaShare. */
  const giveQuota = (countryId: string, resourceId: string, offer: number): void => {
    const share = config().market.saleQuotaShare;
    giveSpare(countryId, resourceId, Math.ceil(offer / share));
  };

  // ————————— T1/T2: کمبود واقعی — صفر بودن انبار به معنی صفر بودن کمبود نیست ————————

  it('T1 stock 0, production 0, consumption 100 → Shortage = 100 (§13)', () => {
    // THE formula, exactly as the directive states it.
    expect(shortageOf(0, 0, 100)).toBe(100);
    // And the cycle computes it honestly for EVERY country: the recorded
    // shortage is consumption − production − month-start stock − deliveries.
    const state = context.state;
    state.economy.contracts = [];
    for (const id of ids()) {
      const record = state.economy.resources[id]!;
      record.stock = { food: 0, iron: 0, oil: 0, industrial: 0 };
      record.shortage = {};
      record.shortageMonths = {};
    }
    runEconomyCycle(state, context.map, config(), { applyStep: true, month: 1 });
    for (const id of ids()) {
      const record = state.economy.resources[id]!;
      for (const resourceId of strategicResourceIds(config())) {
        const expected = Math.max(
          0,
          Math.round(
            (record.consumption[resourceId] ?? 0) -
              (record.production[resourceId] ?? 0) -
              0 - // the month-start stock was 0 for every good
              (record.imports[resourceId] ?? 0)
          )
        );
        expect(record.shortage[resourceId] ?? 0).toBe(expected);
      }
    }
  });

  it('T2 production 40, stock 0, consumption 100 → Shortage = 60 (§13/§14)', () => {
    // THE formula: production covers part of the need, the rest is short.
    expect(shortageOf(0, 40, 100)).toBe(60);
    // A month-start BUFFER absorbs the gap without an emergency (§12):
    expect(shortageOf(60, 40, 100)).toBe(0);
    // ...but only while the buffer lasts — a 59-unit buffer leaves 1 short.
    expect(shortageOf(59, 40, 100)).toBe(1);
  });

  // ————————— T3: چند فروشنده — بازار فقط عرضهٔ واقعی را می‌آورد ————————

  it('T3 several sellers deliver only their REAL 175 of a 200 need — the rest stays short (§5/§21)', () => {
    const state = context.state;
    const { id: buyerId, gap } = biggestFoodDeficit();
    expect(gap).toBeGreaterThan(0);
    state.economy.contracts = [];
    const buyer = state.economy.resources[buyerId]!;
    buyer.stock = { food: 0, iron: 0, oil: 0, industrial: 0 };
    state.economy.treasury[buyerId] = 100_000;

    // Three sellers with REAL quotas: the need's 30% + 40% + 17.5% — in
    // total 87.5% of the gap, so 12.5% of it CANNOT be covered by the
    // market (the spec's 200 → 175 → 25 shape, scaled to the real gap).
    const sellers = ids().filter((id) => id !== buyerId).slice(0, 3);
    const shares = [0.3, 0.4, 0.175];
    let planned = 0;
    for (const [index, sellerId] of sellers.entries()) {
      const amount = Math.max(1, Math.floor(gap * shares[index]));
      giveQuota(sellerId, 'food', amount);
      expect(remainingSaleOfferOf(state, sellerId, 'food', config())).toBe(amount);
      const signed = signContract(state, buyerId, sellerId, 'food', amount, 50, config(), () => `t3-${index}`);
      expect(signed.ok).toBe(true);
      planned += amount;
    }
    expect(planned).toBeLessThan(gap); // the market holds LESS than the need

    runEconomyCycle(state, context.map, config(), { applyStep: true, month: 51 });

    const record = state.economy.resources[buyerId]!;
    // Every real unit moved (175 of the 200, in the spec's numbers)...
    expect(record.imports.food ?? 0).toBe(planned);
    // ...and the REMAINING shortage stays — the market never invents
    // the missing 25 (§21: «سیستم حق ندارد +۸۰ کالای ساختگی ایجاد کند»).
    const produced = Math.round(record.production.food ?? 0);
    // The month-0 `gap` grew by the campaign month's DEMAND GROWTH (the
    // demand directive: (1+perYear)^(51/12) ≈ ×1.14) — so the honest
    // remainder is LARGER than the month-0 plan, never smaller.
    expect(record.shortage.food ?? 0).toBeGreaterThanOrEqual(gap - planned);
    expect(record.shortage.food ?? 0).toBe(
      Math.max(0, Math.round((record.consumption.food ?? 0) - produced - planned))
    );
    expect(record.shortage.food ?? 0).toBeGreaterThan(0);
  });

  // ————————— T4: کشور کمبوددار فروشنده نمی‌شود ————————
  it('T4 a country with its own shortage never appears as a seller; offers ignore the buyer (§1/§3)', () => {
    const state = context.state;
    state.economy.contracts = [];
    const buyerId = ids()[0];
    // A country whose food stock is EMPTY (or below its reserve) holds no
    // real surplus — it must never be offered as a seller, whatever its
    // production or the buyer's need looks like.
    const poorSeller = ids()[1];
    const poorRecord = state.economy.resources[poorSeller]!;
    poorRecord.stock.food = 0;
    poorRecord.shortage.food = 50; // it is itself short
    expect(exportCapacityOf(state, poorSeller, 'food', config())).toBe(0);
    expect(saleQuotaOf(state, poorSeller, 'food', config())).toBe(0);
    expect(availableSurplusOf(state, poorSeller, 'food', config())).toBe(0);
    expect(marketOffersOf(state, buyerId, 'food', config()).some((o) => o.countryId === poorSeller)).toBe(false);

    // The offers NEVER scale with the buyer's shortage (§1's exact
    // complaint): changing the buyer's recorded need changes NOTHING.
    const before = marketOffersOf(state, buyerId, 'food', config()).map((o) => `${o.countryId}:${o.amount}`);
    state.economy.resources[buyerId]!.shortage.food = 47;
    const afterSmall = marketOffersOf(state, buyerId, 'food', config()).map((o) => `${o.countryId}:${o.amount}`);
    state.economy.resources[buyerId]!.shortage.food = 47_000;
    const afterHuge = marketOffersOf(state, buyerId, 'food', config()).map((o) => `${o.countryId}:${o.amount}`);
    expect(afterSmall).toEqual(before);
    expect(afterHuge).toEqual(before);
  });

  // ————————— T5: قرارداد ماهانه ادامه پیدا می‌کند ————————
  it('T5 a 50/month contract delivers 50 in month 1, 2, 3… until cancelled (§6/§18)', () => {
    const state = context.state;
    state.economy.contracts = [];
    const buyerId = ids()[0];
    const sellerId = ids()[1];
    giveSpare(sellerId, 'oil', 5_000);
    state.economy.treasury[buyerId] = 100_000;
    const price = unitPriceOf(config(), 'oil');
    const signed = signContract(state, buyerId, sellerId, 'oil', 50, 100, config(), () => 't5');
    expect(signed.ok).toBe(true);

    for (let month = 101; month <= 103; month += 1) {
      runEconomyCycle(state, context.map, config(), { applyStep: true, month });
      const buyer = state.economy.resources[buyerId]!;
      const seller = state.economy.resources[sellerId]!;
      expect(buyer.imports.oil ?? 0).toBe(50); // EVERY month, the same 50
      expect(seller.exports.oil ?? 0).toBe(50);
      expect(buyer.tradeExpense).toBeCloseTo(50 * price, 2);
      expect(seller.tradeIncome).toBeCloseTo(50 * price, 2);
    }
    // The record's contract still holds the last real delivery (§8).
    expect(state.economy.contracts.find((c) => c.id === 't5')?.lastDelivery).toBe(50);
  });

  // ————————— T6: لغو قرارداد ————————
  it('T6 cancelling the contract stops the delivery from the NEXT month on (§7/§18)', () => {
    const state = context.state;
    state.economy.contracts = [];
    const buyerId = ids()[0];
    const sellerId = ids()[1];
    giveSpare(sellerId, 'oil', 5_000);
    state.economy.treasury[buyerId] = 100_000;
    const signed = signContract(state, buyerId, sellerId, 'oil', 50, 100, config(), () => 't6');
    expect(signed.ok).toBe(true);

    runEconomyCycle(state, context.map, config(), { applyStep: true, month: 101 });
    expect(state.economy.resources[buyerId]!.imports.oil ?? 0).toBe(50); // still delivering

    expect(cancelContract(state, 't6', buyerId, 101)).toBe('ok');
    runEconomyCycle(state, context.map, config(), { applyStep: true, month: 102 });
    expect(state.economy.resources[buyerId]!.imports.oil ?? 0).toBe(0); // delivery stopped
    expect(state.economy.resources[sellerId]!.exports.oil ?? 0).toBe(0);
    // The cancelled record STAYS in the state (the panel reads it, §8).
    const record = state.economy.contracts.find((c) => c.id === 't6')!;
    expect(record.status).toBe('cancelled');
    expect(record.cancelledMonth).toBe(101);
  });

  // ————————— T7: فروشنده کالا ندارد — تحویل جزئی صادقانه ————————
  it('T7 contract 100 with a seller holding 30 real spare → the market refuses it; a dried seller delivers only what is LEFT (§9/§16)', () => {
    const state = context.state;
    state.economy.contracts = [];
    const buyerId = ids()[0];
    const sellerId = ids()[1];
    // A sale quota of exactly 30 (capacity 60 ÷ share 2) — the seller can
    // sign 30/month, but never more, whatever the buyer demands.
    giveQuota(sellerId, 'iron', 30); // the seller offers only 30 spare units
    expect(remainingSaleOfferOf(state, sellerId, 'iron', config())).toBe(30);
    state.economy.treasury[buyerId] = 100_000;

    // A 100/month commitment against a 30-unit sale quota is REFUSED at
    // signing (the buyer's demand cannot inflate the seller's offer).
    const over = signContract(state, buyerId, sellerId, 'iron', 100, 100, config(), () => 't7a');
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toBe('no-capacity');

    // The honest PARTIAL delivery (§9): a SIGNED 30/month contract whose
    // seller's stock shrinks to 10 real spare delivers exactly 10 — the
    // missing 20 is never faked into existence.
    const ok = signContract(state, buyerId, sellerId, 'iron', 30, 100, config(), () => 't7b');
    expect(ok.ok).toBe(true);
    const sellerRecord = state.economy.resources[sellerId]!;
    sellerRecord.stock.iron = safetyReserveUnits(sellerRecord.consumption, 'iron', config()) + 10;
    executeMonthlyContracts(state, ids(), config(), 101);
    const buyer = state.economy.resources[buyerId]!;
    expect(buyer.imports.iron ?? 0).toBe(10); // ONLY what really existed
    expect(sellerRecord.exports.iron ?? 0).toBe(10);
    expect(state.economy.contracts.find((c) => c.id === 't7b')?.lastDelivery).toBe(10);
  });

  // ————————— T8: کمبود بدون دلیل ناپدید نمی‌شود ————————
  it('T8 a persistent under-supply keeps the shortage EVERY month — never a random 0 (§11/§19)', () => {
    const state = context.state;
    state.economy.contracts = []; // no imports at all
    const { id: buyerId, gap } = biggestFoodDeficit();
    expect(gap).toBeGreaterThan(0);
    const buyer = state.economy.resources[buyerId]!;
    buyer.stock = { food: 0, iron: 0, oil: 0, industrial: 0 };

    const shortages: number[] = [];
    for (let month = 200; month <= 205; month += 1) {
      runEconomyCycle(state, context.map, config(), { applyStep: true, month });
      const record = state.economy.resources[buyerId]!;
      shortages.push(record.shortage.food ?? 0);
    }
    // The deficit is structural (production < consumption, no stock, no
    // imports) — the shortage must be present EVERY single month, tracking
    // the honest flow, never a vanishing/reappearing flip-flop (the OLD
    // bug). The drift across the window = the DEMAND GROWTH (the demand
    // directive: the population base compounds (1+perYear)^(months/12) —
    // the shortage climbs with it) plus rounding.
    const firstFactor = consumptionGrowthFactorOf(config(), 200);
    const lastFactor = consumptionGrowthFactorOf(config(), 205);
    const driftBound = Math.ceil(Math.min(...shortages) * (lastFactor / firstFactor - 1)) + 3;
    expect(Math.min(...shortages)).toBeGreaterThan(0);
    expect(Math.max(...shortages) - Math.min(...shortages)).toBeLessThanOrEqual(driftBound);
    expect(Math.min(...shortages)).toBeGreaterThanOrEqual(gap);
    // The duration clock rose with it (§13's escalation input).
    expect(state.economy.resources[buyerId]!.shortageMonths.food ?? 0).toBeGreaterThanOrEqual(6);
  });

  // ————————— T9: ذخیرهٔ اولیه تمام می‌شود؛ بعدش کمبود ————————
  it('T9 the starting stock drains month by month; when it is gone the shortage appears (§10/§12)', () => {
    const state = context.state;
    state.economy.contracts = [];
    const { id: buyerId, gap } = biggestFoodDeficit();
    expect(gap).toBeGreaterThan(0);
    const buyer = state.economy.resources[buyerId]!;
    // A warehouse buffer of exactly 2.5 months of the deficit.
    buyer.stock = { food: Math.round(gap * 2.5), iron: 0, oil: 0, industrial: 0 };

    let sawBufferedMonths = 0;
    let sawShortage = 0;
    // EARLY months (the demand-growth factor is ≈1 there): this test pins
    // the BUFFER semantics — the years' compounding is the demand probe's
    // subject, not this one's.
    for (let month = 3; month <= 13; month += 1) {
      runEconomyCycle(state, context.map, config(), { applyStep: true, month });
      const shortage = state.economy.resources[buyerId]!.shortage.food ?? 0;
      const stock = state.economy.resources[buyerId]!.stock.food ?? 0;
      if (shortage === 0) sawBufferedMonths += 1;
      else sawShortage += 1;
      void stock;
    }
    // The buffer first ABSORBED the deficit (a draw-down, not an emergency)
    // and the shortage appeared ONLY when the warehouse ran dry — and then
    // it STAYS (each month eats the production, none replenishes the pile).
    expect(sawBufferedMonths).toBeGreaterThanOrEqual(2);
    expect(sawShortage).toBeGreaterThanOrEqual(2);
    const finalRecord = state.economy.resources[buyerId]!;
    const finalGap =
      (finalRecord.consumption.food ?? 0) - (finalRecord.production.food ?? 0);
    expect(finalRecord.shortage.food ?? 0).toBe(finalGap); // dry warehouse → the full flow deficit
    expect(finalRecord.shortage.food ?? 0).toBeGreaterThan(0);
  });

  // ————————— T10: شبیه‌سازی طولانی جهان ————————
  it('T10 a LONG world run: real goods only, contracts persist, no duplicates, real AI shortages and surpluses (§22/§23/§25)', () => {
    const fresh = createTestGame({ seed: 4242 });
    const state = fresh.gameContext.state;
    const model = fresh.gameContext.map;
    const cfg = fresh.gameContext.data.economyData.strategicResources;
    const worldIds = model.countryOrder.filter((id) => state.economy.finance[id] !== undefined);
    const months = 120;
    const rng = new Random(4242);
    let counter = 0;
    const newId = (kind: string) => () => `${kind}-t10-${counter++}`;
    const resourceRank = new Map(cfg.resources.map((r, i) => [r.id, i] as const));

    const tryAiConstruction = (countryId: string, month: number): void => {
      const construction = state.economy.construction[countryId];
      if (construction === undefined || construction.projects.length >= cfg.construction.maxProjects) return;
      const typeId = aiBuildingTypeId(state, model, countryId, cfg);
      const def = cfg.buildings.find((candidate) => candidate.id === typeId);
      if (def === undefined) return;
      if ((state.economy.treasury[countryId] ?? 0) < def.cost * 1.5) return;
      if (workforceUsedBy(state, countryId, cfg) + def.workforce > workforceCapacityOf(state, countryId, cfg)) return;
      if (!aiSecureConstructionMaterials(state, countryId, cfg, def.materials)) return;
      const country = model.countries[countryId];
      if (country === undefined) return;
      let bestKey: string | null = null;
      let bestQuality = -1;
      for (const cellIndex of country.cellIds) {
        const gridId = model.features.gridIds[cellIndex];
        if (gridId === null) continue;
        const key = gridCellKey(countryId, gridId);
        if (economicBuildingAtCell(state, key) !== null) continue;
        if (cellIsUnderConstruction(state, key)) continue;
        const quality = cellQualityOf(model, cellIndex, def.resource ?? '', cfg);
        if (quality > bestQuality) {
          bestQuality = quality;
          bestKey = key;
        }
      }
      if (bestKey !== null) startProject(state, countryId, cfg, def.id, bestKey, month, () => `t10-${countryId}-${month}`);
    };

    let sawShortage = false;
    for (let month = 0; month < months; month += 1) {
      runEconomyCycle(state, model, cfg, { applyStep: true, month });
      for (const countryId of worldIds) stepProjects(state, model, countryId, cfg, month);
      for (const countryId of worldIds) {
        if (countryId === state.player.countryId) continue;
        aiTradeStep(state, countryId, cfg, month, rng, newId('contract'));
      }
      if (month % 12 === 0) for (const countryId of worldIds) tryAiConstruction(countryId, month);

      // MONTHLY honesty invariants (every 7th month — cheap and exact):
      if (month % 7 === 0) {
        // (a) trade money is conserved: what buyers paid = what sellers got;
        let income = 0;
        let expense = 0;
        let imports = 0;
        let exports = 0;
        for (const countryId of worldIds) {
          const record = state.economy.resources[countryId]!;
          income += record.tradeIncome;
          expense += record.tradeExpense;
          for (const amount of Object.values(record.imports)) imports += amount;
          for (const amount of Object.values(record.exports)) exports += amount;
        }
        expect(roundTo(income, 2)).toBeCloseTo(roundTo(expense, 2), 2);
        expect(imports).toBe(exports); // trade moves units, never creates them
        // (b) every recorded offer is the seller's REMAINING SALE QUOTA —
        // the fixed, buyer-independent sale quantity (never the buyer's
        // need, never the raw whole warehouse).
        for (const resourceId of strategicResourceIds(cfg)) {
          for (const offer of marketOffersOf(state, 'probe-buyer', resourceId, cfg)) {
            expect(offer.amount).toBe(remainingSaleOfferOf(state, offer.countryId, resourceId, cfg));
            // The offer's honest ceiling: the stock spare ABOVE the reserve PLUS
            // this month's production-surplus flow (the demand directive) — it
            // can never promise more than the seller really holds or produces.
            expect(offer.amount).toBeLessThanOrEqual(
              availableSurplusOf(state, offer.countryId, resourceId, cfg) +
                Math.max(0, Math.round((state.economy.resources[offer.countryId]!.production[resourceId] ?? 0) - (state.economy.resources[offer.countryId]!.consumption[resourceId] ?? 0)))
            );
          }
        }
        // (c) no negative stock, no NaN anywhere.
        for (const countryId of worldIds) {
          for (const [resourceId, amount] of Object.entries(state.economy.resources[countryId]!.stock)) {
            expect(Number.isFinite(amount)).toBe(true);
            expect(amount).toBeGreaterThanOrEqual(0);
            void resourceId;
          }
        }
      }
      for (const countryId of worldIds) {
        if (Object.keys(state.economy.resources[countryId]!.shortage).length > 0) sawShortage = true;
      }
    }

    // (d) the market's shape is REAL, never uniform: for every good the
    //     sale quotas differ wildly across sellers (§3's «A → 100,
    //     C → 50, F → 150, H → nothing»), at least one good keeps at least
    //     two countries WITHOUT any real surplus (the oil-poor stay
    //     oil-importers, §17), and no good turned the whole world into
    //     clones offering the same fake number (§1's complaint).
    let goodsWithNonSellers = 0;
    for (const resourceId of strategicResourceIds(cfg)) {
      const offers = worldIds
        .map((id) => remainingSaleOfferOf(state, id, resourceId, cfg))
        .filter((amount) => amount > 0);
      if (offers.length < worldIds.length) goodsWithNonSellers += 1;
      if (offers.length >= 3) {
        expect(new Set(offers).size).toBeGreaterThanOrEqual(2); // heterogeneous
      }
    }
    expect(goodsWithNonSellers).toBeGreaterThanOrEqual(1);

    // (e) no duplicate-contract explosion: the §23 invariant holds EXACTLY —
    //     at most ONE ACTIVE import contract per (country, good) pair — and
    //     the book stays within the theoretical fence (world × goods).
    const seenPairs = new Set<string>();
    for (const contract of activeContracts(state)) {
      const key = `${contract.buyerId}#${contract.resourceId}`;
      expect(seenPairs.has(key)).toBe(false);
      seenPairs.add(key);
    }
    expect(activeContracts(state).length).toBeLessThanOrEqual(
      worldIds.length * strategicResourceIds(cfg).length
    );

    // (f) contracts CONTINUED: the surviving active contracts delivered
    //     recently (their lastDelivery is set by the last execution).
    const active = activeContracts(state);
    expect(active.length).toBeGreaterThan(0);
    const delivering = active.filter((contract) => (contract.lastDelivery ?? 0) > 0).length;
    expect(delivering).toBeGreaterThanOrEqual(Math.floor(active.length / 2));

    // (g) one seller served SEVERAL buyers (§17)…
    const buyersOf = new Map<string, Set<string>>();
    for (const contract of state.economy.contracts ?? []) {
      if (!buyersOf.has(contract.sellerId)) buyersOf.set(contract.sellerId, new Set());
      buyersOf.get(contract.sellerId)!.add(contract.buyerId);
    }
    expect([...buyersOf.values()].some((set) => set.size >= 2)).toBe(true);
    // (h) …and one buyer imported from SEVERAL sellers (§22).
    const sellersOf = new Map<string, Set<string>>();
    for (const contract of state.economy.contracts ?? []) {
      if (!sellersOf.has(contract.buyerId)) sellersOf.set(contract.buyerId, new Set());
      sellersOf.get(contract.buyerId)!.add(contract.sellerId);
    }
    expect([...sellersOf.values()].some((set) => set.size >= 2)).toBe(true);

    // (i) the AI world has REAL shortages (some country ran dry) and REAL
    //     surpluses (some country shows the honest surplus status).
    expect(sawShortage).toBe(true);
    const surplusCountries = worldIds.filter((countryId) =>
      strategicResourceIds(cfg).some(
        (resourceId) =>
          resourceDisplayStatusOf(state.economy.resources[countryId]!, resourceId, cfg.displayStatus) === 'surplus'
      )
    );
    expect(surplusCountries.length).toBeGreaterThan(0);

    // (j) no fake money: no treasury went negative (the execution budget
    //     is capped by the REAL treasury, M13's guarantee, world-scale).
    for (const countryId of worldIds) {
      expect(state.economy.treasury[countryId] ?? 0).toBeGreaterThanOrEqual(0);
    }
    void resourceRank;
    fresh.dispose();
  });

  // ————————— T-Q: سهمیهٔ فروش — مقدار فروش محدود و مستقل از خریدار ————————

  it('Q1 the sale offer is the seller\'s OWN fixed quota — floor(capacity × share), never the buyer\'s demand', () => {
    const state = context.state;
    state.economy.contracts = [];
    const buyerId = ids()[0];
    const sellerId = ids()[1];
    giveSpare(sellerId, 'oil', 1000);
    const share = config().market.saleQuotaShare;
    const quota = Math.floor(1000 * share);
    expect(saleQuotaOf(state, sellerId, 'oil', config())).toBe(quota);
    expect(remainingSaleOfferOf(state, sellerId, 'oil', config())).toBe(quota);
    // The buyer's recorded need NEVER moves the seller's quota (§1/§8) —
    // the sale quantity is computable from the seller alone.
    state.economy.resources[buyerId]!.shortage.oil = 10;
    expect(remainingSaleOfferOf(state, sellerId, 'oil', config())).toBe(quota);
    state.economy.resources[buyerId]!.shortage.oil = 99_999;
    expect(remainingSaleOfferOf(state, sellerId, 'oil', config())).toBe(quota);
    delete state.economy.resources[buyerId]!.shortage.oil;
  });

  it('Q2 demand above the offer cannot exceed it — the quota is a hard cap and the remainder stays with the seller (§5/§6)', () => {
    const state = context.state;
    state.economy.contracts = [];
    const order = ids();
    const sellerId = order[0];
    giveQuota(sellerId, 'oil', 500); // the seller puts up exactly 500/month
    state.economy.treasury[order[1]] = 1_000_000;
    state.economy.treasury[order[2]] = 1_000_000;
    const buyerA = order[1];
    // An 800/month DEMAND is refused outright — nothing may exceed the
    // seller's fixed sale quantity (fail-closed; the UI caps the button at
    // min(want, offer) before this line is ever reached).
    expect(signContract(state, buyerA, sellerId, 'oil', 800, 50, config(), () => 'q2x').ok).toBe(false);
    // Signing the offered 500 (the capped amount) succeeds...
    expect(signContract(state, buyerA, sellerId, 'oil', 500, 50, config(), () => 'q2a').ok).toBe(true);
    // ...the quota is now fully reserved: the next buyer finds nothing.
    expect(remainingSaleOfferOf(state, sellerId, 'oil', config())).toBe(0);
    expect(signContract(state, order[2], sellerId, 'oil', 1, 50, config(), () => 'q2b').ok).toBe(false);
    // Cancelling releases exactly the remainder for later deals (§6).
    expect(cancelContract(state, 'q2a', buyerA, 50)).toBe('ok');
    expect(remainingSaleOfferOf(state, sellerId, 'oil', config())).toBe(500);
  });

  it('Q3 several buyers share ONE seller strictly within its quota (§7/§17)', () => {
    const state = context.state;
    state.economy.contracts = [];
    const order = ids();
    expect(order.length).toBeGreaterThanOrEqual(4);
    const sellerId = order[0];
    giveQuota(sellerId, 'food', 300);
    for (const id of order) state.economy.treasury[id] = 1_000_000;
    // Two buyers split the 300 quota: 200 + 100 — both signed...
    const buyers = order.slice(1, 3);
    expect(signContract(state, buyers[0], sellerId, 'food', 200, 50, config(), () => 'q3a').ok).toBe(true);
    expect(signContract(state, buyers[1], sellerId, 'food', 100, 50, config(), () => 'q3b').ok).toBe(true);
    expect(committedExportUnitsOf(state, sellerId, 'food')).toBe(300);
    // ...a third buyer finds the quota exhausted (a hard cap, no path around).
    expect(signContract(state, order[3], sellerId, 'food', 1, 50, config(), () => 'q3c').ok).toBe(false);
    executeMonthlyContracts(state, order, config(), 51);
    // Each received EXACTLY its share; Σ deliveries = the quota itself.
    expect(state.economy.resources[buyers[0]]!.imports.food ?? 0).toBe(200);
    expect(state.economy.resources[buyers[1]]!.imports.food ?? 0).toBe(100);
    expect(state.economy.resources[sellerId]!.exports.food ?? 0).toBe(300);
  });

  it('Q4 the AI\'s direct construction-materials deal cannot bypass the quota (no other trade path exists)', () => {
    const state = context.state;
    state.economy.contracts = [];
    const order = ids();
    const buyerId = order[0];
    // Exactly ONE seller on the industrial market, with a 60-unit quota:
    // an AI needing far more can only EVER buy the quota — the direct-deal
    // path respects the same sale limit as the contract path.
    for (const other of order.slice(1)) {
      if (other === order[1]) continue;
      state.economy.resources[other]!.stock.industrial =
        safetyReserveUnits(state.economy.resources[other]!.consumption, 'industrial', config());
    }
    const sellerId = order[1];
    giveQuota(sellerId, 'industrial', 60);
    state.economy.treasury[buyerId] = 1_000_000;
    const before = state.economy.resources[sellerId]!.stock.industrial ?? 0;
    const missing = Math.max(0, 200 - Math.floor(state.economy.resources[buyerId]!.stock.industrial ?? 0));
    const secured = aiSecureConstructionMaterials(state, buyerId, config(), 200);
    expect(secured).toBe(missing <= 60); // the quota alone cannot serve a bigger need
    const bought = before - (state.economy.resources[sellerId]!.stock.industrial ?? 0);
    expect(bought).toBe(Math.min(missing, 60)); // exactly the quota — never more
  });
});
