/**
 * Budget & Tax effects (Phase 2) — the REAL state consequences of the 100%
 * budget pool and the 4-level tax (spec §2/§3/§4/§5). Pure functions over
 * GameState, invoked once per campaign month per country by the
 * GovernmentSystem (after the economy ledger, before public opinion).
 *
 *   Economic Budget ↑  → construction/development speed ↑ (city-area
 *                        development grows faster toward a higher target)
 *                        → services money ↑ → population satisfaction ↑
 *   Military Budget ↑  → weapon/equipment production ↑ + army expansion ↑
 *                        (and Economic ↓ — the pool is 100%, so the economic
 *                        effects above weaken by the same amount)
 *   Tax level          → revenue rate + 'taxes' sentiment + productivity
 *                        growth buff/penalty (LOW +, MEDIUM 0, HIGH −,
 *                        MAX strong −)
 *
 * Every effect writes REAL state fields (cityAreas development, country
 * military equipment/army, opinion topics) — nothing here is UI decoration.
 *
 * Leaf module: imports only types + the level spec table.
 */

import type { GameState } from '../state/GameState';
import { TAX_LEVEL_SPECS } from './types';

// —— Economic Budget → construction / development speed (spec §2) ——————
/** Development target at zero economic budget (decay floor). */
const DEVELOPMENT_BASE_TARGET = 0.55;
/** Extra development target at a FULL economic budget (0.55 → 0.95). */
const DEVELOPMENT_TARGET_SPAN = 0.4;
/** Monthly approach fraction toward the target at zero economic budget. */
const DEVELOPMENT_BASE_SPEED = 0.004;
/** Extra monthly approach fraction at a FULL economic budget (≈ 7× base). */
const DEVELOPMENT_SPEED_SPAN = 0.024;

/**
 * Grows every city area the country controls toward a budget-dependent
 * development target at a budget-dependent speed (spec §2: buildings rise
 * faster, infrastructure develops faster). Deterministic; clamped to 0..1.
 */
export function growUrbanDevelopment(state: GameState, countryId: string): void {
  const government = state.government.countries[countryId];
  if (government === undefined) return;
  const economic = government.budget.shares.economic;
  const target = DEVELOPMENT_BASE_TARGET + DEVELOPMENT_TARGET_SPAN * economic;
  const speed = DEVELOPMENT_BASE_SPEED + DEVELOPMENT_SPEED_SPAN * economic;
  for (const area of Object.values(state.cityAreas.network.areas)) {
    if (area.countryId !== countryId) continue;
    const next = area.development + (target - area.development) * speed;
    area.development = Math.min(1, Math.max(0, next));
  }
}

// —— Military Budget → weapon/equipment production (spec §3) ———————————
/** Monthly equipment output at zero military budget (idle arsenals keep ticking). */
const EQUIPMENT_BASE_OUTPUT = 0.2;
/** Extra monthly equipment output at a FULL military budget (0.2 → 1.5). */
const EQUIPMENT_OUTPUT_SPAN = 1.3;
/** Monthly fraction of the recruitment gap closed at zero military budget. */
const ARMY_BASE_GROWTH = 0.0015;
/** Extra monthly fraction at a FULL military budget. */
const ARMY_GROWTH_SPAN = 0.0035;
/** The army expands toward this fraction of total manpower. */
const ARMY_CEILING_FRACTION = 0.6;

/**
 * Produces weapons and equipment for the country, monthly, scaled by the
 * military budget share (spec §3: military production speed ↑ with the
 * military budget). The army also slowly expands toward its ceiling —
 * readiness grows with funding. Deterministic; all domains respected.
 */
export function produceMilitary(state: GameState, countryId: string): void {
  const government = state.government.countries[countryId];
  const country = state.countries.countries[countryId];
  if (government === undefined || country === undefined) return;
  const military = government.budget.shares.military;

  // Equipment: linear output scaled by the military share (0.2 .. 1.5 / month).
  const output = EQUIPMENT_BASE_OUTPUT + EQUIPMENT_OUTPUT_SPAN * military;
  country.military.equipment = Math.max(0, country.military.equipment + output);

  // Recruitment: closes a budget-scaled fraction of the gap to the ceiling.
  const ceiling = country.military.manpower * ARMY_CEILING_FRACTION;
  if (country.military.armySize < ceiling) {
    const rate = ARMY_BASE_GROWTH + ARMY_GROWTH_SPAN * military;
    const next = country.military.armySize + (ceiling - country.military.armySize) * rate;
    country.military.armySize = Math.min(ceiling, Math.max(0, next));
  }
}

/**
 * The productivity-growth modifier of the CURRENT tax level (spec §4/§5:
 * LOW buffs the economy, MEDIUM is neutral, HIGH and MAX penalize it).
 * EconomySimulation folds this into the monthly sector-productivity growth.
 */
export function taxEconomyGrowthOf(state: GameState, countryId: string): number {
  const government = state.government.countries[countryId];
  if (government === undefined) return 0;
  return TAX_LEVEL_SPECS[government.budget.tax].economyGrowth;
}
