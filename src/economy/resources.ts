/**
 * Strategic resource economy — REAL stockpiles, mines with levels, factories.
 *
 * THE causal chain (per directive §17/§20 — the core loop):
 *
 *   Mines (geographic deposits, level-multiplied) + Domestic baseline +
 *   Production factories          ← the country's monthly PRODUCTION
 *     ↓
 *   Consumption  (population · military upkeep · factory upkeep)
 *     ↓
 *   Global Trade Network (any surplus country ↔ any shortage country)
 *     ↓
 *   STOCK STEP  (stock += production + imports − consumption − exports)
 *     ↓
 *   Emergency FOOD safety pass  (deficits buy from world stockpiles — §8)
 *     ↓
 *   Construction & military production draw the stockpile directly
 *     ↓
 *   Shortage → the player buys explicitly (command) → construction continues
 *
 * recomputeResourceEconomies is the ONE mutation path of the GLOBAL trade
 * network: it recomputes every country's production/consumption from the
 * LIVE map model + game state, resolves the world market for ALL countries
 * at once, applies the monthly STOCK STEP (monthly call only) and the food
 * safety pass, then writes state.economy.resources. It runs at state
 * creation, after every load (heal — seeding only, no step) and ONCE per
 * campaign month (from the GovernmentSystem).
 *
 * Anti-famine guarantees (spec §8): deposits are PERMANENT capacity (never
 * depleted), mine upgrades and factories raise production, the food buffer
 * moves real stock between countries, and consumption is smooth (no random
 * shocks) — shortages can happen, automatic world famine cannot.
 *
 * LEAF-friendly: depends only on state/map TYPES + utils. No renderer, no UI.
 */

import type { GameState } from '../state/GameState';
import type { StrategicMapModel, MapResourceDeposit } from '../world/map/MapTypes';
import type { StrategicResourcesConfig } from './types';
import { liveUnits } from '../state/slices/militarySlice';
import { roundTo } from '../utils/math';
import {
  type CountryResourceState,
  type ResourceStatus
} from './resourceTypes';
import { countryBaselineProduction } from './domesticBaseline';
import { resolveWorldTradeForResource } from './tradeNetwork';

// Record shapes live in the LEAF types module (state imports them without
// reaching this logic — keeps GameState → economySlice → resourceTypes
// acyclic). Public surface is unchanged: they are re-exported here.
export { emptyCountryResourceState } from './resourceTypes';
export type { CountryResourceState, ResourceStatus } from './resourceTypes';

/** Tolerance for floating-point balance comparisons (units are ~1e-2). */
const EPSILON = 1e-6;

/** The ids of the strategic resources in canonical (config) order. */
export function strategicResourceIds(config: StrategicResourcesConfig): string[] {
  return config.resources.map((resource) => resource.id);
}

/** Production multiplier of ONE mine level (config-driven, 1 → 1.0 …). */
export function mineLevelMultiplier(config: StrategicResourcesConfig, level: number): number {
  return config.mineLevels.multipliers[String(level)] ?? 1;
}

/** The stored level of ONE mine (deposit) — absent = level 1. */
export function mineLevelOf(state: GameState, depositId: string): number {
  return state.economy.mines[depositId] ?? 1;
}

// ———————————————————————— production: deposits → cities → country ————————————————

/** Deposit attribution result: cityId → resourceId → monthly production. */
export type CityProductionMap = Record<string, Record<string, number>>;

interface DepositAttribution {
  readonly cityId: string;
  readonly deposit: MapResourceDeposit;
}

/**
 * Attributes EVERY deposit to EXACTLY ONE city of the SAME country:
 * nearest city of the host province (deterministic tie → city id); when the
 * province has no cities, the nearest city anywhere in the country. The map
 * model is the single source — cities lost/changed automatically reshuffle
 * the attribution on the next recompute.
 */
