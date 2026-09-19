/**
 * The ECONOMIC AI of ONE country (spec §16) — the PURE decisions of WHAT
 * to BUILD next and WHICH TRADE CONTRACTS to sign or drop; the
 * GovernmentSystem owns WHEN (monthly chances, affordability margins,
 * project caps) and WHERE (a free cell of the country's own land — one
 * economic building per region, spec §1).
 *
 * The priorities follow the country's REAL economic state (spec §16 — never
 * random, never filling every region):
 *
 *   ۱. NEED FIRST — the largest UNCOVERED shortage wins (the record's
 *      honest deficit: contract deliveries were already tried and could
 *      not cover it). A food shortage → مزرعه, an oil shortage → میدان
 *      نفتی, iron → معدن آهن, industrial → کارخانه. Ties resolve by config
 *      resource order (deterministic).
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
 * The TRADE side (spec §22/§23 — aiTradeStep) lives under the SAME rules:
 * the AI signs an import contract only for a REAL uncovered shortage, only
 * from a seller's REAL available surplus, at most ONE new contract per
 * month, and NEVER a duplicate for a good it already imports (§23 — the
 * existing contract continues). Contracts it no longer needs are cancelled.
 *
 * Leaf module: state types + config only. Unit-testable without a system.
 */

import type { GameState } from '../state/GameState';
import type { StrategicMapModel } from '../world/map/MapTypes';
import type { StrategicResourcesConfig } from './types';
import type { TradeRequest } from './resourceTypes';
import { resourceDisplayStatusOf, safetyReserveUnits } from './resources';
import { countryPotentialFactor } from './quality';
import {
  marketOffersOf,
  hasActiveImportContract,
  signContract,
  cancelContract,
  activeContractsOf,
  unitPriceOf,
  playerCountryIdOf,
  requestExport,
  remainingSaleOfferOf
} from './contracts';
import type { Random } from '../utils/Random';
import { roundTo } from '../utils/math';

/** The COVERAGE target of step ۲ (production ≥ consumption × THIS → built). */
const COVERAGE_TARGET = 1.1;
/** The export-depth ceiling of step ۳ (production ≥ consumption × THIS → stop). */
const EXPORT_DEPTH_CAP = 2.0;

/**
 * The monthly chance an AI country TRIES to sign ONE import contract
 * (spec §22 — the AI trades on the SAME real market as the player; the
 * chance keeps the world's contracts from all appearing in one month).
 */
const AI_CONTRACT_CHANCE = 0.35;

/**
 * Secures a country's CONSTRUCTION MATERIALS on the world market (spec §16
 * — «از بازار جهانی وارد کند»): the missing industrial-goods units are
 * BOUGHT directly from real sellers at the base price (real units + real
 * money move IMMEDIATELY — the construction needs the materials in stock
 * now; a country with no money or no seller secures nothing). TRUE when
 * the full amount is in stock after the purchase. This is what keeps
 * material-poor countries able to build — their import bill is the honest
 * price of construction.
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
  const price = unitPriceOf(config, 'industrial');
  if (price <= 0) return false;
  // The sellers of industrial goods, largest REAL available surplus first
  // (§3/§16 — offers come from real surplus, never from a buyer's need).
  // The PLAYER's country is NEVER a direct-deal seller (the export-request
  // directive §3): its goods move only through contracts the president
  // signed — the AI secures its materials from AI sellers only.
  const player = playerCountryIdOf(state);
  const sellers = marketOffersOf(state, countryId, 'industrial', config).filter(
    (seller) => seller.countryId !== player
  );
  let stillMissing = missing;
  for (const seller of sellers) {
    if (stillMissing <= 0) break;
    const treasury = Math.max(0, state.economy.treasury[countryId] ?? 0);
    const affordable = Math.floor(treasury / price);
    const amount = Math.max(0, Math.min(stillMissing, seller.amount, affordable));
    if (amount <= 0) continue;
    const sellerRecord = state.economy.resources[seller.countryId]!;
    const cost = roundTo(amount * price, 2);
    // REAL units + REAL money move, immediately (a one-time direct deal —
    // NOT a contract; the ledger lines are never booked here, the money
    // has already left/arrived — no double-count, §11).
    sellerRecord.stock.industrial = Math.round((sellerRecord.stock.industrial ?? 0) - amount);
    record.stock.industrial = Math.round((record.stock.industrial ?? 0) + amount);
    state.economy.treasury[countryId] = roundTo((state.economy.treasury[countryId] ?? 0) - cost, 4);
    state.economy.treasury[seller.countryId] = roundTo((state.economy.treasury[seller.countryId] ?? 0) + cost, 4);
    record.imports.industrial = Math.round((record.imports.industrial ?? 0) + amount);
    sellerRecord.exports.industrial = Math.round((sellerRecord.exports.industrial ?? 0) + amount);
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
  //    A good an ACTIVE IMPORT CONTRACT already serves is skipped (§16/§22
  //    — trade OR build, never both: double supply would grind the world
  //    toward effortless self-sufficiency; §25 wants interdependence).
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
    // An active import contract already closes this flow — trade serves it.
    if (hasActiveImportContract(state, countryId, resource.id)) continue;
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

/**
 * The AI's MONTHLY TRADE DECISION (spec §22/§23) — the AI trades on the
 * SAME real market as the player, with the SAME constraints (never fake
 * goods, never unlimited money):
 *
 *  ۱. CANCEL what is no longer needed (deterministic): an active IMPORT
 *     contract whose good the country now really covers by itself —
 *     production ≥ consumption AND the stock holds the safety reserve —
 *     is dropped (the monthly bill must not drain a self-sufficient
 *     treasury, §23's contracts-serve-needs spirit).
 *  ۲. SIGN at most ONE new contract per month (chance-gated): for the
 *     LARGEST uncovered shortage that no active import contract already
 *     serves (§23 — the existing contract continues; no monthly
 *     duplicates), from the largest REAL market offer (§3/§24 — real
 *     surplus only), sized min(need, offer) and checked against the
 *     treasury (signContract guards capacity + first month's bill).
 *
 * THE EXPORT-REQUEST RULE (the export-request directive §3): when the best
 * seller of the needed good is the PLAYER's country, the AI does NOT sign
 * — it FILES A FORMAL EXPORT REQUEST the president approves (a contract
 * forms) or rejects (nothing happens). Pending duplicates and rejected
 * requests in their cooldown are refused by requestExport's own guards.
 * AI-to-AI trade stays direct — the world market keeps working.
 *
 * Deterministic ordering: config resource order for the need scan, the
 * market's largest-offer-first order for the seller pick.
 *
 * @returns the export request it just filed against the player's country
 *          (for the caller's event), or null for a direct AI-to-AI
 *          signature / no action this month.
 */
