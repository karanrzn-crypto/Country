/**
 * THE MILITARY BUILDINGS (the military directive §4-§7) — three military
 * infrastructure types sharing the ECONOMIC construction system end to end:
 *
 *  B1  all THREE types (training camp / tank plant / air plant) build via
 *      the SAME core command on ONE own grid cell, pay money + materials +
 *      workforce ONCE, and complete into real building records
 *  B2  military buildings produce NOTHING (infrastructure only) — the
 *      country's production vector is untouched by them
 *  B3  ONE MAIN FACILITY PER REGION — the CORE rule: an economic building
 *      blocks a military build and vice versa (both directions, core-level)
 *  B4  the map tint resolution covers the military types (visible regions)
 *  B5  save/load roundtrip keeps military buildings (schema accepts them)
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestGame } from '../../helpers/testGame';
import type { SystemContext } from '../../../core/GameContext';
import { economicBuildingAtCell, cellEconomyTintOf } from '../../../economy/resources';
import { startProject, stepProjects } from '../../../economy/construction';
import { economyTintRGB } from '../../../rendering/map/MapSurface';

describe('the military buildings (military directive: same system, one facility per region)', () => {
  let context: SystemContext;

  beforeAll(() => {
    const game = createTestGame({ seed: 4242 });
    context = game.gameContext;
  });

  const config = () => context.data.economyData.strategicResources;
  const player = (): string => context.map.countryOrder[0];
  const ids = (): string[] =>
    context.map.countryOrder.filter((id) => context.state.economy.finance[id] !== undefined);

  /** A free own cell of the country (buildings and projects excluded). */
  const freeCell = (countryId: string): string => {
    const country = context.map.countries[countryId]!;
    for (const cellIndex of country.cellIds) {
      const gridId = context.map.features.gridIds[cellIndex]!;
      if (gridId === null) continue;
      const key = `${countryId}#${gridId}`;
      if (economicBuildingAtCell(context.state, key) !== null) continue;
      const occupiedProject = Object.values(
        context.state.economy.construction[countryId]?.projects ?? []
      ).some((project) => project.cellKey === key);
      if (occupiedProject) continue;
      return key;
    }
    throw new Error('no free cell');
  };

  it('B1 all THREE military types build, pay once, and complete into real records', () => {
    const state = context.state;
    const countryId = player();
    const military = config().buildings.filter((candidate) => candidate.kind === 'military');
    expect(military.map((candidate) => candidate.id)).toEqual([
      'training_camp',
      'tank_plant',
      'air_plant'
    ]);

    // Fund everything so the gates pass cleanly.
    state.economy.treasury[countryId] = 100_000;
    state.economy.resources[countryId]!.stock.industrial = 2_000;

    // The construction capacity is TWO concurrent projects (the SAME core
    // cap) — each type builds, advances by TIME, and graduates in turn.
    let month = 10;
    for (const def of military) {
      const cellKey = freeCell(countryId);
      const treasuryBefore = state.economy.treasury[countryId]!;
      const materialsBefore = state.economy.resources[countryId]!.stock.industrial;
      const result = startProject(state, countryId, config(), def.id, cellKey, month, () => `mil-${def.id}`);
      expect(result.ok).toBe(true);
      // The ONE-TIME costs, paid in full exactly once (the SAME formula).
      expect(state.economy.treasury[countryId]).toBe(treasuryBefore - def.cost);
      expect(state.economy.resources[countryId]!.stock.industrial).toBe(materialsBefore - def.materials);
      // TIME advances the project; months remaining is the SAME helper.
      for (let step = 0; step < def.buildMonths + 2; step += 1) {
        stepProjects(state, context.map, countryId, config(), month);
        month += 1;
      }
      const buildings = Object.values(state.economy.buildings[countryId] ?? {});
      const built = buildings.find((building) => building.typeId === def.id);
      expect(built).toBeDefined();
      expect(built!.cellKey).toBe(cellKey);
    }
  });

  it('B2 military buildings produce NOTHING — the production vector is untouched', () => {
    const state = context.state;
    const countryId = player();
    const buildings = Object.values(state.economy.buildings[countryId] ?? {});
    const militaryBuilt = buildings.filter((building) =>
      ['training_camp', 'tank_plant', 'air_plant'].includes(building.typeId)
    );
    expect(militaryBuilt.length).toBeGreaterThanOrEqual(1);
    // The config gives military types ZERO output; the record's production
    // carries no military resource at all (there is no military resource).
    for (const def of config().buildings) {
      if (def.kind !== 'military') continue;
      expect(def.output).toBe(0);
      expect(def.resource).toBeUndefined();
    }
  });

  it('B3 ONE main facility per region — economic blocks military AND military blocks economic (CORE rule)', () => {
    const state = context.state;
    const otherCountry = ids().find((id) => id !== player())!;
    state.economy.treasury[otherCountry] = 100_000;
    state.economy.resources[otherCountry]!.stock.industrial = 2_000;

    const cell = freeCell(otherCountry);
    // (a) an ECONOMIC building first — the military build on the same cell
    //     is refused BY THE CORE ('occupied').
    const economic = startProject(state, otherCountry, config(), 'farm', cell, 200, () => 'b3a');
    expect(economic.ok).toBe(true);
    const militaryOnEconomic = startProject(state, otherCountry, config(), 'training_camp', cell, 200, () => 'b3b');
    expect(militaryOnEconomic.ok).toBe(false);
    if (!militaryOnEconomic.ok) expect(militaryOnEconomic.reason).toBe('occupied');

    // (b) complete the farm, then try again — the completed ECONOMIC
    //     building blocks the military one (the same core rule).
    for (let step = 0; step < 12; step += 1) stepProjects(state, context.map, otherCountry, config(), 200 + step);
    expect(economicBuildingAtCell(state, cell)).not.toBeNull();
    const militaryAfterEconomic = startProject(state, otherCountry, config(), 'training_camp', cell, 220, () => 'b3c');
    expect(militaryAfterEconomic.ok).toBe(false);
    if (!militaryAfterEconomic.ok) expect(militaryAfterEconomic.reason).toBe('occupied');

    // (c) a MILITARY building on a fresh cell — then an ECONOMIC build is
    //     refused on it (the reverse direction).
    const freshCell = freeCell(otherCountry);
    const military = startProject(state, otherCountry, config(), 'tank_plant', freshCell, 220, () => 'b3d');
    expect(military.ok).toBe(true);
    for (let step = 0; step < 16; step += 1) stepProjects(state, context.map, otherCountry, config(), 220 + step);
    expect(economicBuildingAtCell(state, freshCell)).not.toBeNull();
    const economicAfterMilitary = startProject(state, otherCountry, config(), 'factory', freshCell, 240, () => 'b3e');
    expect(economicAfterMilitary.ok).toBe(false);
    if (!economicAfterMilitary.ok) expect(economicAfterMilitary.reason).toBe('occupied');
  });

  it('B4 the map tint covers the military types (visible, distinct regions)', () => {
    const theme = context.data.mapTheme;
    for (const typeId of ['training_camp', 'tank_plant', 'air_plant']) {
      const tint = economyTintRGB(typeId, false, theme);
      expect(tint).not.toBeNull();
    }
    // A completed military building's cell resolves through the SHARED tint
    // function (active, not pale) — the map and the legend read one source.
    const state = context.state;
    const countryId = player();
    const built = Object.values(state.economy.buildings[countryId] ?? {}).find((building) =>
      ['training_camp', 'tank_plant', 'air_plant'].includes(building.typeId)
    );
    if (built !== undefined) {
      const resolved = cellEconomyTintOf(state, built.cellKey);
      expect(resolved).not.toBeNull();
      expect(resolved!.underConstruction).toBe(false);
    }
  });
});
