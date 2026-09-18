/**
 * The ECONOMIC AI of ONE country (spec §16) — the PURE decision of WHAT to
 * build next; the GovernmentSystem owns WHEN (monthly chance, affordability
 * margin, project cap) and WHERE (a free cell of the country's own land —
 * one economic building per region, spec §1).
 *
 * The priority follows the country's REAL economic state (spec §16 — never
 * random, never filling every region):
 *
 *   ۱. NEED FIRST — the largest UNCOVERED shortage wins (the record's
 *      post-trade deficit: imports were already tried and could not cover
 *      it). A food shortage → مزرعه, an oil shortage → میدان نفتی, iron →
 *      معدن آهن, industrial → کارخانه. Ties resolve by config resource
 *      order (deterministic).
 *   ۲. CLOSE A REAL FLOW GAP where the country is actually GOOD (spec §16's
 *      «مزیت منطقه‌ای»): the strongest good that is (a) not already in
 *      display-surplus, (b) not yet covered with a 10% buffer, and (c) has
 *      real country potential (rank ≤ 1). A building in the country's WEAK
 *      goods yields little (§2/§15) — those needs stay import-fed (§17),
 *      which keeps the world trade-dependent instead of self-sufficient.
 *   ۳. EVERYTHING covered — reinforce the strongest good for export depth
 *      (spec §5/§7) but ONLY while it is below DOUBLE its own consumption:
 *      a deep surplus already feeds world trade as it is. Otherwise null —
 *      a developed economy stops building (§24 S8: self-sufficiency must
 *      stay the exception, never the grind).
 *
 * Leaf module: state types + config only. Unit-testable without a system.
 */

import type { GameState } from '../state/GameState';
import type { StrategicMapModel } from '../world/map/MapTypes';
import type { StrategicResourcesConfig } from './types';
import { resourceDisplayStatusOf, safetyReserveUnits } from './resources';
import { countryPotentialFactor } from './quality';
import { roundTo } from '../utils/math';

/** The COVERAGE target of step ۲ (production ≥ consumption × THIS → built). */
const COVERAGE_TARGET = 1.1;
/** The export-depth ceiling of step ۳ (production ≥ consumption × THIS → stop). */
const EXPORT_DEPTH_CAP = 2.0;

/**
 * Secures a country's CONSTRUCTION MATERIALS on the world market (spec §16
 * — «از بازار جهانی وارد کند»): the missing industrial-goods units are
 * BOUGHT from the largest real seller at the base price, exactly like the
 * manual deal (real units + real money move; a country with no money or no
 * seller secures nothing). TRUE when the full amount is in stock after the
 * purchase. This is what keeps material-poor countries able to build —
 * their import bill is the honest price of construction.
 */
export function aiSecureConstructionMaterials(
  state: GameState,
  countryId: string,
  config: StrategicResourcesConfig,
  neededUnits: number
): boolean {
  const record = state.economy.resources[countryId];
  if (record === undefined) return false;
  const missing = Math.ceil(neededUnits - (record.stock.industrial ?? 0));
  if (missing <= 0) return true;
  const price = config.resources.find((resource) => resource.id === 'industrial')?.price ?? 0;
  if (price <= 0) return false;
  // The sellers of industrial goods, largest free stock first (§6/§18).
  const sellers: { countryId: string; amount: number }[] = [];
  for (const [sellerId, sellerRecord] of Object.entries(state.economy.resources)) {
    if (sellerId === countryId) continue;
    const free = Math.floor((sellerRecord.stock.industrial ?? 0) -
      safetyReserveUnits(sellerRecord.consumption, 'industrial', config));
    if (free > 0) sellers.push({ countryId: sellerId, amount: free });
  }
  sellers.sort((a, b) => b.amount - a.amount || (a.countryId < b.countryId ? -1 : 1));
  let stillMissing = missing;
  for (const seller of sellers) {
    if (stillMissing <= 0) break;
    const treasury = Math.max(0, state.economy.treasury[countryId] ?? 0);
    const affordable = Math.floor(treasury / price);
    const amount = Math.max(0, Math.min(stillMissing, seller.amount, affordable));
    if (amount <= 0) continue;
    const sellerRecord = state.economy.resources[seller.countryId]!;
    const cost = roundTo(amount * price, 2);
    // REAL units + REAL money move (the §6 deal).
    sellerRecord.stock.industrial = Math.round((sellerRecord.stock.industrial ?? 0) - amount);
    record.stock.industrial = Math.round((record.stock.industrial ?? 0) + amount);
    state.economy.treasury[countryId] = roundTo((state.economy.treasury[countryId] ?? 0) - cost, 4);
    state.economy.treasury[seller.countryId] = roundTo((state.economy.treasury[seller.countryId] ?? 0) + cost, 4);
    record.imports.industrial = Math.round((record.imports.industrial ?? 0) + amount);
    sellerRecord.exports.industrial = Math.round((sellerRecord.exports.industrial ?? 0) + amount);
    record.tradeExpense = roundTo(record.tradeExpense + cost, 2);
    sellerRecord.tradeIncome = roundTo(sellerRecord.tradeIncome + cost, 2);
    stillMissing -= amount;
  }
  return stillMissing <= 0;
}

