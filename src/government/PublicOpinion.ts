/**
 * Public opinion (Phase 2) — topic sentiment and presidential approval.
 *
 * Opinion is COMPUTED from state each month, never accumulated blindly:
 * economy (unemployment/inflation/growth), the TAX LEVEL's buff, services
 * (funded by the economic budget), corruption and security each contribute
 * a sentiment; presidential approval drifts toward the weighted blend
 * (partial adjustment — perception lags reality). Future demographic groups
 * extend this module without touching the systems that read `approval`.
 */

import type { GameState } from '../state/GameState';
import type { OpinionTopic } from './types';
import { clamp01, clampSigned, OPINION_TOPICS, TAX_LEVEL_SPECS } from './types';
import { readMetric } from './Metrics';

/** Topic weights of the aggregate approval blend (Σ = 1). */
export const TOPIC_WEIGHTS: Readonly<Record<OpinionTopic, number>> = {
  economy: 0.38,
  taxes: 0.18,
  services: 0.18,
  corruption: 0.16,
  security: 0.1
};

export const NATURAL_UNEMPLOYMENT = 0.055;
export const COMFORTABLE_INFLATION = 0.024;
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

  const unemployment = readMetric(state, countryId, 'unemployment');
  const inflation = readMetric(state, countryId, 'inflation');
  const growth = readMetric(state, countryId, 'gdpGrowth');
  const corruption = readMetric(state, countryId, 'corruption');
  const stability = readMetric(state, countryId, 'stability');

  const budget = government.budget;
  // Taxes: the ONE tax level's buff (LOW positive, MEDIUM neutral,
  // HIGH negative, MAX strongly negative — spec §4/§5).
  const taxSentiment = TAX_LEVEL_SPECS[budget.tax].satisfaction;
  const serviceFunding = budget.spendingShares.healthcare + budget.spendingShares.education + budget.spendingShares.welfare;
  const securityFunding = budget.spendingShares.military;

  const topics = government.opinion.topics;
  // Economy: unemployment and inflation hurt; growth helps.
  topics.economy = clampSigned(
    (growth - 0.02) * 6 - Math.max(0, unemployment - NATURAL_UNEMPLOYMENT) * 3.2 - Math.max(0, inflation - COMFORTABLE_INFLATION) * 4
  );
  // Taxes: the level's buff, directly.
  topics.taxes = clampSigned(taxSentiment);
  // Services: economic-budget-funded services relative to the neutral level.
  topics.services = clampSigned((serviceFunding - NEUTRAL_SERVICE_FUNDING) * 5);
  // Corruption: direct + stability backdrop.
  topics.corruption = clampSigned(0.25 - corruption * 2.2 - Math.max(0, 0.5 - stability) * 0.8);
  // Security: military funding + stability.
  topics.security = clampSigned((securityFunding - 0.06) * 4 + (stability - 0.5) * 1.2);
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