export function attributeDeposits(model: StrategicMapModel): DepositAttribution[] {
  const attributions: DepositAttribution[] = [];
  const citiesByProvince = new Map<string, string[]>();
  for (const province of Object.values(model.provinces)) {
    citiesByProvince.set(province.id, [...province.cityIds].sort());
  }

  const nearest = (cityIds: readonly string[], deposit: MapResourceDeposit): string | null => {
    let bestId: string | null = null;
    let bestDistance = Infinity;
    for (const cityId of cityIds) {
      const city = model.cities[cityId];
      if (city === undefined) continue;
      const distance = Math.hypot(
        city.position.x - deposit.position.x,
        city.position.z - deposit.position.z
      );
      if (distance < bestDistance - EPSILON || (Math.abs(distance - bestDistance) <= EPSILON && cityId < (bestId ?? ''))) {
        bestDistance = distance;
        bestId = cityId;
      }
    }
    return bestId;
  };

  const depositsByProvince = new Map<string, MapResourceDeposit[]>();
  for (const deposit of model.features.deposits) {
    const bucket = depositsByProvince.get(deposit.provinceId);
    if (bucket !== undefined) bucket.push(deposit);
    else depositsByProvince.set(deposit.provinceId, [deposit]);
  }

  for (const [provinceId, deposits] of depositsByProvince) {
    const province = model.provinces[provinceId];
    if (province === undefined) continue; // stale geometry — never attribute cross-country
    const provincialCities = citiesByProvince.get(provinceId) ?? [];
    for (const deposit of deposits) {
      let cityId = nearest(provincialCities, deposit);
      if (cityId === null) {
        // Province without cities → nearest city of the SAME country.
        const country = model.countries[deposit.countryId];
        const countryCities = country !== undefined
          ? [...country.cityIds].sort()
          : [];
        cityId = nearest(countryCities, deposit);
      }
      if (cityId !== null) attributions.push({ cityId, deposit });
    }
  }
  return attributions;
}

/**
 * Monthly production of ONE deposit: quantity × productionScale × the
 * mine's LEVEL multiplier (spec §12/§13 — a level-2 mine really produces
 * 1.5×; the effect is real, not a label). Quantities are WHOLE units.
 */
export function depositMonthlyProduction(
  deposit: MapResourceDeposit,
  config: StrategicResourcesConfig,
  level: number
): number {
  return Math.round(deposit.quantity * config.productionScale * mineLevelMultiplier(config, level));
}

/** Monthly production of ONE city from its attributed deposits.
 *  Quantities are WHOLE units (spec §3's simple math: what the UI shows is
 *  exactly what the simulation stores — no fraction puzzles). */
export function cityResourceProduction(
  model: StrategicMapModel,
  cityId: string,
  config: StrategicResourcesConfig,
  attributions?: DepositAttribution[],
  mineLevels?: Record<string, number>
): Record<string, number> {
  const production: Record<string, number> = {};
  for (const { cityId: owner, deposit } of attributions ?? attributeDeposits(model)) {
    if (owner !== cityId) continue;
    const level = mineLevels?.[deposit.id] ?? 1;
    const amount = depositMonthlyProduction(deposit, config, level);
    production[deposit.resourceId] = (production[deposit.resourceId] ?? 0) + amount;
  }
  return production;
}

/** Monthly production of ONE country (Σ over its cities' attributed deposits). */
export function countryResourceProduction(
  model: StrategicMapModel,
  countryId: string,
  config: StrategicResourcesConfig,
  cache?: Map<string, Record<string, number>>,
  mineLevels?: Record<string, number>
): Record<string, number> {
  const cached = cache?.get(countryId);
  if (cached !== undefined) return cached;
  const production: Record<string, number> = {};
  for (const { cityId, deposit } of attributeDeposits(model)) {
    const city = model.cities[cityId];
    if (city === undefined || city.countryId !== countryId) continue;
    const level = mineLevels?.[deposit.id] ?? 1;
    const amount = depositMonthlyProduction(deposit, config, level);
    production[deposit.resourceId] = (production[deposit.resourceId] ?? 0) + amount;
  }
  cache?.set(countryId, production);
  return production;
}

