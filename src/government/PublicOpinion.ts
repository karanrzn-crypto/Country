/**
 * Public opinion (Phase 2) — topic sentiment and presidential approval.
 *
 * Opinion is COMPUTED from state each month, never accumulated blindly:
 * economy (the REAL resource situation — acute shortages and empty
 * stockpiles hurt), the TAX LEVEL's buff, services (funded by the economic
 * budget), corruption and security each contribute a sentiment;
 * presidential approval drifts toward the weighted blend (partial
 * adjustment — perception lags reality). Future demographic groups extend
 * this module without touching the systems that read `approval`.
 */

import type { GameState } from '../state/GameState';
import type { OpinionTopic } from './types';
import { clamp01, clampSigned, OPINION_TOPICS, TAX_LEVEL_SPECS } from './types';
import { acuteShortageCountOf } from './Metrics';

/** Topic weights of the aggregate approval blend (Σ = 1). */
export const TOPIC_WEIGHTS: Readonly<Record<OpinionTopic, number>> = {
  economy: 0.38,
  taxes: 0.18,
  services: 0.18,
  corruption: 0.16,
  security: 0.1
};

/**
 * Service funding (healthcare+education+welfare money, share of GDP) where
 * the services sentiment is neutral. Matches the services portion of the
 * ECONOMIC half at the DEFAULT 50/50 budget split — a bigger economic
 * budget buys positive sentiment, a smaller one pain (spec §2).
 */
export const NEUTRAL_SERVICE_FUNDING = 0.035;

/**
 * Recomputes all topic sentiments for one country from CURRENT state.
 * Pure — writes only into `government.opinion.topics`.
 */
export function updateOpinionTopics(state: GameState, countryId: string): void {
  const government = state.government.countries[countryId];
  if (government === undefined) return;

  const corruption = readCorruption(state, countryId);
  const stability = readStability(state, countryId);

  const budget = government.budget;
  // Taxes: the ONE tax level's buff (LOW positive, MEDIUM neutral,
  // HIGH negative, MAX strongly negative — spec §4/§5).
  const taxSentiment = TAX_LEVEL_SPECS[budget.tax].satisfaction;
  const serviceFunding = budget.spendingShares.healthcare + budget.spendingShares.education + budget.spendingShares.welfare;
  const securityFunding = budget.spendingShares.military;

  // Economy: the REAL resource situation — every acutely short resource
  // (empty stockpile + uncovered deficit, or an unfilled world shortage)
  // hurts; a fully supplied country is content.
  const shortages = acuteShortageCountOf(state, countryId);
  const topics = government.opinion.topics;
  topics.economy = clampSigned(0.3 - shortages * 0.14);
  // Taxes: the level's buff, directly.
  topics.taxes = clampSigned(taxSentiment);
  // Services: economic-budget-funded services relative to the neutral level.
  topics.services = clampSigned((serviceFunding - NEUTRAL_SERVICE_FUNDING) * 5);
  // Corruption: direct + stability backdrop.
  topics.corruption = clampSigned(0.25 - corruption * 2.2 - Math.max(0, 0.5 - stability) * 0.8);
  // Security: military funding + stability.
  topics.security = clampSigned((securityFunding - 0.06) * 4 + (stability - 0.5) * 1.2);
}

function readCorruption(state: GameState, countryId: string): number {
  return state.government.countries[countryId]?.politics.corruption ?? 0;
}

function readStability(state: GameState, countryId: string): number {
  return state.political.countries[countryId]?.stability ?? 0;
}

/** Weighted approval target implied by the current topics (0..1). */
export function approvalTargetOf(topics: Readonly<Record<OpinionTopic, number>>): number {
  let weighted = 0;
  for (const topic of OPINION_TOPICS) {
    weighted += (TOPIC_WEIGHTS[topic] ?? 0) * (topics[topic] ?? 0);
  }
  return clamp01(0.52 + weighted * 0.4);
}

/** Monthly approval drift toward the opinion target (partial adjustment). */
export function driftApproval(state: GameState, countryId: string, rate = 0.3): number {
  const government = state.government.countries[countryId];
  if (government === undefined) return 0;
  const target = approvalTargetOf(government.opinion.topics);
  const before = government.president.approval;
  government.president.approval = clamp01(before + (target - before) * rate);
  return government.president.approval - before;
}
