/**
 * Country state slice (Part 2) — the Country Data Foundation.
 *
 * One runtime record per strategic-map country, built by joining:
 *   static profiles (src/data/countries.json via DataRegistry)
 *     + generated map geography (capital city join, id space).
 *
 * The slice is JSON-safe, schema-validated, hashed and saved like every other
 * slice. It is deliberately a FOUNDATION: no economy/military/diplomacy
 * simulation runs here — future phases mutate these values (population
 * simulation, treasury ticks, relation events) through mutation helpers
 * exported below.
 *
 * Relations scale is FIXED by architecture:
 *   -100 = hostile … 0 = neutral … +100 = friendly
 * Future diplomacy phases can layer Peace/Alliance/War states on top of this
 * numeric foundation without a data migration.
 *
 * Note: the Phase-0 sim slices (economy/military/diplomacy) serve the legacy
 * demo-world simulation and a different id space. This slice owns the
 * strategic-map countries; unification happens when gameplay phases arrive.
 */

import type { CountryId, CityId } from '../../world/types';
import type { StrategicMapModel } from '../../world/map/MapTypes';
import type { CountryProfileJson, FlagDataJson, ResourceAmountJson } from '../../data/types';

export const RELATION_MIN = -100;
export const RELATION_MAX = 100;

/** Human-readable relation bands (display + future diplomacy hooks). */
export type RelationBand = 'hostile' | 'wary' | 'neutral' | 'cordial' | 'friendly';

/**
 * Runtime economy record of a country — deliberately minimal (spec §10):
 * the static seed treasury. The LIVE money lives in economy.treasury and
 * the monthly ledger in economy.finance; the profile's GDP/income/expenses
 * rows are gone from the runtime model.
 */
export interface CountryEconomyState {
  treasury: number;
}
/**
 * Runtime military record — the static profile's shape but MUTABLE: the
 * budget-driven military production (government/budgetEffects) evolves
 * equipment and army size over the campaign, and future phases may too.
 */
export interface CountryMilitaryState {
  manpower: number;
  armySize: number;
  equipment: number;
  aircraft: number;
  navy: number;
}
export type CountryFlagState = FlagDataJson;

export interface CountryState {
  readonly id: CountryId;
  /** Display name — data-driven from the profile (never renderer-owned). */
  readonly name: string;
  readonly flag: CountryFlagState;
  /**
   * Capital city reference. Origin is the generated map (single geometric
   * truth); mirrored here once at build/load time so every consumer can ask
   * `country.capitalId` without knowing the map model. Re-synced from the
   * live map after save loads (see syncCountryCapitals).
   */
  capitalId: CityId | null;
  /** Non-negative; future population simulation mutates this. */
  population: number;
  economy: CountryEconomyState;
  /** Extensible resource stock: resourceId → amount (≥ 0). */
  resources: ResourceAmountJson;
  military: CountryMilitaryState;
  /** Other country id → relation value in [RELATION_MIN, RELATION_MAX]. */
  foreignRelations: Record<CountryId, number>;
}

export interface CountrySlice {
  readonly countries: Readonly<Record<CountryId, CountryState>>;
}

export function clampRelation(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(RELATION_MAX, Math.max(RELATION_MIN, value));
}

export function relationBand(value: number): RelationBand {
  if (value <= -60) return 'hostile';
  if (value <= -20) return 'wary';
  if (value < 20) return 'neutral';
  if (value < 60) return 'cordial';
  return 'friendly';
}

export interface SliceBuildWarning {
  readonly message: string;
}

/**
 * Fallback profile for a map country without a data-driven profile (e.g. a
 * config with more countries than profiles): deterministic, neutral values
 * derived from the map itself — every country ALWAYS has complete data.
 */
function synthesizedProfile(countryId: string, countryName: string, colorIndex: number): CountryProfileJson {
  const FALLBACK_FLAG_COLORS = ['#7a6a55', '#6f7a55', '#556a7a', '#7a556a'];
  return {
    id: countryId,
    name: countryName,
    flag: {
      layout: 'horizontal-stripes',
      colors: [FALLBACK_FLAG_COLORS[colorIndex % FALLBACK_FLAG_COLORS.length], '#f5efe2'],
      emblem: 'circle',
      emblemColor: '#f0c75e'
    },
    population: 1_500_000,
    economy: { gdp: 25, treasury: 500, income: 12, expenses: 10 },
    resources: {},
    military: { manpower: 50_000, armySize: 20_000, equipment: 20, aircraft: 10, navy: 0 },
    foreignRelations: {}
  };
}