export function aiTradeStep(
  state: GameState,
  countryId: string,
  config: StrategicResourcesConfig,
  month: number,
  rng: Random,
  newId: (kind: string) => string
): TradeRequest | null {
  const record = state.economy.resources[countryId];
  if (record === undefined) return null;

  // —— ۱. cancel import contracts the country no longer needs ——
  for (const contract of activeContractsOf(state, countryId)) {
    if (contract.buyerId !== countryId) continue; // only its own imports
    const resourceId = contract.resourceId;
    const production = record.production[resourceId] ?? 0;
    const consumption = record.consumption[resourceId] ?? 0;
    const stock = record.stock[resourceId] ?? 0;
    const reserve = safetyReserveUnits(record.consumption, resourceId, config);
    if (production >= consumption && stock >= reserve) {
      cancelContract(state, contract.id, countryId, month);
    }
  }

  // —— ۲. at most ONE new contract this month, for the largest uncovered
  //      shortage that no active contract already serves (§23) ——
  if (!rng.chance(AI_CONTRACT_CHANCE)) return null;
  let neededResource: string | null = null;
  let worst = 0;
  for (const resource of config.resources) {
    const uncovered = record.shortage[resource.id] ?? 0;
    if (uncovered > worst) {
      worst = uncovered;
      neededResource = resource.id;
    }
  }
  if (neededResource === null) return null;
  if (hasActiveImportContract(state, countryId, neededResource)) return null;
  // THE EXPORT-REQUEST RULE (the export-request directive §3): when the
  // PLAYER's country has ANY remaining sale offer of the needed good, the
  // AI seeks to buy from IT — a formal REQUEST the president approves or
  // rejects (never a silent contract). Waiting for the player to be the
  // world's LARGEST seller would make requests practically never happen:
  // countries actively ask the player whenever it can supply them. A
  // refused filing (duplicate pending / cooldown) consumes the month's
  // single trade action — no AI-AI fallback on top.
  const player = playerCountryIdOf(state);
  if (player !== null && player !== countryId) {
    const playerOffer = remainingSaleOfferOf(state, player, neededResource, config);
    if (playerOffer > 0) {
      const filed = requestExport(
        state,
        countryId,
        player,
        neededResource,
        Math.min(worst, playerOffer),
        month,
        config,
        newId
      );
      return filed.ok ? filed.request : null;
    }
  }
  const offers = marketOffersOf(state, countryId, neededResource, config);
  if (offers.length === 0) return null; // no real seller — the shortage stays (§25)
  const best = offers[0];
  signContract(
    state,
    countryId,
    best.countryId,
    neededResource,
    Math.min(worst, best.amount),
    month,
    config,
    newId
  );
  return null;
}