/** Monthly output added by the country's COMPLETED production factories. */
export function countryPlantOutput(
  state: GameState,
  countryId: string,
  config: StrategicResourcesConfig
): Record<string, number> {
  const output: Record<string, number> = {};
  const plants = state.economy.plants[countryId];
  if (plants === undefined) return output;
  for (const plant of Object.values(plants)) {
    const def = config.productionFactories.find((candidate) => candidate.id === plant.typeId);
    if (def === undefined) continue;
    output[def.boosts] = (output[def.boosts] ?? 0) + def.output;
  }
  return output;
}

// ———————————————————————— consumption: population × military × plants ————————————————

/**
 * Monthly consumption of ONE country, derived from LIVE state (spec §9 —
 * every unit has a clear reason):
 *  - population eats food, uses wood, draws iron/coal/copper/oil;
 *  - military units burn oil and wear iron (upkeep);
 *  - production factories consume their upkeep materials.
 */
export function countryResourceConsumption(
  state: GameState,
  countryId: string,
  config: StrategicResourcesConfig
): Record<string, number> {
  const consumption: Record<string, number> = {};
  const population = state.countries.countries[countryId]?.population ?? 0;
  const units = liveUnits(state.military).filter((unit) => unit.countryId === countryId).length;

  for (const resource of config.resources) {
    const def = config.consumption[resource.id];
    if (def === undefined) continue;
    let amount = 0;
    if (def.perMillionPopulation !== undefined) {
      amount += (population / 1_000_000) * def.perMillionPopulation;
    }
    if (def.perMilitaryUnit !== undefined) {
      amount += units * def.perMilitaryUnit;
    }
    if (amount > 0) consumption[resource.id] = Math.round(amount);
  }

  // Factory upkeep: a small living demand that keeps the resource loop moving.
  const plants = state.economy.plants[countryId];
  if (plants !== undefined) {
    for (const plant of Object.values(plants)) {
      const def = config.productionFactories.find((candidate) => candidate.id === plant.typeId);
      if (def === undefined) continue;
      for (const [resourceId, amount] of Object.entries(def.upkeep)) {
        consumption[resourceId] = Math.round((consumption[resourceId] ?? 0) + amount);
      }
    }
  }
  return consumption;
}

// ———————————————————————— world market: import/export resolution ————————————————

/**
 * Derives the clear status of ONE resource from the computed record.
 * shortage → (fully covered by imports) imported; surplus sold → exported.
 */
export function resourceStatusOf(record: CountryResourceState, resourceId: string): ResourceStatus {
  const production = record.production[resourceId] ?? 0;
  const consumption = record.consumption[resourceId] ?? 0;
  const imports = record.imports[resourceId] ?? 0;
  const exports = record.exports[resourceId] ?? 0;
  if (consumption > production + EPSILON) {
    const deficit = consumption - production;
    return imports >= deficit - 1e-4 ? 'imported' : 'shortage';
  }
  if (production > consumption + EPSILON) {
    return exports > EPSILON ? 'exported' : 'surplus';
  }
  return 'balanced';
}

/**
 * The SAFETY RESERVE of ONE resource for ONE country (spec §8/§11): months
 * of consumption the country keeps out of exports — food its own (larger)
 * buffer, every other resource `reserveMonths`. THE shared definition used
 * by the world matcher's export offers AND the manual seller list.
 */
export function safetyReserveUnits(
  record: Pick<CountryResourceState, 'consumption'>,
  resourceId: string,
  config: StrategicResourcesConfig
): number {
  const consumption = record.consumption[resourceId] ?? 0;
  const months = resourceId === 'food'
    ? config.safetyBuffer.foodMonths
    : config.safetyBuffer.reserveMonths;
  return Math.ceil(months * consumption);
}

