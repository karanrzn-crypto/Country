/**
 * GovernmentSystem (Phase 2) — the monthly presidential simulation.
 *
 * ONE system owns the month cadence for every strategic country and
 * sequences the pure domain engines in a fixed, deterministic order:
 *
 *   0. THE ECONOMIC CYCLE (one world pass per month, economyCycle.ts —
 *      spec §10's exact order: جمعیت → مالیات → تولید → مصرف غذا → هزینه‌ها
 *      → تجارت → پول نهایی → ثبات)
 *   1. budget & construction (urban development — food-shortage-penalized,
 *      military production with real material draws, money-paid building
 *      projects advancing by time)
 *   2. resource AI (non-player countries occasionally start a building
 *      they can actually AFFORD — the whole world builds, simply)
 *   3. public opinion (updateOpinionTopics → approval drift)
 *   4. decisions    (modifier expiry / cooldowns age with months)
 *   5. events       (expire overdue → maybe fire a new one)
 *   6. elections    (campaign start → effort accrual → election day)
 *   7. politics     (ministries, corruption, trust, protests, strikes,
 *                    party support drift, presidential authority)
 *
 * Catch-up design: each government record stores `lastSimMonth`; fast time
 * modes process multiple months per tick, pause processes none — the exact
 * calendar month sequence is always preserved. All randomness flows through
 * the campaign rng (deterministic replays).
 */

import type { SystemContext } from '../../core/GameContext';
import type { GameState } from '../../state/GameState';
import type { Random } from '../../utils/Random';
import type { TickInfo } from '../../time/TimeSystem';
import type { SimulationSystemDef } from '../SimulationEngine';
import { absoluteMonthIndex } from '../../time/Calendar';
import type { StrategicResourcesConfig } from '../../economy/types';
import type { StrategicMapModel } from '../../world/map/MapTypes';
import { runEconomyCycle } from '../../economy/economyCycle';
import { stepProjects, startProject, workforceCapacityOf, workforceUsedBy } from '../../economy/construction';
import { aiBuildingTypeId, aiSecureConstructionMaterials, aiTradeStep } from '../../economy/aiEconomy';
import { economicBuildingAtCell, cellIsUnderConstruction } from '../../economy/resources';
import { cellQualityOf } from '../../economy/quality';
import { gridCellKey } from '../../world/map/MapTypes';
import { growUrbanDevelopment, produceMilitary } from '../../government/budgetEffects';
import { tickDecisionModifiers } from '../../government/DecisionEngine';
import { expireOverdueEvents, firePendingEvent, newEventInstanceId, rollEvents } from '../../government/EventEngine';
import { accrueCampaignEffort, applyElectionOutcome, campaignPhaseActive, computeElectionOutcome, startCampaign } from '../../government/Elections';
import { driftApproval, updateOpinionTopics } from '../../government/PublicOpinion';
import { acuteShortageCountOf } from '../../government/Metrics';
import { clamp01, protestLevelOf, type GovernmentCountryState } from '../../government/types';

/** Chance a new event fires for a country in a given month. */
const EVENT_FIRE_CHANCE = 0.3;
/** Strike pressure that triggers a general strike. */
const GENERAL_STRIKE_THRESHOLD = 0.65;
const GENERAL_STRIKE_MONTHS = 3;
/** Monthly chance an AI country TRIES to start one building (ONLY when its
 *  treasury covers the full one-time money cost with a safety margin —
 *  construction must never bankrupt the world; materials/workforce/capacity
 *  are enforced by the same startProject gates the player faces, §16). */
const AI_CONSTRUCTION_CHANCE = 0.08;
/** AI pays only when it keeps this multiple of the cost after paying. */
const AI_TREASURY_MARGIN = 1.5;

export class GovernmentSystem implements SimulationSystemDef {
  readonly id = 'government';
  readonly dependencies = ['economy', 'political'] as const;

