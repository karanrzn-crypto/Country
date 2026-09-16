/**
 * Elections (Phase 2) — term scheduling, campaigns, voting and government
 * formation.
 *
 * Pure functions over state; the GovernmentSystem calls them on the monthly
 * cadence. Designed so future government forms (parliamentary systems,
 * different franchise rules) extend the DEF-side: vote share is computed
 * from party support + campaign effort + incumbent approval — no hard-coded
 * politics.
 */

import type { GameState } from '../state/GameState';
import type { PartyState } from './types';
import { CAMPAIGN_MONTHS, PARLIAMENT_SEATS } from './types';
import type { Random } from '../utils/Random';

/** Campaign window opens this many months before the election month. */
export function campaignPhaseActive(nextElectionMonth: number, month: number): boolean {
  return month >= nextElectionMonth - CAMPAIGN_MONTHS && month < nextElectionMonth;
}

/** Enters the campaign phase (resets effort, phase = 'campaigning'). */
export function startCampaign(state: GameState, countryId: string): void {
  const government = state.government.countries[countryId];
  if (government === undefined) return;
  government.elections.phase = 'campaigning';
  government.elections.campaignEffort = Object.fromEntries(
    Object.keys(government.politics.parties).map((partyId) => [partyId, 0])
  );
}

/**
 * Monthly campaign accrual: parties gain effort from their support and a
 * deterministic rng jitter; the incumbent gains from presidential approval.
 */
export function accrueCampaignEffort(state: GameState, countryId: string, month: number, rng: Random): void {
  const government = state.government.countries[countryId];
  if (government === undefined || government.elections.phase !== 'campaigning') return;
  for (const party of Object.values(government.politics.parties)) {
    let gain = party.support * 0.15 + rng.next() * 0.05;
    if (party.id === government.president.partyId) {
      gain *= 0.6 + government.president.approval * 0.9;
    }
    government.elections.campaignEffort[party.id] = Math.min(
      1,
      (government.elections.campaignEffort[party.id] ?? 0) + gain
    );
  }
  void month;
}

export interface ElectionOutcome {
  winnerId: string;
  /** Party id → vote share (Σ = 1). */
  votes: Record<string, number>;
  /** Party id → parliament seats (Σ = PARLIAMENT_SEATS). */
  seats: Record<string, number>;
  /** Coalition party ids (winner + allies when seats < majority). */
  coalition: string[];
  /** Whether the incumbent president's party won. */
  incumbentReelected: boolean;
}

/**
 * Computes the full election outcome WITHOUT mutating state: vote shares
 * from support × (1 + effort), largest-remainder seats, coalition building.
 */
export function computeElectionOutcome(state: GameState, countryId: string, rng: Random): ElectionOutcome {
  const government = state.government.countries[countryId];
  const parties = Object.values(government?.politics.parties ?? {});
  if (parties.length === 0) {
    return { winnerId: '', votes: {}, seats: {}, coalition: [], incumbentReelected: false };
  }

  // —— vote share: support scaled by campaign effort and a small jitter ——
  const raw: Record<string, number> = {};
  let total = 0;
  for (const party of parties) {
    const effort = government?.elections.campaignEffort[party.id] ?? 0;
    const jitter = 0.92 + rng.next() * 0.16;
    const votes = Math.max(0.01, party.support * (1 + effort * 0.35) * jitter);
    raw[party.id] = votes;
    total += votes;
  }
  const votes: Record<string, number> = {};
  for (const [partyId, value] of Object.entries(raw)) votes[partyId] = value / total;

  // —— largest remainder allocation (same method the population tree uses) ——
  const seats = largestRemainder(votes, PARLIAMENT_SEATS);

  // —— winner = most seats; coalition when short of a majority ——
  let winnerId = '';
  let best = -1;
  for (const [partyId, count] of Object.entries(seats)) {
    if (count > best) {
      best = count;
      winnerId = partyId;
    }
  }
  const coalition = [winnerId];
  let controlled = seats[winnerId] ?? 0;
  if (controlled <= PARLIAMENT_SEATS / 2) {
    const others = parties
      .filter((party) => party.id !== winnerId)
      .sort((a, b) => (seats[b.id] ?? 0) - (seats[a.id] ?? 0));
    for (const party of others) {
      if (controlled > PARLIAMENT_SEATS / 2) break;
      coalition.push(party.id);
      controlled += seats[party.id] ?? 0;
    }
  }

  const incumbentReelected = government !== undefined && winnerId === government.president.partyId;
  return { winnerId, votes, seats, coalition, incumbentReelected };
}

