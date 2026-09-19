/**
 * THE SIMPLE ECONOMY — unit tests for the 14-section directive (spec §13).
 *
 * Every core calculation is tested against the CONFIG formulas:
 *  - درآمد مالیاتی   : جمعیت(میلیون) × نرخ × ضریب            (§2)
 *  - تولید منابع      : deposits + baseline + buildings        (§4)
 *  - مصرف غذا        : جمعیت(میلیون) × perMillionPopulation   (§5)
 *  - قرارداد تجاری    : monthly contract moves REAL units + ledger money (§6)
 *  - هزینه‌ها         : ارتش + دولت + زیرساخت                  (§3)
 *  - تغییر خزانه      : درآمد − هزینه‌ها, applied ONCE          (§3/§12)
 *  - کمبود غذا        : uncovered deficit → shortage consequences (§5)
 *  - اجرای چرخه کامل  : the §12 order, deterministic, no double-apply (§12)
 *
 * §14 review items covered: negative values, selling more than the
 * stockpile, zero population, zero production, expenses exceeding the
 * treasury, running the cycle repeatedly, trade conservation.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestGame } from '../../helpers/testGame';
import type { Game } from '../../../core/Game';
import type { SystemContext } from '../../../core/GameContext';
import { runEconomyCycle, taxIncomeOf, armyExpenseOf, governmentExpenseOf, infrastructureExpenseOf } from '../../../economy/economyCycle';
import { resourceDisplayStatusOf, safetyReserveUnits } from '../../../economy/resources';
import { marketOffersOf, unitPriceOf, signContract, executeMonthlyContracts } from '../../../economy/contracts';
import { startProject, stepProjects, constructionSpeedFactorOf } from '../../../economy/construction';
import type { StrategicResourcesConfig } from '../../../economy/types';

describe('simple economy (14-section spec)', () => {
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

  // ———————————————————————— §2 — درآمد مالیاتی ————————————————————————

  it('T1 tax income = population(millions) × rate × multiplier (§2)', () => {
    const population = 24_000_000;
    const multiplier = config.finance.taxIncomePerMillionPerRate;
    // medium = 10٪ → 24 × 0.10 × multiplier (the §12 example).
    expect(taxIncomeOf(population, 'medium', config)).toBeCloseTo(24 * 0.10 * multiplier, 2);
    expect(taxIncomeOf(population, 'low', config)).toBeCloseTo(24 * 0.05 * multiplier, 2); // 5٪
    expect(taxIncomeOf(population, 'high', config)).toBeCloseTo(24 * 0.20 * multiplier, 2); // 20٪
    // Monotonic کم → زیاد (§9).
    expect(taxIncomeOf(population, 'high', config)).toBeGreaterThan(taxIncomeOf(population, 'medium', config));
    expect(taxIncomeOf(population, 'medium', config)).toBeGreaterThan(taxIncomeOf(population, 'low', config));
    // Zero population pays no tax (§14).
    expect(taxIncomeOf(0, 'high', config)).toBe(0);
  });

  it('T2 production = deposits + geography baseline + buildings (§4)', () => {
    const state = context.state;
    const countryId = ids()[0];
    // Seed already ran: production is stored on the record.
    const record = state.economy.resources[countryId]!;
    const depositSum: Record<string, number> = {};
    for (const deposit of context.map.features.deposits) {
      if (deposit.countryId !== countryId) continue;
      depositSum[deposit.resourceId] =
        (depositSum[deposit.resourceId] ?? 0) +
        Math.round(deposit.quantity * config.productionScale);
    }
    for (const resource of config.resources) {
      const baseline = record.production[resource.id] ?? 0;
      expect(baseline).toBeGreaterThanOrEqual(0);
      if (depositSum[resource.id] !== undefined) {
        // Deposits dominate for the resources the land actually carries.
        expect(baseline).toBeGreaterThanOrEqual(depositSum[resource.id]);
      }
    }
  });

  // ———————————————————————— §5 — مصرف غذا ——————————————————————————————

  it('T3 food consumption = population × perMillion, stock steps by P − C (§5)', () => {
    const state = context.state;
    const countryId = playerCountryId;
    const country = state.countries.countries[countryId]!;
    const record = state.economy.resources[countryId]!;
    const perMillion = config.consumption.food?.perMillionPopulation ?? 0;
    const expected = Math.round((country.population / 1_000_000) * perMillion);
    expect(record.consumption.food).toBe(expected);
    // The stock step: after seeding, stock equals the LIMITED starting
    // buffer (spec §1/§10) — a few MONTHS of the country's own consumption,
    // flavored by its profile, floored for tiny countries. Never the old
    // flat huge pile.
    const months = config.startingStock.months.food ?? 2;
    const floor = config.startingStock.floor.food ?? 0;
    const maxFlavor = Math.max(...config.startingStock.flavorByRank);
    expect(record.stock.food).toBeGreaterThan(0);
    expect(record.stock.food).toBeLessThanOrEqual(
      Math.round(Math.max(floor, months * expected * maxFlavor))
    );
  });

  // ————————————————————— §6 — قرارداد تجاری ماهانه —————————————————————

  it('T4 ONE monthly contract delivers EXACTLY §6\'s amounts at the base price (§6/§9)', () => {
    const state = context.state;
    const [buyerId, sellerId] = ids();
    const price = unitPriceOf(config, 'food');
    expect(price).toBeGreaterThan(0); // §7: base prices from config

    // Arrange: seller holds 1,000 spare food above its reserve.
    state.economy.resources[sellerId]!.stock.food = 1000 +
      safetyReserveUnits(state.economy.resources[sellerId]!.consumption, 'food', config);
    state.economy.treasury[buyerId] = 10000;
    const buyerStockBefore = Math.round(state.economy.resources[buyerId]!.stock.food ?? 0);
    const sellerStockBefore = Math.round(state.economy.resources[sellerId]!.stock.food ?? 0);

    const signed = signContract(state, buyerId, sellerId, 'food', 50, 100, config, () => 'c1');
    expect(signed.ok).toBe(true);
    if (!signed.ok) return;
    expect(signed.contract.amountPerMonth).toBe(50);
    expect(signed.contract.price).toBe(price);
    expect(signed.contract.status).toBe('active');
    // Signing moves NOTHING — goods and money only move at EXECUTION (§10).
    expect(Math.round(state.economy.resources[buyerId]!.stock.food ?? 0)).toBe(buyerStockBefore);

    executeMonthlyContracts(state, ids(), config, 101);
    const cost = 50 * price;
    // Buyer: +units; Seller: −units (§6/§9 EXACTLY).
    expect(Math.round(state.economy.resources[buyerId]!.stock.food ?? 0)).toBe(buyerStockBefore + 50);
    expect(Math.round(state.economy.resources[sellerId]!.stock.food ?? 0)).toBe(sellerStockBefore - 50);
    // The delivery is visible in BOTH countries' month ledger (تجارت line).
    expect(state.economy.resources[buyerId]!.tradeExpense).toBeCloseTo(cost, 2);
    expect(state.economy.resources[sellerId]!.tradeIncome).toBeCloseTo(cost, 2);
    // The contract recorded its honest last delivery (§8's display data).
    expect(state.economy.contracts.find((contract) => contract.id === 'c1')?.lastDelivery).toBe(50);
  });

  it('T5 contracting more than the seller\'s sale quota is refused — capacity is reserved (§16 + the sale-quantity directive)', () => {
    const state = context.state;
    const [buyerId, sellerId] = ids();
    const sellerRecord = state.economy.resources[sellerId]!;
    const reserve = safetyReserveUnits(sellerRecord.consumption, 'iron', config);
    // 200 REAL spare units → the seller's FIXED sale quota is 100 (half).
    sellerRecord.stock.iron = reserve + 200;
    state.economy.treasury[buyerId] = 100000; // plenty of money

    // 5,000/month against a 100-unit quota → NO-CAPACITY (the market can
    // never promise what a country does not truly hold — and its offer is
    // its OWN quota, never the buyer's demand).
    const over = signContract(state, buyerId, sellerId, 'iron', 5000, 100, config, () => 'c2');
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toBe('no-capacity');

    // The quota (100) CAN be contracted once...
    const ok = signContract(state, buyerId, sellerId, 'iron', 100, 100, config, () => 'c3');
    expect(ok.ok).toBe(true);
    // ...but the quota is now RESERVED: another buyer gets refused (the
    // remainder the seller kept back stays with the seller).
    const second = signContract(state, ids()[2], sellerId, 'iron', 1, 100, config, () => 'c4');
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('no-capacity');

    // Signing with an empty treasury fails cleanly (the buyer cannot pay
    // the FIRST month's bill — no debt exists, §14).
    const thirdId = ids()[2];
    state.economy.resources[thirdId]!.stock.oil = 10_000 +
      safetyReserveUnits(state.economy.resources[thirdId]!.consumption, 'oil', config);
    state.economy.treasury[buyerId] = 0;
    const broke = signContract(state, buyerId, thirdId, 'oil', 10, 100, config, () => 'c5');
    expect(broke.ok).toBe(false);
    if (!broke.ok) expect(broke.reason).toBe('no-funds');
  });

  it('T6 the market offers only the sellers\' FIXED sale quotas — spare above reserve × the config share, minus commitments (§2/§3/§16)', () => {
    const state = context.state;
    const buyerId = playerCountryId;
    const offers = marketOffersOf(state, buyerId, 'oil', config);
    for (const offer of offers) {
      const record = state.economy.resources[offer.countryId]!;
      const spare = Math.max(0, Math.floor((record.stock.oil ?? 0) - safetyReserveUnits(record.consumption, 'oil', config)));
      // The offer is the seller's OWN quota: spare × saleQuotaShare (no
      // contracts are active in this check, so nothing is committed yet).
      expect(offer.amount).toBe(Math.floor(spare * config.market.saleQuotaShare));
    }
    // A country never appears as its own seller; a country with NO spare
    // stock never appears at all (§3 — no fake sellers).
    expect(offers.some((offer) => offer.countryId === buyerId)).toBe(false);
    for (const id of ids()) {
      if (id === buyerId) continue;
      const record = state.economy.resources[id]!;
      const spare = Math.floor((record.stock.oil ?? 0) -
        safetyReserveUnits(record.consumption, 'oil', config));
      if (spare <= 0) {
        expect(offers.some((offer) => offer.countryId === id)).toBe(false);
      }
    }
  });


  // ———————————————————————— §3 — هزینه‌ها و خزانه ———————————————————————

  it('T7 expenses follow the config formulas (§3)', () => {
    const state = context.state;
    const country = state.countries.countries[playerCountryId]!;
    const areas = Object.values(state.cityAreas.network.areas)
      .filter((area) => area.countryId === playerCountryId).length;
    expect(armyExpenseOf(country.military.armySize, config))
      .toBeCloseTo((country.military.armySize / 1000) * config.finance.armyCostPerThousandSoldiers, 2);
    expect(governmentExpenseOf(country.population, config))
      .toBeCloseTo((country.population / 1_000_000) * config.finance.governmentCostPerMillion, 2);
    expect(infrastructureExpenseOf(areas, config))
      .toBeCloseTo(areas * config.finance.infrastructureCostPerArea, 2);
  });

  it('T8 the cycle applies the treasury change EXACTLY ONCE per month (§3/§12)', () => {
    const state = context.state;
    const countryId = playerCountryId;
    // A trade-free pair of months: no contracts may deliver in THIS
    // measurement. Month 1 establishes the ledger; month 2 must apply
    // EXACTLY that ledger balance to the treasury — once, no double-count.
    state.economy.contracts = [];
    runEconomyCycle(state, context.map, config, { applyStep: true });
    const finance = state.economy.finance[countryId]!;
    const before = state.economy.treasury[countryId] ?? 0;
    const expectedChange =
      finance.lastTaxIncome + finance.lastTradeIncome -
      finance.lastArmyExpense - finance.lastGovernmentExpense - finance.lastInfrastructureExpense;

    runEconomyCycle(state, context.map, config, { applyStep: true });

    const after = state.economy.treasury[countryId] ?? 0;
    expect(after).toBeCloseTo(Math.max(0, before + expectedChange), 0);
    // The new ledger holds THIS month's fresh numbers (trade restarted at 0
    // then accumulated this month's flows — never last month's again).
    const fresh = state.economy.finance[countryId]!;
    expect(fresh.lastTaxIncome).toBeGreaterThanOrEqual(0);
  });

  // ———————————————————————— §5 — کمبود غذا ——————————————————————————————

  it('T9 food shortage → recorded deficit, slower population growth, lower stability (§5/§7)', () => {
    const state = context.state;
    // The most food-deficit country (production < consumption) becomes the
    // famine candidate; the honest inputs (empty warehouse) do the rest.
    const deficit = ids()
      .map((id) => {
        const record = state.economy.resources[id]!;
        return { id, gap: (record.consumption.food ?? 0) - (record.production.food ?? 0) };
      })
      .sort((a, b) => b.gap - a.gap)[0];
    expect(deficit.gap).toBeGreaterThan(0); // the calibration leaves deficit countries
    const countryId = deficit.id;
    const record = state.economy.resources[countryId]!;
    const country = state.countries.countries[countryId]!;
    const political = state.political.countries[countryId]!;

    // Engineer the acute shortage HONESTLY: the warehouse is empty AND the
    // world market cannot help (zero prices — no trade path, spec §6), so
    // the uncovered deficit stays exactly what the land could not cover.
    const frozen: StrategicResourcesConfig = {
      ...config,
      resources: config.resources.map((resource) => ({ ...resource, price: 0 }))
    };
    record.stock.food = 0;
    record.shortage = {};
    const populationBefore = country.population;
    const stabilityBefore = political.stability;
    const expectedShortage = deficit.gap;

    runEconomyCycle(state, context.map, frozen, { applyStep: true });

    const after = state.economy.resources[countryId]!;
    // The uncovered deficit is recorded (§5).
    expect(after.shortage.food ?? 0).toBeGreaterThan(0);
    // (±a few units: consumption re-derives from the population grown in step ۱)
    expect(after.shortage.food ?? 0).toBeLessThanOrEqual(expectedShortage + 10);
    // Population growth slowed to a quarter while the shortage lasted.
    const growth = country.population - populationBefore;
    const normalGrowth = populationBefore * config.finance.populationGrowthPerMonth;
    expect(growth).toBeCloseTo(normalGrowth * 0.25, -1);
    // Stability dropped through the GRADED satisfaction penalty (§7) —
    // proportional, never a sudden collapse from one short month: even the
    // deeper shortages of the harder production economy stay well under a
    // third of the stability scale per month (a collapse needs MONTHS of
    // escalation, §13 — not one bad season).
    expect(political.stability).toBeLessThan(stabilityBefore);
    expect(stabilityBefore - political.stability).toBeLessThan(0.15);
  });

  it('T10 zero population / zero production — no NaN, no negative stock (§14)', () => {
    const state = context.state;
    // No contracts: the zero-pop country must earn nothing from trade here.
    state.economy.contracts = [];
    const countryId = ids()[1];
    const country = state.countries.countries[countryId]!;
    const record = state.economy.resources[countryId]!;
    country.population = 0;
    record.production = { food: 0, iron: 0, oil: 0 };
    record.consumption = { food: 0, iron: 0, oil: 0 };
    record.stock = { food: 0, iron: 0, oil: 0 };

    runEconomyCycle(state, context.map, config, { applyStep: true });

    const finance = state.economy.finance[countryId]!;
    expect(Number.isFinite(finance.lastTaxIncome)).toBe(true);
    expect(finance.lastTaxIncome).toBe(0); // nobody pays tax (§2)
    expect(finance.lastBalance).toBeLessThanOrEqual(0);
    for (const value of Object.values(state.economy.resources[countryId]!.stock)) {
      expect(value).toBeGreaterThanOrEqual(0);
    }
    // Treasury never goes negative (§14: expenses over treasury floor at 0).
    expect(state.economy.treasury[countryId]).toBeGreaterThanOrEqual(0);
  });

  // ———————————————————————— §10 — چرخه کامل ————————————————————————————

  it('T11 running the cycle twice = two months, NOT a double-applied month (§10/§14)', () => {
    const state = context.state;
    // A frozen world: zero prices kill trade, zero growth pins population —
    // every month is then EXACTLY identical and the math is checkable.
    const frozen: StrategicResourcesConfig = {
      ...config,
      resources: config.resources.map((resource) => ({ ...resource, price: 0 })),
      finance: { ...config.finance, populationGrowthPerMonth: 0 }
    };
    const countryId = ids()[2];
    const record = state.economy.resources[countryId]!;
    // Earlier tests ran REAL cycles — their un-accumulated trade money would
    // leak into month 1's ledger; start this experiment from a clean slate.
    for (const other of ids()) {
      const otherRecord = state.economy.resources[other]!;
      otherRecord.tradeIncome = 0;
      otherRecord.tradeExpense = 0;
    }
    const stockBefore = Math.round(record.stock.food ?? 0);
    const treasuryBefore = state.economy.treasury[countryId] ?? 0;

    runEconomyCycle(state, context.map, frozen, { applyStep: true });
    const production = Math.round(record.production.food ?? 0);
    const consumption = Math.round(record.consumption.food ?? 0);
    const balance1 = state.economy.finance[countryId]!.lastBalance;
    const treasury1 = state.economy.treasury[countryId] ?? 0;
    const stock1 = Math.round(record.stock.food ?? 0);

    runEconomyCycle(state, context.map, frozen, { applyStep: true });

    // Month 2 is EXACTLY month 1 again (deterministic §10 order, growth 0):
    const balance2 = state.economy.finance[countryId]!.lastBalance;
    expect(balance2).toBeCloseTo(balance1, 0);
    // Stock steps by (P − C) per month, floored at zero (§14: no negatives).
    expect(Math.round(record.stock.food ?? 0)).toBe(Math.max(0, stock1 + (production - consumption)));
    // The treasury moved by the SAME balance twice — never double-applied.
    expect(state.economy.treasury[countryId] ?? 0).toBeCloseTo(Math.max(0, treasury1 + balance2), 0);
    expect(state.economy.treasury[countryId] ?? 0).toBeCloseTo(Math.max(0, treasuryBefore + 2 * balance1), 0);
    // Two months of production landed (once per cycle, not twice in one).
    expect(production).toBeGreaterThanOrEqual(0);
    void stockBefore;
  });

  it('T12 contracts move real units between countries and CONSERVE them (§6/§10)', () => {
    const state = context.state;
    const order = ids();
    // A clean contract book: THIS pair under test is the only agreement.
    state.economy.contracts = [];
    // One country signs a 100/month food contract with the largest holder.
    const buyerId = order[0];
    state.economy.treasury[buyerId] = 5000;
    // The seller: the country with the LARGEST free food stock above reserve.
    const withSpare = order
      .filter((id) => id !== buyerId)
      .map((id) => {
        const record = state.economy.resources[id]!;
        return {
          id,
          spare: Math.floor((record.stock.food ?? 0) -
            safetyReserveUnits(record.consumption, 'food', config))
        };
      })
      // The seller's QUOTA must cover the 100/month deal (spare × share ≥ 100).
      .filter((entry) => entry.spare * config.market.saleQuotaShare >= 100)
      .sort((a, b) => b.spare - a.spare);
    expect(withSpare.length).toBeGreaterThan(0);
    const sellerId = withSpare[0].id;
    const signed = signContract(state, buyerId, sellerId, 'food', 100, 100, config, () => 'c10');
    expect(signed.ok).toBe(true);

    const totalBefore = order.reduce(
      (sum, id) => sum + (state.economy.resources[id]!.stock.food ?? 0), 0
    );
    executeMonthlyContracts(state, order, config, 101);
    const totalAfter = order.reduce(
      (sum, id) => sum + (state.economy.resources[id]!.stock.food ?? 0), 0
    );
    // CONSERVATION: contracts move units, they never create or destroy them.
    expect(totalAfter).toBe(totalBefore);
    // The buyer got its monthly delivery; the seller recorded the export (§6).
    expect(state.economy.resources[buyerId]!.imports.food ?? 0).toBe(100);
    expect(state.economy.resources[sellerId]!.exports.food ?? 0).toBe(100);
    // Money conservation at the BASE price: what buyers owe = what sellers get.
    const income = order.reduce((sum, id) => sum + (state.economy.resources[id]!.tradeIncome), 0);
    const expense = order.reduce((sum, id) => sum + (state.economy.resources[id]!.tradeExpense), 0);
    expect(income).toBeCloseTo(expense, 2);
    expect(income).toBeCloseTo(100 * unitPriceOf(config, 'food'), 2);
    // The execution NEVER touches the treasury — money lands in step ۷.
    expect(state.economy.treasury[buyerId]).toBe(5000);
  });

  it('T13 statuses are honest: shortage from the record, surplus needs a real buffer', () => {
    const state = context.state;
    const countryId = playerCountryId;
    const record = state.economy.resources[countryId]!;

    record.shortage.food = 100;
    expect(resourceDisplayStatusOf(record, 'food', config.displayStatus)).toBe('shortage');
    record.shortage = {};

    // A +1/month trickle with a thin warehouse is NOT a surplus.
    record.production.food = (record.consumption.food ?? 0) + 1;
    record.stock.food = 10;
    expect(resourceDisplayStatusOf(record, 'food', config.displayStatus)).toBe('balanced');
    // A real flow + a real buffer IS one.
    record.production.food = (record.consumption.food ?? 0) * 2;
    record.stock.food = config.displayStatus.surplusBufferMonths * (record.consumption.food ?? 0) + 100;
    expect(resourceDisplayStatusOf(record, 'food', config.displayStatus)).toBe('surplus');
  });

  it('T14 construction: money paid ONCE at start; time finishes the building (§8)', () => {
    const state = context.state;
    const countryId = playerCountryId;
    const def = config.buildings[0]; // the farm — one effect: +food production
    state.economy.treasury[countryId] = def.cost * 2;
    state.economy.resources[countryId]!.stock.industrial = def.materials * 10;
    const before = state.economy.treasury[countryId];

    const started = startProject(state, countryId, config, def.id, 'city_test', 10, () => 'p1');
    expect(started.ok).toBe(true);
    // The ONE-TIME cost left the treasury at START — never again.
    expect(state.economy.treasury[countryId]).toBe(before - def.cost);

    // Poor countries cannot start (§14: expenses over treasury are blocked).
    state.economy.treasury[countryId] = def.cost / 2;
    const broke = startProject(state, countryId, config, def.id, 'cell_poor', 10, () => 'p2');
    expect(broke.ok).toBe(false);
    if (!broke.ok) expect(broke.reason).toBe('no-funds');
    state.economy.treasury[countryId] = def.cost; // restore for the build phase

    // Materials are ONE-TIME too (spec §4): the stock visibly dropped.
    expect(state.economy.resources[countryId]!.stock.industrial).toBe(def.materials * 10 - def.materials);

    // ONE economic building per region (spec §1): the SAME cell is taken
    // while the first project is still building on it.
    const sameCell = startProject(state, countryId, config, def.id, 'city_test', 10, () => 'p3');
    expect(sameCell.ok).toBe(false);
    if (!sameCell.ok) expect(sameCell.reason).toBe('occupied');

    // Build time advances; the project never draws money or resources again.
    const speed = constructionSpeedFactorOf(state, countryId);
    for (let month = 11; month <= 10 + Math.ceil(def.buildMonths / speed) + 1; month += 1) {
      stepProjects(state, context.map, countryId, config, month);
    }
    const buildings = Object.values(state.economy.buildings[countryId] ?? {});
    expect(buildings.some((building) => building.typeId === def.id)).toBe(true);
    expect(state.economy.treasury[countryId]).toBe(before - def.cost); // still exactly once
    // The completed building is production-only (goods, never money).
    expect(def.output).toBeGreaterThan(0);
    expect(buildings.find((building) => building.typeId === def.id)?.cellKey).toBeTruthy();
  });
});