/** Net monthly balance of ONE resource (production + imports − consumption − exports). */
export function resourceBalanceOf(record: CountryResourceState, resourceId: string): number {
  return roundTo(
    (record.production[resourceId] ?? 0) +
      (record.imports[resourceId] ?? 0) -
      (record.consumption[resourceId] ?? 0) -
      (record.exports[resourceId] ?? 0),
    2
  );
}

/**
 * RAW monthly balance of ONE resource — the number the Economy page shows:
 *
 *   Balance = Production − Consumption
 *
 * Trade NEVER distorts it (production 14, consumption 29 → −15 even while
 * 15/month are imported — 14 + 15 − 29 = 0 is the POST-trade state, which
 * is expressed by the STATUS, not by this number).
 */
export function resourceRawBalanceOf(record: CountryResourceState, resourceId: string): number {
  return roundTo(
    (record.production[resourceId] ?? 0) - (record.consumption[resourceId] ?? 0),
    2
  );
}

/** The THREE user-facing statuses (spec: Surplus / Balanced / Shortage). */
export type ResourceDisplayStatus = 'surplus' | 'balanced' | 'shortage';

/** Defaults of the display-status thresholds (mirrors economy.json). */
const DEFAULT_DISPLAY_STATUS = { surplusBufferMonths: 2, minSurplusShare: 0.1 } as const;

/**
 * Derives the clear display status of ONE resource from the REAL numbers —
 * never hand-set, recomputed with every recompute pass (spec §2/§10:
 * statuses must not mislead):
 *
 *  - SHORTAGE — production + import contracts cannot cover consumption and
 *    the stockpile can no longer absorb the gap (realShortageOf > 0);
 *  - SURPLUS — production really exceeds consumption by a MEANINGFUL flow
 *    (≥ max(1, minSurplusShare × consumption): a +1/month is NOT a surplus)
 *    AND the country holds enough stock to cover its domestic consumption
 *    (≥ surplusBufferMonths × consumption) — only then is it a real
 *    exporter with export capacity;
 *  - BALANCED — everything else (needs covered, or a trivial net flow the
 *    country keeps at home).
 */
export function resourceDisplayStatusOf(
  record: CountryResourceState,
  resourceId: string,
  thresholds: { surplusBufferMonths: number; minSurplusShare: number } = DEFAULT_DISPLAY_STATUS
): ResourceDisplayStatus {
  const production = record.production[resourceId] ?? 0;
  const consumption = record.consumption[resourceId] ?? 0;
  const stock = record.stock[resourceId] ?? 0;
  if (realShortageOf(record, resourceId) > 0) return 'shortage';
  const net = production - consumption;
  const minFlow = Math.max(1, Math.ceil(thresholds.minSurplusShare * consumption));
  const bufferUnits = thresholds.surplusBufferMonths * consumption;
  if (net >= minFlow && stock >= bufferUnits) return 'surplus';
  return 'balanced';
}

/**
 * TRUE shortage of ONE resource: the monthly deficit that production AND
 * import contracts cannot cover (spec §2) MINUS what the stockpile can
 * still absorb. Zero while the warehouse covers the gap (a draw-down, not
 * an emergency) — positive when the player/AI must actually buy or the
 * country runs dry. This is THE number the shortage status, the economy
 * card and the protest model all read.
 */
export function realShortageOf(record: CountryResourceState, resourceId: string): number {
  const gap = (record.consumption[resourceId] ?? 0) -
    (record.production[resourceId] ?? 0) -
    (record.imports[resourceId] ?? 0);
  if (gap <= 0) return 0;
  return Math.max(0, Math.round(gap - (record.stock[resourceId] ?? 0)));
}

export interface RecomputeOptions {
  /**
   * TRUE on the MONTHLY pass: applies the stock step (+ the emergency food
   * safety pass). FALSE at state creation / load heal — those only SEED the
   * stockpiles and compute flows (a heal must not double-apply a month).
   */
  readonly applyStockStep?: boolean;
}