/**
 * Applies an election outcome: seats, party records, government formation,
 * new presidential term (re-election or handover inside the same party
 * system — a future character phase replaces the president name).
 * Returns the outcome for events/UI.
 */
export function applyElectionOutcome(state: GameState, countryId: string, outcome: ElectionOutcome, month: number, termLengthMonths: number): ElectionOutcome {
  const government = state.government.countries[countryId];
  if (government === undefined || outcome.winnerId === '') return outcome;

  const seatsTotal = Object.values(outcome.seats).reduce((sum, value) => sum + value, 0);
  government.politics.parliament = { seatsTotal, seats: { ...outcome.seats } };

  for (const party of Object.values(government.politics.parties)) {
    party.seatShare = seatsTotal > 0 ? (outcome.seats[party.id] ?? 0) / seatsTotal : 0;
    party.inGovernment = outcome.coalition.includes(party.id);
  }

  government.elections.phase = 'idle';
  government.elections.lastElectionMonth = month;
  government.elections.lastResults = outcome.votes;
  government.elections.lastWinnerId = outcome.winnerId;
  government.elections.nextElectionMonth = month + termLengthMonths;
  government.elections.campaignEffort = {};
  government.politics.coalition = [...outcome.coalition];

  // —— presidential term ——
  const president = government.president;
  const previousParty = president.partyId;
  president.partyId = outcome.winnerId;
  president.termStartMonth = month;
  president.termEndMonth = month + termLengthMonths;
  president.termsServed = outcome.incumbentReelected ? president.termsServed + 1 : 1;
  // Post-election legitimacy: winners gain backing, losers face opposition.
  president.politicalSupport = Math.min(
    1,
    0.45 + (government.politics.parliament.seats[outcome.winnerId] ?? 0) / seatsTotal * 0.4
  );
  if (!outcome.incumbentReelected && previousParty !== outcome.winnerId) {
    president.approval = Math.min(1, president.approval + 0.05); // honeymoon
    president.name = `${president.name}`; // identity stable until a character phase
  }
  president.executiveAuthority = Math.min(
    1,
    0.4 + president.politicalSupport * 0.5 - government.politics.corruption * 0.2
  );
  return outcome;
}

/** Largest-remainder (Hare) seat allocation — Σ result = seatsTotal exactly. */
export function largestRemainder(shares: Readonly<Record<string, number>>, seatsTotal: number): Record<string, number> {
  const result: Record<string, number> = {};
  const entries = Object.entries(shares);
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  if (total <= 0 || seatsTotal <= 0) {
    return Object.fromEntries(entries.map(([key]) => [key, 0]));
  }
  let allocated = 0;
  const remainders: { id: string; remainder: number }[] = [];
  for (const [id, value] of entries) {
    const exact = (value / total) * seatsTotal;
    const floor = Math.floor(exact);
    result[id] = floor;
    allocated += floor;
    remainders.push({ id, remainder: exact - floor });
  }
  remainders.sort((a, b) => b.remainder - a.remainder || a.id.localeCompare(b.id));
  let left = seatsTotal - allocated;
  let index = 0;
  while (left > 0 && remainders.length > 0) {
    const entry = remainders[index % remainders.length];
    result[entry.id] += 1;
    left -= 1;
    index += 1;
  }
  return result;
}

/** Coalition majority check for the dashboard. */
export function coalitionSeats(parties: Readonly<Record<string, PartyState>>, coalition: readonly string[]): number {
  return coalition.reduce((sum, partyId) => sum + (parties[partyId]?.seatShare ?? 0), 0);
}