/**
 * Builds the country slice from static profiles + the generated map.
 *
 * - Every map country receives a complete record (missing profiles are
 *   synthesized with a warning — never crash generation for data gaps).
 * - `capitalId` is joined from the map (single geometric truth).
 * - Relations are symmetrized: listing A→B also sets B→A. Conflicting
 *   duplicate declarations keep the first value and warn.
 */
export function buildCountrySlice(
  profiles: readonly CountryProfileJson[],
  model: StrategicMapModel | null,
  onWarning?: (warning: SliceBuildWarning) => void
): CountrySlice {
  const warn = (message: string): void => onWarning?.({ message });
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  const countries: Record<CountryId, CountryState> = {};

  const countryIds: CountryId[] =
    model !== null ? [...model.countryOrder] : [...new Set(profiles.map((profile) => profile.id))];

  for (const countryId of countryIds) {
    const mapCountry = model !== null ? model.countries[countryId] : undefined;
    let profile = profileById.get(countryId);
    if (profile === undefined) {
      if (mapCountry !== undefined) {
        warn(`country "${countryId}" has no data profile — using synthesized defaults`);
        profile = synthesizedProfile(countryId, mapCountry.name, mapCountry.colorIndex);
      } else {
        warn(`country "${countryId}" has neither profile nor map geometry — using minimal defaults`);
        profile = synthesizedProfile(countryId, countryId, 0);
      }
    }

    countries[countryId] = {
      id: countryId,
      // ONE naming source: the map model's name wins when a model exists —
      // the panel, the map labels, cities and provinces must never disagree
      // about who is who (the data profile name is only the model-less
      // fallback).
      name: mapCountry !== undefined ? mapCountry.name : profile.name,
      flag: { ...profile.flag, colors: [...profile.flag.colors] },
      capitalId: mapCountry !== undefined ? mapCountry.capitalCityId : null,
      population: profile.population,
      // Only the seed treasury carries over — GDP/income/expenses are no
      // longer part of the runtime model (spec §10: money is light).
      economy: { treasury: profile.economy.treasury },
      resources: { ...profile.resources },
      military: { ...profile.military },
      foreignRelations: {}
    };
  }

  // —— symmetrized foreign relations ——
  for (const profile of profiles) {
    const source = countries[profile.id];
    if (source === undefined) {
      warn(`profile "${profile.id}" does not match any map country — skipped`);
      continue;
    }
    for (const [otherId, rawValue] of Object.entries(profile.foreignRelations)) {
      if (otherId === profile.id) continue; // registry already rejects this
      const target = countries[otherId];
      if (target === undefined) continue; // registry already rejects this
      const value = clampRelation(rawValue);
      const existing = source.foreignRelations[otherId];
      if (existing !== undefined && existing !== value) {
        warn(`relation ${profile.id}→${otherId} declared twice with different values — keeping ${existing}`);
        continue;
      }
      source.foreignRelations[otherId] = value;
      target.foreignRelations[profile.id] = value;
    }
  }

  return { countries };
}

/**
 * Re-joins capital ids from the live map model. Called after save loads so a
 * save migrated on a different map config still heals to the session's true
 * geography (the map model is immutable per session).
 */
export function syncCountryCapitals(countries: Readonly<Record<CountryId, CountryState>>, model: StrategicMapModel): void {
  for (const [countryId, state] of Object.entries(countries)) {
    const mapCountry = model.countries[countryId];
    (state as { capitalId: CityId | null }).capitalId = mapCountry !== undefined ? mapCountry.capitalCityId : null;
  }
}

/**
 * Sets a relation symmetrically (clamped to the fixed scale). The ONE future
 * mutation path for diplomacy systems — kept in the slice module so the
 * invariant (A→B === B→A) is enforced at the write site.
 */
export function setForeignRelation(
  slice: CountrySlice,
  a: CountryId,
  b: CountryId,
  value: number
): void {
  if (a === b) return;
  const source = slice.countries[a];
  const target = slice.countries[b];
  if (source === undefined || target === undefined) return;
  const clamped = clampRelation(value);
  source.foreignRelations[b] = clamped;
  target.foreignRelations[a] = clamped;
}

/** Total population across all countries (info/debug). */
export function totalPopulation(slice: CountrySlice): number {
  return Object.values(slice.countries).reduce((sum, country) => sum + country.population, 0);
}