  tick(context: SystemContext, _tick: TickInfo): void {
    const currentMonth = absoluteMonthIndex(context.time.date, context.time.startDate);
    const { state } = context;
    const countryIds = Object.keys(state.government.countries);

    // Month-LOCKSTEP catch-up: every due country lives through month M
    // before anyone starts M+1. This is what lets the GLOBAL trade network
    // + stock step run exactly ONCE per month (a monthly economic cadence):
    //
    //   world pass (production/consumption → trades → stock step → food
    //   safety)  ↓  every due country's finance/construction for that month.
    for (;;) {
      const due = countryIds.filter(
        (countryId) => state.government.countries[countryId].lastSimMonth < currentMonth
      );
      if (due.length === 0) break;
      if (context.map !== undefined) {
        // THE ECONOMIC CYCLE — the whole world advances ONE month per pass
        // (spec §12's fixed order; the lockstep loop keeps it once/month).
        runEconomyCycle(state, context.map, context.data.economyData.strategicResources, {
          applyStep: true,
          month: currentMonth
        });
      }
      for (const countryId of due) {
        const government = state.government.countries[countryId];
        government.lastSimMonth += 1;
        this.processMonth(context, countryId, government, government.lastSimMonth);
      }
    }
  }

  /** Processes exactly one campaign month for one country. */
  private processMonth(
    context: SystemContext,
    countryId: string,
    government: GovernmentCountryState,
    month: number
  ): void {
    const { state, events, rng, ids, data } = context;
    const config = data.economyData.strategicResources;

    // —— 1. budget & construction (REAL state, spec §2/§3/§5/§8) ——
    // Economic budget grows urban development (halved by a food shortage);
    // military budget produces equipment by consuming iron/oil from the
    // REAL stockpile; building projects advance by time (paid in full).
    growUrbanDevelopment(state, countryId);
    produceMilitary(state, countryId, config.militaryMaterials);
    const built = context.map !== undefined
      ? stepProjects(state, context.map, countryId, config, month)
      : { completed: [] };
    for (const project of built.completed) {
      events.emit('economy.constructionCompleted', { countryId, projectId: project.id, typeId: project.typeId });
    }

    // —— 2. resource AI: the whole world builds AND trades, simply ——
    //    (spec §16/§22: need-based construction + need-based trade
    //    contracts on the SAME real market the player uses — §23: at most
    //    one new contract per month, never duplicates for one need.)
    if (state.player.countryId !== countryId && context.map !== undefined) {
      this.processAiEconomy(state, countryId, config, month, rng, (kind) => ids.next(kind), context.map);
      // The export-request directive §3: when the AI's best seller is the
      // PLAYER's country, aiTradeStep files a formal REQUEST instead of a
      // contract — the president is notified and decides in «قراردادها».
      const filed = aiTradeStep(state, countryId, config, month, rng, (kind) => ids.next(kind));
      if (filed !== null) {
        events.emit('economy.exportRequested', {
          requestId: filed.id,
          buyerId: filed.buyerId,
          sellerId: filed.sellerId,
          resourceId: filed.resourceId,
          amountPerMonth: filed.amountPerMonth,
          price: filed.price
        });
      }
    }

    // —— 3. public opinion → presidential approval ——
    updateOpinionTopics(state, countryId, data.economyData.strategicResources);
    driftApproval(state, countryId, 0.25);

    // —— 4. decisions: active modifiers age ——
    tickDecisionModifiers(state, countryId);

    // —— 5. events: expiry, then a weighted roll ——
    expireOverdueEvents(state, countryId, data.eventList, month);
    if (rng.chance(EVENT_FIRE_CHANCE)) {
      const fired = rollEvents(state, countryId, data.eventList, month, rng);
      if (fired !== undefined && fired !== null && government.events.pending.length < 3) {
        firePendingEvent(state, countryId, fired, month, newEventInstanceId(ids));
        events.emit('government.eventFired', {
          countryId,
          eventId: fired.id,
          title: fired.title,
          category: fired.category
        });
      }
    }

    // —— 6. elections ——
    const elections = government.elections;
    if (campaignPhaseActive(elections.nextElectionMonth, month) && elections.phase === 'idle') {
      startCampaign(state, countryId);
      events.emit('government.campaignStarted', { countryId, electionMonth: elections.nextElectionMonth });
    }
    if (elections.phase === 'campaigning') {
      accrueCampaignEffort(state, countryId, month, rng);
    }
    if (month >= elections.nextElectionMonth) {
      const outcome = computeElectionOutcome(state, countryId, rng);
      applyElectionOutcome(state, countryId, outcome, month, government.president.termLengthMonths);
      events.emit('government.electionHeld', {
        countryId,
        winnerId: outcome.winnerId,
        incumbentReelected: outcome.incumbentReelected
      });
    }

    // —— 7. politics & administration ——
    this.processMinistries(government);
    this.processCorruptionAndTrust(government);
    this.processProtestsAndStrikes(state, countryId, government, month);
    this.processPartySupport(government, rng);
    this.processPresidentialPowers(government);

    events.emit('government.monthProcessed', { countryId, month });
  }

