/**
 * Budget & Tax effects (Phase 2) — the REAL state consequences of the 100%
 * budget pool and the 3-level tax (spec §2/§3/§9 of the simple economy).
 * Pure functions over GameState, invoked once per campaign month per country
 * by the GovernmentSystem (after the economy cycle, before public opinion).
 *
 *   Economic Budget ↑  → construction/development speed ↑ (city-area
 *                        development grows faster toward a higher target)
 *                        → services money ↑ → population satisfaction ↑
 *   Military Budget ↑  → weapon/equipment production ↑ + army expansion ↑
 *                        (and Economic ↓ — the pool is 100%, so the economic
 *                        effects above weaken by the same amount)
 *   Food shortage      → development target/speed halved (spec §5)
 *
 * Every effect writes REAL state fields (cityAreas development, country
 * military equipment/army) — nothing here is UI decoration.
 *
 * Leaf module: imports only types + the level spec table.
 */

import type { GameState } from '../state/GameState';

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
 * faster, infrastructure develops faster). A FOOD SHORTAGE cuts both target
 * and speed to half (spec §5: کمبود غذا → کاهش توسعه). Deterministic;
 * clamped to 0..1.
 */
export function growUrbanDevelopment(state: GameState, countryId: string): void {
  const government = state.government.countries[countryId];
  if (government === undefined) return;
  const economic = government.budget.shares.economic;
  const record = state.economy.resources[countryId];
  const hungry = record !== undefined && (record.shortage.food ?? 0) > 0;
  const hungerPenalty = hungry ? 0.5 : 1;
  const target = (DEVELOPMENT_BASE_TARGET + DEVELOPMENT_TARGET_SPAN * economic) * hungerPenalty;
  const speed = (DEVELOPMENT_BASE_SPEED + DEVELOPMENT_SPEED_SPAN * economic) * hungerPenalty;
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
/** Output floor when materials are scarce (production slows, never dies). */
const MATERIAL_FLOOR = 0.25;

/**
 * Produces weapons and equipment for the country, monthly, scaled by the
 * military budget share (spec §3) — and gated by REAL materials (spec §9):
 * every equipment unit draws iron/oil/coal/copper from the stockpile. When
 * the stockpile is empty, output slows to the floor until materials arrive
 * (produce them or buy them — the resource loop drives the arsenals).
 * The army also slowly expands toward its ceiling. Deterministic.
 */
export function produceMilitary(state: GameState, countryId: string, militaryMaterials: Readonly<Record<string, number>>): void {
  const government = state.government.countries[countryId];
  const country = state.countries.countries[countryId];
  if (government === undefined || country === undefined) return;
  const military = government.budget.shares.military;

  // Equipment: linear output scaled by the military share (0.2 .. 1.5 / month).
  let output = EQUIPMENT_BASE_OUTPUT + EQUIPMENT_OUTPUT_SPAN * military;

  // —— materials: draw iron/oil/coal/copper from the REAL stockpile ——
  const record = state.economy.resources[countryId];
  if (record !== undefined && Object.keys(militaryMaterials).length > 0) {
    let factor = 1;
    for (const [resourceId, perUnit] of Object.entries(militaryMaterials)) {
      const need = output * perUnit;
      if (need <= 0) continue;
      const available = record.stock[resourceId] ?? 0;
      factor = Math.min(factor, Math.max(MATERIAL_FLOOR, available / need));
    }
    for (const [resourceId, perUnit] of Object.entries(militaryMaterials)) {
      const draw = Math.min(
        record.stock[resourceId] ?? 0,
        Math.ceil(output * factor * perUnit)
      );
      if (draw > 0) record.stock[resourceId] = Math.max(0, Math.round((record.stock[resourceId] ?? 0) - draw));
    }
    output *= factor;
  }

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
 * The tax level's stability side runs through the opinion system
 * (PublicOpinion reads the level's satisfaction) — the money side is the
 * simple tax formula inside the economy cycle (economyCycle.taxIncomeOf).
 */
