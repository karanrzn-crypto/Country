/**
 * Economy state slice — treasuries, resource stockpiles, factories, region
 * infrastructure supply. Fully JSON-safe (save-friendly).
 *
 * TWO economies share this slice:
 *  - the LEGACY demo world (stockpiles/factories with the old faction ids);
 *  - the SIMPLE strategic economy (resources/finance/construction/buildings,
 *    keyed by strategic country ids — spec §1-§8).
 *
 * ONE writer per record family (spec §13 — no parallel systems):
 *  - resources  : runEconomyCycle (the monthly pass) + purchase/construction
 *  - finance    : runEconomyCycle (the money step applies to the treasury)
 *  - construction/buildings : the construction commands + the monthly step
 */

import type { FactoryRecord } from '../../economy/types';
// LEAF types module — importing from economy/resources here would close the
// cycle GameState → economySlice → resources → GameState (resources reads
// live GameState). The record SHAPE has no such dependency.
import type {
  CountryResourceState,
  CountryFinanceState,
  CountryConstructionState,
  BuildingRecord,
  TradeContract,
  TradeRequest,
  ActiveEconomicEvent
} from '../../economy/resourceTypes';

export interface EconomySlice {
  /** faction/country id → treasury amount. */
  treasury: Record<string, number>;
  /** faction/country id → resource id → amount (LEGACY demo world only). */
  stockpiles: Record<string, Record<string, number>>;
  /** factory instance id → record (LEGACY demo world only). */
  factories: Record<string, FactoryRecord>;
  /** region id → supply satisfaction ratio 0..1 (SupplySystem writes). */
  supply: Record<string, number>;
  /**
   * The SIMPLE economy per strategic country id — the ONE resource truth:
   * stock / production / consumption / this month's trade / shortage.
   */
  resources: Record<string, CountryResourceState>;
  /**
   * The simple monthly money ledger per strategic country id (spec §3/§12):
   * مالیات + تجارت against ارتش + دولت + زیرساخت. The balance lands on the
   * treasury ONCE per month.
   */
  finance: Record<string, CountryFinanceState>;
  /**
   * Active construction projects per strategic country id (spec §1) — the
   * ONE-TIME money cost was paid at start; only build time remains. Each
   * project occupies ONE grid cell (canonical `countryId#gridId` key).
   */
  construction: Record<string, CountryConstructionState>;
  /**
   * COMPLETED buildings per strategic country id: buildingId →
   * {typeId, cellKey}. Each building produces its ONE good on the grid cell
   * it was built on (spec §1/§2 — one economic building per region).
   */
  buildings: Record<string, Record<string, BuildingRecord>>;
  /**
   * The ECONOMY LEVEL per strategic country id (spec §3): one 0-100 number
   * for the overall state of the economy. Drifts gradually every month
   * (economyCycle step ۸) and scales building production around 50.
   */
  economyLevel: Record<string, number>;
  /**
   * The world's TRADE CONTRACTS (spec §6/§24): every signed monthly
   * agreement — active AND cancelled (the قراردادها panel reads the real
   * State, §8). ONE global list; a country's contracts are the records
   * where it is the buyer or the seller. The monthly cycle executes the
   * active ones (step ۴ — real deliveries, §9); signing reserves the
   * seller's real export capacity (§16).
   */
  contracts: TradeContract[];
  /**
   * The world's PENDING EXPORT REQUESTS (the export-request directive):
   * AI countries asking the PLAYER's country to sell — the president
   * approves (a contract forms) or rejects (nothing happens). ONE global
   * list; decided records stay (the panel shows the decision history).
   */
  exportRequests: TradeRequest[];
  /**
   * The ACTIVE ECONOMIC EVENTS per strategic country id (the events
   * directive §5): temporary production cuts (broken refinery, famine)
   * with their remaining months. The event step owns the lifecycle; the
   * cycle only reads the factor when computing production.
   */
  events: Record<string, ActiveEconomicEvent[]>;
}

export function addStockpile(
  stockpiles: Record<string, Record<string, number>>,
  ownerId: string,
  resourceId: string,
  amount: number
): void {
  const ownerStock = (stockpiles[ownerId] ??= {});
  ownerStock[resourceId] = (ownerStock[resourceId] ?? 0) + amount;
}

export function hasStockpile(
  stockpiles: Record<string, Record<string, number>>,
  ownerId: string,
  need: Readonly<Record<string, number>>
): boolean {
  const ownerStock = stockpiles[ownerId];
  if (ownerStock === undefined) return Object.keys(need).length === 0;
  return Object.entries(need).every(([resourceId, amount]) => (ownerStock[resourceId] ?? 0) >= amount);
}

export function consumeStockpile(
  stockpiles: Record<string, Record<string, number>>,
  ownerId: string,
  need: Readonly<Record<string, number>>
): void {
  const ownerStock = stockpiles[ownerId] ??= {};
  for (const [resourceId, amount] of Object.entries(need)) {
    ownerStock[resourceId] = (ownerStock[resourceId] ?? 0) - amount;
  }
}

export function totalPopulationOfCountry(
  populationByRegion: Readonly<Record<string, { population: number }>>,
  countryOfRegion: Readonly<Record<string, string>>,
  regionsOfCountry: readonly string[]
): number {
  let total = 0;
  for (const regionId of regionsOfCountry) {
    if (countryOfRegion[regionId] !== undefined) {
      total += populationByRegion[regionId]?.population ?? 0;
    }
  }
  return total;
}