  /**
   * AI countries keep the WORLD economy alive (spec §16): occasionally a
   * non-player country starts the building its economy actually NEEDS —
   * the largest uncovered shortage picks the type (food shortage → مزرعه,
   * oil shortage → میدان نفتی …, aiEconomy.ts); without an urgent need it
   * reinforces its strongest (specialization) good. The AI faces EXACTLY
   * the player's constraints: money (with a safety margin), construction
   * materials, workforce pool and the concurrent-project capacity (§6),
   * all enforced by the SAME startProject gates. The site is a FREE grid
   * cell of its OWN land (spec §1), picked by land QUALITY (§3/§16 — the
   * AI builds where the yield is best, never randomly into barren land).
   */
  private processAiEconomy(
    state: GameState,
    countryId: string,
    config: StrategicResourcesConfig,
    month: number,
    rng: Random,
    newId: (kind: string) => string,
    mapModel: StrategicMapModel
  ): void {
    const record = state.economy.resources[countryId];
    if (record === undefined) return;

    // —— construction: occasionally start the NEEDED building, ONLY when
    //    affordable with a margin AND the same gates the player faces ——
    const construction = state.economy.construction[countryId];
    if (
      construction !== undefined &&
      construction.projects.length < config.construction.maxProjects &&
      rng.chance(AI_CONSTRUCTION_CHANCE)
    ) {
      const typeId = aiBuildingTypeId(state, mapModel, countryId, config);
      const def = config.buildings.find((candidate) => candidate.id === typeId);
      const treasury = state.economy.treasury[countryId] ?? 0;
      const affordable =
        def !== undefined &&
        treasury >= def.cost * AI_TREASURY_MARGIN &&
        workforceUsedBy(state, countryId, config) + def.workforce <=
          workforceCapacityOf(state, countryId, config);
      if (def !== undefined && affordable) {
        // Materials may need the WORLD MARKET (spec §16): the missing
        // industrial units are bought from real sellers — no purchase, no
        // project (a broke country simply skips construction this month).
        if (aiSecureConstructionMaterials(state, countryId, config, def.materials)) {
          const cell = this.pickBestCell(state, mapModel, countryId, def.resource ?? '', config, rng);
          if (cell !== null) {
            startProject(state, countryId, config, def.id, cell, month, () => newId('building'));
          }
        }
      }
    }
  }

  /**
   * The BEST free grid cell of the country's OWN land for ONE good (spec
   * §3/§16): samples a bounded set through the campaign rng, keeps the
 * highest land QUALITY (tie → the first sampled — deterministic). null
   * when the country has no free cell.
   */
  private pickBestCell(
    state: GameState,
    mapModel: StrategicMapModel,
    countryId: string,
    resourceId: string,
    config: StrategicResourcesConfig,
    rng: Random
  ): string | null {
    const country = mapModel.countries[countryId];
    if (country === undefined || country.cellIds.length === 0) return null;
    let bestKey: string | null = null;
    let bestQuality = -1;
    const samples = Math.min(country.cellIds.length, 32);
    for (let attempt = 0; attempt < samples; attempt += 1) {
      const cellIndex = country.cellIds[rng.int(country.cellIds.length)];
      const gridId = mapModel.features.gridIds[cellIndex];
      if (gridId === null) continue;
      const key = gridCellKey(countryId, gridId);
      if (economicBuildingAtCell(state, key) !== null) continue;
      if (cellIsUnderConstruction(state, key)) continue;
      const quality = cellQualityOf(mapModel, cellIndex, resourceId, config);
      if (quality > bestQuality) {
        bestQuality = quality;
        bestKey = key;
      }
    }
    return bestKey;
  }

