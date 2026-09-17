/**
 * GovernmentSystem (Phase 2) — the monthly presidential simulation.
 *
 * ONE system owns the month cadence for every strategic country and
 * sequences the pure domain engines in a fixed, deterministic order:
 *
 *   0. global trade (ONE world-market pass per month, BEFORE any ledger:
 *      every country's production/consumption → global supply & demand →
 *      exporter↔importer matching → trade transactions)
 *   1. economy      (EconomySimulation.processMonthEconomy)
 *   2. public opinion (updateOpinionTopics → approval drift)
 *   3. decisions    (modifier expiry / cooldowns age with months)
 *   4. events       (expire overdue → maybe fire a new one)
 *   5. elections    (campaign start → effort accrual → election day)
 *   6. politics     (ministries, corruption, trust, protests, strikes,
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
import { recomputeResourceEconomies } from '../../economy/resources';
import { processMonthEconomy } from '../../economy/EconomySimulation';
import { tickDecisionModifiers } from '../../government/DecisionEngine';
import { expireOverdueEvents, firePendingEvent, newEventInstanceId, rollEvents } from '../../government/EventEngine';
import { accrueCampaignEffort, applyElectionOutcome, campaignPhaseActive, computeElectionOutcome, startCampaign } from '../../government/Elections';
import { driftApproval, updateOpinionTopics } from '../../government/PublicOpinion';
import { clamp01, protestLevelOf, type GovernmentCountryState } from '../../government/types';

/** Chance a new event fires for a country in a given month. */
const EVENT_FIRE_CHANCE = 0.3;
/** Strike pressure that triggers a general strike. */
const GENERAL_STRIKE_THRESHOLD = 0.65;
const GENERAL_STRIKE_MONTHS = 3;

export class GovernmentSystem implements SimulationSystemDef {
  readonly id = 'government';
  readonly dependencies = ['economy', 'political'] as const;

  tick(context: SystemContext, _tick: TickInfo): void {
    const currentMonth = absoluteMonthIndex(context.time.date, context.time.startDate);
    const { state } = context;
    const countryIds = Object.keys(state.government.countries);

    // Month-LOCKSTEP catch-up: every due country lives through month M
    // before anyone starts M+1. This is what lets the GLOBAL trade network
    // run exactly ONCE per month (spec §13: a monthly economic cadence, not
    // a per-frame or per-country recomputation):
    //
    //   world trade pass (all countries → global supply/demand → trades)
    //     ↓
    //   every due country's ledger bills its OWN flows for that month.
    for (;;) {
      const due = countryIds.filter(
        (countryId) => state.government.countries[countryId].lastSimMonth < currentMonth
      );
      if (due.length === 0) break;
      if (context.map !== undefined) {
        recomputeResourceEconomies(
          state,
          context.map,
          context.data.economyData.strategicResources
        );
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

    // —— 1. economy (treasury, GDP, sectors, debt, inflation, jobs) ——
    // Bills the country's trade flows resolved by THIS month's world pass
    // (the global trade network ran once, above, before any ledger).
    processMonthEconomy(state, countryId, rng);

    // —— 2. public opinion → presidential approval ——
    updateOpinionTopics(state, countryId);
    driftApproval(state, countryId, 0.25);

    // —— 3. decisions: active modifiers age ——
    tickDecisionModifiers(state, countryId);

    // —— 4. events: expiry, then a weighted roll ——
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

    // —— 5. elections ——
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

    // —— 6. politics & administration ——
    this.processMinistries(government);
    this.processCorruptionAndTrust(government);
    this.processProtestsAndStrikes(state, countryId, government, month);
    this.processPartySupport(government, rng);
    this.processPresidentialPowers(government);

    events.emit('government.monthProcessed', { countryId, month });
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

  /** Protest/strike pressure accumulates from misery and decays with calm. */
  private processProtestsAndStrikes(
    state: GameState,
    countryId: string,
    government: GovernmentCountryState,
    month: number
  ): void {
    const politics = government.politics;
    const approval = government.president.approval;
    const unemployment = state.economy.macro[countryId]?.unemployment ?? 0;

    politics.protestPressure = clamp01(
      politics.protestPressure -
        approval * 0.018 +
        Math.max(0, -government.opinion.topics.economy) * 0.05 +
        Math.max(0, unemployment - 0.08) * 0.4 +
        politics.corruption * 0.012 -
        0.015
    );
    politics.protests = protestLevelOf(politics.protestPressure);

    if (politics.generalStrikeUntilMonth !== null && month > politics.generalStrikeUntilMonth) {
      politics.generalStrikeUntilMonth = null;
    }

    politics.strikePressure = clamp01(
      politics.strikePressure + Math.max(0, unemployment - 0.1) * 0.5 - politics.strikePressure * 0.02 - 0.01
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