/**
 * THE single recompute path of the GLOBAL TRADE NETWORK (and the monthly
 * stock step + food safety pass).
 *
 * Pipeline (spec §7 world level, §8 anti-famine, §17 the core loop):
 *   production (mines × levels + baseline + factories) for EVERY country
 *     → consumption (population/military/factory upkeep) for EVERY country
 *     → surplus/shortage per country and resource
 *     → the world matcher connects exporters with importers (ANY two
 *       countries with a real surplus and a real shortage — player or not)
 *     → trade transactions (imports = actually bought, exports = actually
 *       sold — an unmatched surplus stays export POTENTIAL, never fake
 *       income)
 *     → monthly STOCK STEP (stock += P + I − C − E; floored at 0)
 *     → emergency FOOD pass: remaining food deficits buy from other
 *       countries' STOCKPILES above the safety reserve (money moves
 *       immediately; spec §8.و/§8.ح — buffers travel, famine does not).
 *
 * Deterministic: largest surplus serves first, most urgent shortage buys
 * first, ties → country id. Billing uses the GLOBAL market price tier.
 */
export function recomputeResourceEconomies(
  state: GameState,
  mapModel: StrategicMapModel,
  config: StrategicResourcesConfig,
  options: RecomputeOptions = {}
): void {
  const countryIds = Object.keys(state.government.countries).filter(
    (countryId) => state.economy.resources[countryId] !== undefined ||
      state.economy.finance[countryId] !== undefined ||
      mapModel.countries[countryId] !== undefined
  );
  const canonicalOrder = mapModel.countryOrder.filter((countryId) => countryIds.includes(countryId));
  // Countries present in state but unknown to the map (stale records) keep a
  // zeroed record — they produce and consume nothing.
  const extraIds = countryIds.filter((countryId) => !canonicalOrder.includes(countryId));
  const order = [...canonicalOrder, ...extraIds].sort((a, b) => {
    const indexA = canonicalOrder.indexOf(a);
    const indexB = canonicalOrder.indexOf(b);
    return (indexA === -1 ? canonicalOrder.length : indexA) - (indexB === -1 ? canonicalOrder.length : indexB);
  });

  // —— pass 1: production + consumption from live data ——
  // Production = level-multiplied mines + the geography-driven domestic
  // baseline (farms/forests/capacity, spec §3) + completed factories.
  const productionCache = new Map<string, Record<string, number>>();
  const computed = new Map<string, { production: Record<string, number>; consumption: Record<string, number> }>();
  for (const countryId of order) {
    const mineLevels = state.economy.mines;
    const deposits = countryResourceProduction(mapModel, countryId, config, productionCache, mineLevels);
    const baseline = countryBaselineProduction(mapModel, countryId, config.domesticBaseline);
    const plantOutput = countryPlantOutput(state, countryId, config);
    // The tax level's compounding growth multiplier applies to the baseline
    // + factory output (LOW grows the economy, MAX shrinks it — real state).
    const growth = Math.min(2, Math.max(0.5, state.economy.finance[countryId]?.outputGrowth ?? 1));
    const production: Record<string, number> = { ...deposits };
    for (const [resourceId, amount] of Object.entries(baseline)) {
      production[resourceId] = Math.round((production[resourceId] ?? 0) + amount * growth);
    }
    for (const [resourceId, amount] of Object.entries(plantOutput)) {
      production[resourceId] = Math.round((production[resourceId] ?? 0) + amount * growth);
    }
    computed.set(countryId, {
      production,
      consumption: countryResourceConsumption(state, countryId, config)
    });
  }

  // —— pass 2: the GLOBAL trade market, resource by resource ——
  const productionByCountry: Record<string, Record<string, number>> = {};
  const consumptionByCountry: Record<string, Record<string, number>> = {};
  for (const countryId of order) {
    const record = computed.get(countryId)!;
    productionByCountry[countryId] = record.production;
    consumptionByCountry[countryId] = record.consumption;
  }

  // Export OFFERS (spec §10/§11): a country offers only its net surplus
  // CAPPED by what its free stockpile can spare above the safety reserve —
  // a +1/month trickle with an empty warehouse is NOT an export, and a
  // country short of a resource for its own consumption never exports it.
  const offersByResource: Record<string, Record<string, number>> = {};
  for (const resourceId of strategicResourceIds(config)) {
    const offers: Record<string, number> = {};
    for (const countryId of order) {
      const net =
        (productionByCountry[countryId][resourceId] ?? 0) -
        (consumptionByCountry[countryId][resourceId] ?? 0);
      if (net <= 0) continue;
      // The CURRENT free stock — on the very first pass (no records yet)
      // the seeded starting buffer is what the country holds.
      const stockNow = Math.floor(
        state.economy.resources[countryId]?.stock[resourceId] ??
          config.startingStock[resourceId] ??
          0
      );
      const reserve = safetyReserveUnits(
        { consumption: consumptionByCountry[countryId] },
        resourceId,
        config
      );
      // End-of-month stock after this month's net flow must stay ≥ reserve.
      const headroom = stockNow + net - reserve;
      offers[countryId] = Math.max(0, Math.min(net, Math.floor(headroom)));
    }
    offersByResource[resourceId] = offers;
  }

  const priceOf = new Map<string, number>(config.resources.map((resource) => [resource.id, resource.price]));
  const resolved = new Map<string, ReturnType<typeof resolveWorldTradeForResource>>();
  for (const resourceId of strategicResourceIds(config)) {
    resolved.set(
      resourceId,
      resolveWorldTradeForResource(
        order,
        productionByCountry,
        consumptionByCountry,
        resourceId,
        offersByResource[resourceId]
      )
    );
  }

  // —— pass 3: write records — imports/exports are the ACTUAL trade flows ——
  // Billing: buyers pay the market tier's supply factor over the base price
  // (+ transport markup), sellers receive the tier's demand factor.
  for (const countryId of order) {
    const { production, consumption } = computed.get(countryId)!;
    const imports: Record<string, number> = {};
    const exports: Record<string, number> = {};
    const suppliers: Record<string, Record<string, number>> = {};
    const unfilledShortage: Record<string, number> = {};
    const emergencyImports: Record<string, number> = {};
    let importCost = 0;
    let exportIncome = 0;
    for (const resourceId of strategicResourceIds(config)) {
      const result = resolved.get(resourceId)!;
      const price = priceOf.get(resourceId) ?? 0;
      const tier = result.marketTier;
      const bought = result.importsByBuyer[countryId] ?? 0;
      const sold = result.exportsBySeller[countryId] ?? 0;
      if (bought > 0) {
        imports[resourceId] = bought;
        importCost += bought * price * config.importMarkup * config.priceTiers.supply[tier];
      }
      if (sold > 0) {
        exports[resourceId] = sold;
        exportIncome += sold * price * config.priceTiers.demand[tier];
      }
      const partnerFlows = result.flows.filter(
        (flow) => flow.buyerId === countryId && flow.amount > 0
      );
      if (partnerFlows.length > 0) {
        const bySeller: Record<string, number> = {};
        for (const flow of partnerFlows) bySeller[flow.sellerId] = flow.amount;
        suppliers[resourceId] = bySeller;
      }
      const unfilled = result.unfilledByBuyer[countryId] ?? 0;
      if (unfilled > 0) unfilledShortage[resourceId] = unfilled;
    }

    // —— the monthly STOCK STEP (spec §17: stockpile is the hub) ——
    const previous = state.economy.resources[countryId];
    const stock: Record<string, number> = { ...(previous?.stock ?? {}) };
    const allResourceIds = new Set<string>([
      ...strategicResourceIds(config),
      ...Object.keys(stock)
    ]);
    for (const resourceId of allResourceIds) {
      if (stock[resourceId] === undefined) {
        // Seed: every country starts the campaign with the configured buffer.
        stock[resourceId] = Math.round(config.startingStock[resourceId] ?? 0);
      }
      if (options.applyStockStep === true) {
        const net =
          (production[resourceId] ?? 0) +
          (imports[resourceId] ?? 0) -
          (consumption[resourceId] ?? 0) -
          (exports[resourceId] ?? 0);
        stock[resourceId] = Math.max(0, Math.round(stock[resourceId] + net));
      }
    }

    state.economy.resources[countryId] = {
      stock,
      production,
      consumption,
      imports,
      exports,
      suppliers,
      unfilledShortage,
      emergencyImports,
      importCost: roundTo(importCost, 2),
      exportIncome: roundTo(exportIncome, 2)
    };
  }

  // —— pass 4: the emergency FOOD safety pass (spec §8.ز/§8.ح) ——
  // When the monthly flows could not cover every food deficit, countries
  // with stock ABOVE the safety reserve sell the excess directly — real
  // stock moves, real money moves, and a temporary deficit never becomes a
  // famine. Only stock above the reserve is ever taken.
  if (options.applyStockStep === true) {
    const foodMonths = Math.max(0, config.safetyBuffer.foodMonths);
    const deficitIds = order.filter(
      (countryId) => (state.economy.resources[countryId]?.unfilledShortage.food ?? 0) > 0
    );
    if (foodMonths > 0 && deficitIds.length > 0) {
      const foodPrice = priceOf.get('food') ?? 0;
      const reserveOf = (countryId: string): number =>
        foodMonths * Math.max(1, state.economy.resources[countryId]?.consumption.food ?? 1);
      const sellers = order
        .map((countryId) => {
          const stock = state.economy.resources[countryId]?.stock.food ?? 0;
          return { countryId, spare: Math.floor(stock - reserveOf(countryId)) };
        })
        .filter((entry) => entry.spare > 0)
        .sort((a, b) => b.spare - a.spare || (a.countryId < b.countryId ? -1 : 1));
      const tier = resolved.get('food')?.marketTier ?? 'medium';
      for (const buyerId of deficitIds) {
        let needed = Math.ceil(state.economy.resources[buyerId]?.unfilledShortage.food ?? 0);
        for (const seller of sellers) {
          if (needed <= 0) break;
          if (seller.countryId === buyerId) continue;
          const sellerStock = state.economy.resources[seller.countryId]?.stock.food ?? 0;
          const spare = Math.min(seller.spare, Math.floor(sellerStock - reserveOf(seller.countryId)));
          if (spare <= 0) continue;
          const amount = Math.min(spare, needed);
          state.economy.resources[seller.countryId]!.stock.food = sellerStock - amount;
          state.economy.resources[buyerId]!.stock.food =
            (state.economy.resources[buyerId]!.stock.food ?? 0) + amount;
          state.economy.resources[buyerId]!.emergencyImports.food =
            (state.economy.resources[buyerId]!.emergencyImports.food ?? 0) + amount;
          // Real money moves immediately (never double-billed by the ledger):
          // the buyer pays the import price, the seller receives the sale.
          const pay = roundTo(amount * foodPrice * config.importMarkup * config.priceTiers.supply[tier], 2);
          const receive = roundTo(amount * foodPrice * config.priceTiers.demand[tier], 2);
          state.economy.treasury[buyerId] = roundTo((state.economy.treasury[buyerId] ?? 0) - pay, 4);
          state.economy.treasury[seller.countryId] = roundTo(
            (state.economy.treasury[seller.countryId] ?? 0) + receive, 4
          );
          seller.spare -= amount;
          needed -= amount;
        }
      }
    }
  }
}