  /** Ministry efficiency drifts toward a funding-dependent target. */
  private processMinistries(government: GovernmentCountryState): void {
    for (const ministry of Object.values(government.ministries)) {
      const target = 0.25 + ministry.funding * 0.65;
      ministry.efficiency = clamp01(ministry.efficiency + (target - ministry.efficiency) * 0.1);
    }
  }

  /** Corruption grows when neglected; trust follows corruption + stability. */
  private processCorruptionAndTrust(government: GovernmentCountryState): void {
    const interiorEfficiency = government.ministries.interior?.efficiency ?? 0.5;
    let corruptionDelta = 0.006 - interiorEfficiency * 0.018;
    corruptionDelta -= government.politics.publicTrust * 0.004;
    government.politics.corruption = clamp01(government.politics.corruption + corruptionDelta);

    const trustTarget = clamp01(
      0.75 - government.politics.corruption * 0.6 - government.politics.protestPressure * 0.2
    );
    government.politics.publicTrust = clamp01(
      government.politics.publicTrust + (trustTarget - government.politics.publicTrust) * 0.15
    );
  }

  /** Protest/strike pressure accumulates from scarcity and decays with calm. */
  private processProtestsAndStrikes(
    state: GameState,
    countryId: string,
    government: GovernmentCountryState,
    month: number
  ): void {
    const politics = government.politics;
    const approval = government.president.approval;
    const shortages = acuteShortageCountOf(state, countryId);

    politics.protestPressure = clamp01(
      politics.protestPressure -
        approval * 0.018 +
        Math.max(0, -government.opinion.topics.economy) * 0.05 +
        shortages * 0.02 +
        politics.corruption * 0.012 -
        0.015
    );
    politics.protests = protestLevelOf(politics.protestPressure);

    if (politics.generalStrikeUntilMonth !== null && month > politics.generalStrikeUntilMonth) {
      politics.generalStrikeUntilMonth = null;
    }

    politics.strikePressure = clamp01(
      politics.strikePressure + shortages * 0.015 - politics.strikePressure * 0.02 - 0.01
    );
    if (politics.generalStrikeUntilMonth === null && politics.strikePressure >= GENERAL_STRIKE_THRESHOLD) {
      politics.generalStrikeUntilMonth = month + GENERAL_STRIKE_MONTHS;
      politics.strikePressure = 0.35; // vented by the strike itself
    }
  }

  /**
   * Party support drifts with presidential approval and a small deterministic
   * jitter; supports stay normalized (Σ ≈ 1).
   */
  private processPartySupport(government: GovernmentCountryState, rng: Random): void {
    const parties = Object.values(government.politics.parties);
    if (parties.length === 0) return;
    const approvalBias = (government.president.approval - 0.5) * 0.3;
    const targets = parties.map((party) => {
      const incumbentBonus = party.inGovernment ? approvalBias : -approvalBias * 0.4;
      return Math.max(0.02, party.support * (1 + incumbentBonus) + (rng.next() - 0.5) * 0.006);
    });
    const total = targets.reduce((sum, value) => sum + value, 0);
    parties.forEach((party, index) => {
      party.support = targets[index] / total;
    });
  }

  /** Executive authority & political support follow seats + performance. */
  private processPresidentialPowers(government: GovernmentCountryState): void {
    const president = government.president;
    const coalitionSeats = government.politics.coalition.reduce(
      (sum, partyId) => sum + (government.politics.parties[partyId]?.seatShare ?? 0),
      0
    );
    const supportTarget = clamp01(coalitionSeats * 0.7 + president.approval * 0.3);
    president.politicalSupport = clamp01(president.politicalSupport + (supportTarget - president.politicalSupport) * 0.2);

    const authorityTarget = clamp01(
      0.35 + president.politicalSupport * 0.45 - government.politics.corruption * 0.15
    );
    president.executiveAuthority = clamp01(
      president.executiveAuthority + (authorityTarget - president.executiveAuthority) * 0.2
    );
  }
}
