import { describe, it, expect } from 'vitest';
import { createTestGame } from '../../helpers/testGame';
import {
  campaignPhaseActive,
  startCampaign,
  accrueCampaignEffort,
  computeElectionOutcome,
  applyElectionOutcome,
  largestRemainder
} from '../../../government/Elections';
import { Random } from '../../../utils/Random';
import { PARLIAMENT_SEATS } from '../../../government/types';

describe('Elections (terms, campaigns, voting, government formation)', () => {
  it('largest-remainder allocates exactly seatsTotal with proportional results', () => {
    const exact = largestRemainder({ a: 0.5, b: 0.3, c: 0.2 }, 200);
    expect(exact).toEqual({ a: 100, b: 60, c: 40 });

    const messy = largestRemainder({ a: 0.3333, b: 0.3333, c: 0.3334 }, 200);
    expect(Object.values(messy).reduce((sum, value) => sum + value, 0)).toBe(200);
    expect(messy.c).toBeGreaterThanOrEqual(messy.a);

    // Fractional shares still allocate every seat.
    const fractional = largestRemainder({ x: 1, y: 1, z: 0.0001 }, 7);
    expect(Object.values(fractional).reduce((sum, value) => sum + value, 0)).toBe(7);
  });

  it('campaign phase opens exactly CAMPAIGN_MONTHS before election month', () => {
    expect(campaignPhaseActive(48, 41)).toBe(false);
    expect(campaignPhaseActive(48, 42)).toBe(true);
    expect(campaignPhaseActive(48, 47)).toBe(true);
    expect(campaignPhaseActive(48, 48)).toBe(false);
  });

  it('campaign effort accrues only during campaigning and is capped', () => {
    const game = createTestGame({ seed: 81 });
    const countryId = game.strategicMap.countryOrder[0];
    const state = game.gameState;
    startCampaign(state, countryId);
    expect(state.government.countries[countryId].elections.phase).toBe('campaigning');
    const rng = new Random(5);
    for (let month = 0; month < 6; month += 1) {
      accrueCampaignEffort(state, countryId, month, rng);
    }
    const efforts = state.government.countries[countryId].elections.campaignEffort;
    for (const value of Object.values(efforts)) {
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    game.dispose();
  });

  it('a full election: votes normalize, seats allocate, government forms, term resets', () => {
    const game = createTestGame({ seed: 82 });
    const countryId = game.strategicMap.countryOrder[0];
    const state = game.gameState;
    const government = state.government.countries[countryId];
    const incumbentPartyId = government.president.partyId;

    startCampaign(state, countryId);
    const rng = new Random(9);
    for (let month = 0; month < 6; month += 1) {
      accrueCampaignEffort(state, countryId, month, rng);
    }
    const outcome = computeElectionOutcome(state, countryId, rng);

    const voteSum = Object.values(outcome.votes).reduce((sum, value) => sum + value, 0);
    expect(voteSum).toBeCloseTo(1, 6);
    const seatSum = Object.values(outcome.seats).reduce((sum, value) => sum + value, 0);
    expect(seatSum).toBe(PARLIAMENT_SEATS);
    // Winner has the most seats.
    for (const [partyId, seats] of Object.entries(outcome.seats)) {
      if (partyId !== outcome.winnerId) expect(outcome.seats[outcome.winnerId]).toBeGreaterThanOrEqual(seats);
    }

    const applied = applyElectionOutcome(state, countryId, outcome, 48, 48);
    expect(applied.winnerId).toBe(outcome.winnerId);
    expect(government.elections.phase).toBe('idle');
    expect(government.elections.lastElectionMonth).toBe(48);
    expect(government.elections.nextElectionMonth).toBe(96);
    expect(government.elections.lastWinnerId).toBe(outcome.winnerId);
    expect(government.president.partyId).toBe(outcome.winnerId);
    expect(government.president.termStartMonth).toBe(48);
    expect(government.president.termEndMonth).toBe(96);
    expect(government.president.termsServed).toBe(outcome.incumbentReelected ? 2 : 1);
    expect(government.politics.parliament.seatsTotal).toBe(PARLIAMENT_SEATS);
    // Coalition holds a strict majority of seats.
    const coalitionSeats = government.politics.coalition.reduce(
      (sum, partyId) => sum + (government.politics.parliament.seats[partyId] ?? 0),
      0
    );
    expect(coalitionSeats).toBeGreaterThan(PARLIAMENT_SEATS / 2);
    expect(outcome.incumbentReelected).toBe(outcome.winnerId === incumbentPartyId);
    game.dispose();
  });

  it('unreachable outcomes are impossible: every party keeps ≥ 0 seats and supports stay normalized', () => {
    const game = createTestGame({ seed: 83 });
    const countryId = game.strategicMap.countryOrder[0];
    const state = game.gameState;
    const outcome = computeElectionOutcome(state, countryId, new Random(1));
    for (const value of Object.values(outcome.seats)) expect(value).toBeGreaterThanOrEqual(0);
    const supportSum = Object.values(state.government.countries[countryId].politics.parties).reduce(
      (sum, party) => sum + party.support,
      0
    );
    expect(supportSum).toBeCloseTo(1, 6);
    game.dispose();
  });
});
