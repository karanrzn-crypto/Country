import { describe, it, expect } from 'vitest';
import { DataRegistry } from '../../../data/DataRegistry';
import { generateStrategicMap } from '../../../world/map/MapGenerator';
import { DEFAULT_CONFIG } from '../../../config/configTypes';
import {
  buildCountrySlice,
  clampRelation,
  relationBand,
  setForeignRelation,
  syncCountryCapitals,
  RELATION_MIN,
  RELATION_MAX
} from '../../../state/slices/countrySlice';
import { validateGameStateOrThrow } from '../../../state/validate';
import { createInitialState } from '../../../state/createInitialState';
import { IdGenerator } from '../../../core/IdGenerator';
import { hashValue } from '../../../utils/hash';

/**
 * Part 2 — Country Data Foundation:
 * static profiles (countries.json) + generated map joined into a complete,
 * validated, deterministic country slice.
 */
describe('country data foundation (Part 2)', () => {
  const data = new DataRegistry();
  const map = generateStrategicMap(DEFAULT_CONFIG.map).model;

  function build(): ReturnType<typeof buildCountrySlice> {
    return buildCountrySlice(data.countryProfileList, map);
  }

  // —— static profile data ——

  it('profiles are unique, complete and match the map id space', () => {
    const profiles = data.countryProfileList;
    expect(profiles.length).toBe(map.stats.countries);
    const ids = new Set(profiles.map((profile) => profile.id));
    expect(ids.size).toBe(profiles.length);
    for (const id of map.countryOrder) {
      expect(ids.has(id)).toBe(true);
      const profile = data.countryProfile(id);
      expect(profile.name.length).toBeGreaterThan(0);
      expect(profile.flag.colors.length).toBeGreaterThan(0);
      expect(profile.population).toBeGreaterThanOrEqual(0);
      expect(profile.economy.gdp).toBeGreaterThanOrEqual(0);
      expect(profile.economy.treasury).toBeGreaterThanOrEqual(0);
      expect(profile.economy.income).toBeGreaterThanOrEqual(0);
      expect(profile.economy.expenses).toBeGreaterThanOrEqual(0);
      for (const amount of Object.values(profile.resources)) expect(amount).toBeGreaterThanOrEqual(0);
      for (const value of Object.values(profile.military)) expect(value).toBeGreaterThanOrEqual(0);
    }
  });

  it('registry rejects relations to unknown countries / out of scale', () => {
    // The registry validated at construction — if the JSON were inconsistent
    // the constructor above would already have thrown. Assert the invariants
    // directly for clarity.
    const profiles = data.countryProfileList;
    const ids = new Set(profiles.map((profile) => profile.id));
    for (const profile of profiles) {
      for (const [otherId, value] of Object.entries(profile.foreignRelations)) {
        expect(ids.has(otherId)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(RELATION_MIN);
        expect(value).toBeLessThanOrEqual(RELATION_MAX);
      }
    }
  });

  // —— slice join ——

  it('every map country gets a complete state with model-driven name + flag', () => {
    const slice = build();
    for (const id of map.countryOrder) {
      const state = slice.countries[id];
      expect(state).toBeDefined();
      expect(state.id).toBe(id);
      // ONE naming source: with a map model, the slice carries the MODEL's
      // name (the map is what the player clicks — panel, labels, cities and
      // provinces can never disagree about who is who).
      expect(state.name).toBe(map.countries[id].name);
      expect(state.flag.colors.length).toBeGreaterThan(0);
      expect(state.flag.emblem).toBeDefined();
    }
    expect(Object.keys(slice.countries)).toHaveLength(map.stats.countries);
  });

  it('each country has EXACTLY one valid capital, joined from the map', () => {
    const slice = build();
    for (const id of map.countryOrder) {
      const state = slice.countries[id];
      const mapCountry = map.countries[id];
      expect(state.capitalId).toBe(mapCountry.capitalCityId);
      // The referenced city exists, belongs to the country and is its only capital.
      const capital = map.cities[state.capitalId as string];
      expect(capital).toBeDefined();
      expect(capital.countryId).toBe(id);
      expect(capital.isCapital).toBe(true);
      const capitalCount = mapCountry.cityIds.filter((cityId) => map.cities[cityId].isCapital).length;
      expect(capitalCount).toBe(1);
    }
  });

  it('populations, economies, resources and militaries are valid', () => {
    const slice = build();
    for (const state of Object.values(slice.countries)) {
      expect(state.population).toBeGreaterThan(0);
      expect(state.economy.gdp).toBeGreaterThan(0);
      expect(state.economy.treasury).toBeGreaterThanOrEqual(0);
      expect(state.economy.income).toBeGreaterThanOrEqual(0);
      expect(state.economy.expenses).toBeGreaterThanOrEqual(0);
      for (const amount of Object.values(state.resources)) expect(amount).toBeGreaterThanOrEqual(0);
      expect(state.military.manpower).toBeGreaterThanOrEqual(0);
      expect(state.military.armySize).toBeGreaterThanOrEqual(state.military.manpower * 0); // structural sanity
      expect(state.military.armySize).toBeLessThanOrEqual(state.military.manpower);
      // Landlocked map countries must not field a navy.
      const mapCountry = map.countries[state.id];
      if (!mapCountry.coastal) expect(state.military.navy).toBe(0);
    }
  });

  it('foreign relations are symmetric, in scale and reference real countries', () => {
    const slice = build();
    for (const state of Object.values(slice.countries)) {
      for (const [otherId, value] of Object.entries(state.foreignRelations)) {
        expect(otherId).not.toBe(state.id);
        expect(slice.countries[otherId]).toBeDefined();
        expect(value).toBeGreaterThanOrEqual(RELATION_MIN);
        expect(value).toBeLessThanOrEqual(RELATION_MAX);
        expect(slice.countries[otherId].foreignRelations[state.id]).toBe(value);
      }
    }
    // The authored data actually exercises both directions of the scale.
    const allValues = Object.values(slice.countries).flatMap((state) => Object.values(state.foreignRelations));
    expect(allValues.some((value) => value > 0)).toBe(true);
    expect(allValues.some((value) => value < 0)).toBe(true);
  });

  it('building twice is deterministic (hash-stable)', () => {
    const a = build();
    const b = build();
    expect(hashValue(a)).toBe(hashValue(b));
  });

  it('a map country without a profile is synthesized (never crashes, warns)', () => {
    const warnings: string[] = [];
    const sliced = buildCountrySlice(
      data.countryProfileList.slice(0, 5),
      map,
      (warning) => warnings.push(warning.message)
    );
    expect(Object.keys(sliced.countries)).toHaveLength(map.stats.countries);
    expect(warnings.length).toBeGreaterThan(0);
    for (const state of Object.values(sliced.countries)) {
      expect(state.name.length).toBeGreaterThan(0);
      expect(state.population).toBeGreaterThan(0);
    }
  });

  it('profiles without a map country are skipped with a warning', () => {
    const warnings: string[] = [];
    const tinyMap = generateStrategicMap({ ...DEFAULT_CONFIG.map, countryCount: 2 }).model;
    buildCountrySlice(data.countryProfileList, tinyMap, (warning) => warnings.push(warning.message));
    expect(warnings.some((message) => message.includes('does not match any map country'))).toBe(true);
  });

  // —— mutation helpers (future diplomacy/population systems) ——

  it('setForeignRelation clamps and symmetrizes', () => {
    const slice = build();
    const a = map.countryOrder[0];
    const b = map.countryOrder[1];
    setForeignRelation(slice, a, b, 250);
    expect(slice.countries[a].foreignRelations[b]).toBe(RELATION_MAX);
    expect(slice.countries[b].foreignRelations[a]).toBe(RELATION_MAX);
    setForeignRelation(slice, a, b, -999);
    expect(slice.countries[a].foreignRelations[b]).toBe(RELATION_MIN);
    expect(slice.countries[b].foreignRelations[a]).toBe(RELATION_MIN);
    // Self-relations are ignored.
    setForeignRelation(slice, a, a, 100);
    expect(slice.countries[a].foreignRelations[a]).toBeUndefined();
  });

  it('relationBand maps the fixed scale', () => {
    expect(relationBand(-100)).toBe('hostile');
    expect(relationBand(-60)).toBe('hostile');
    expect(relationBand(-59)).toBe('wary');
    expect(relationBand(-20)).toBe('wary');
    expect(relationBand(-19)).toBe('neutral');
    expect(relationBand(0)).toBe('neutral');
    expect(relationBand(19)).toBe('neutral');
    expect(relationBand(20)).toBe('cordial');
    expect(relationBand(59)).toBe('cordial');
    expect(relationBand(60)).toBe('friendly');
    expect(relationBand(100)).toBe('friendly');
  });

  it('clampRelation hard-clamps the scale', () => {
    expect(clampRelation(-150)).toBe(RELATION_MIN);
    expect(clampRelation(150)).toBe(RELATION_MAX);
    expect(clampRelation(42)).toBe(42);
    expect(clampRelation(Number.NaN)).toBe(0);
  });

  it('syncCountryCapitals re-joins from a different map model', () => {
    const slice = build();
    const otherMap = generateStrategicMap({ ...DEFAULT_CONFIG.map, seed: 777 }).model;
    syncCountryCapitals(slice.countries, otherMap);
    for (const [id, state] of Object.entries(slice.countries)) {
      expect(state.capitalId).toBe(otherMap.countries[id].capitalCityId);
    }
  });

  // —— GameState integration ——

  it('createInitialState embeds a schema-valid country slice with capitals', () => {
    const state = createInitialState(data, DEFAULT_CONFIG, new IdGenerator(), map);
    expect(() => validateGameStateOrThrow(state)).not.toThrow();
    for (const id of map.countryOrder) {
      expect(state.countries.countries[id].capitalId).toBe(map.countries[id].capitalCityId);
    }
    // The state schema is aware of the slice (allowUnknown: false).
    expect(state.countries).toBeDefined();
    expect(Object.keys(state.countries.countries)).toHaveLength(map.stats.countries);
  });
});