/**
 * The building type id the country should build next (null when the state
 * or the config gives nothing to build on — the caller simply skips).
 */
export function aiBuildingTypeId(
  state: GameState,
  model: StrategicMapModel,
  countryId: string,
  config: StrategicResourcesConfig
): string | null {
  const record = state.economy.resources[countryId];
  if (record === undefined) return null;

  // ۱. NEED (spec §16: کمبود → اولویت ساخت سازندهٔ همان کالا) — the largest
  //    uncovered deficit across the config's resources.
  let neededResource: string | null = null;
  let worst = 0;
  for (const resource of config.resources) {
    const uncovered = record.shortage[resource.id] ?? 0;
    if (uncovered > worst) {
      worst = uncovered;
      neededResource = resource.id;
    }
  }
  if (neededResource !== null) {
    const needDef = config.buildings.find((candidate) => candidate.resource === neededResource);
    if (needDef !== undefined) return needDef.id;
  }

  // ۲. CLOSE A REAL FLOW GAP with a REGIONAL ADVANTAGE (spec §16 priority ۳):
  //    the strongest good that is not in surplus, not yet covered with the
  //    10% buffer, and where the country's potential makes building sensible.
  //    Deterministic: ties resolve by config resource order.
  let bestResource: string | null = null;
  let bestAmount = -1;
  for (const resource of config.resources) {
    const amount = record.production[resource.id] ?? 0;
    if (amount <= bestAmount) continue;
    if (resourceDisplayStatusOf(record, resource.id, config.displayStatus) === 'surplus') continue;
    // A covered flow needs no capacity (a 10% buffer is the target).
    const consumption = record.consumption[resource.id] ?? 0;
    if (consumption > 0 && amount >= consumption * COVERAGE_TARGET) continue;
    // Weak goods stay import-fed: a low-potential building yields little
    // (§2/§15) and would waste the country's scarce money + materials.
    if (countryPotentialFactor(model, countryId, resource.id, config) < 1) continue;
    bestAmount = amount;
    bestResource = resource.id;
  }
  if (bestResource !== null) {
    const bestDef = config.buildings.find((candidate) => candidate.resource === bestResource);
    if (bestDef !== undefined) return bestDef.id;
  }

  // ۳. EVERY good covered — reinforce the strongest for EXPORT DEPTH (spec
  //    §5) ONLY while it stays below double its consumption. A deep surplus
  //    already feeds world trade (§17); stacking more of the same would
  //    grind toward effortless self-sufficiency (§24 S8's prohibition).
  let strongest: string | null = null;
  let strongestOutput = 0;
  for (const [resourceId, amount] of Object.entries(record.production)) {
    if (amount > strongestOutput) {
      strongestOutput = amount;
      strongest = resourceId;
    }
  }
  if (strongest === null) return null;
  const ownConsumption = record.consumption[strongest] ?? 0;
  if (ownConsumption > 0 && strongestOutput >= EXPORT_DEPTH_CAP * ownConsumption) return null;
  return config.buildings.find((candidate) => candidate.resource === strongest)?.id ?? null;
}
