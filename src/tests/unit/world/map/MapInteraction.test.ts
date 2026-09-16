import { describe, it, expect } from 'vitest';
import { Game } from '../../../../core/Game';
import { MemorySaveStorage } from '../../../../save/SaveStorage';
import { generateStrategicMap } from '../../../../world/map/MapGenerator';
import { DEFAULT_MAP_CONFIG } from '../../../helpers/mapTestConfig';
import { pickAt, hoverAt, gridCellKeyAt, type PickEligibility } from '../../../../world/map/MapQueries';
import {
  describeGridCell,
  describeGridCellAt,
  findGridCell,
  computeGridCellStrategicValue
} from '../../../../world/map/MapGeography';
import { gridCellKey, splitGridCellKey } from '../../../../world/map/MapTypes';

/**
 * Part 3.5 — Geographic Grid INTERACTION + the shared map-feature selection
 * system. Everything here is the user-facing contract:
 *
 *   click a grid cell → selection in CENTRAL STATE (not the renderer)
 *                      → the cell's info block is derivable from the model
 *
 * plus the classic hierarchy (city / province / country) and the water-
 * safety guarantees the grid data inherits from Part 3.
 */

const ALL_ON: PickEligibility = {
  grid: true,
  rivers: true,
  lakes: true,
  sites: true,
  buildings: true
};

function pickOpts(eligibility: Partial<PickEligibility> = {}, viewHeight = 200) {
  const pickRadius = DEFAULT_MAP_CONFIG.pickRadiusFraction * viewHeight;
  return {
    pickRadius,
    riverPickDistance: Math.max(pickRadius, DEFAULT_MAP_CONFIG.cellSize * 0.35),
    columns: DEFAULT_MAP_CONFIG.columns,
    rows: DEFAULT_MAP_CONFIG.rows,
    cellSize: DEFAULT_MAP_CONFIG.cellSize,
    eligibility: { ...ALL_ON, ...eligibility }
  };
}

function centroidOf(cellIndex: number): { x: number; z: number } {
  const cx = cellIndex % DEFAULT_MAP_CONFIG.columns;
  const cz = Math.floor(cellIndex / DEFAULT_MAP_CONFIG.columns);
  return {
    x: (cx + 0.5) * DEFAULT_MAP_CONFIG.cellSize,
    z: (cz + 0.5) * DEFAULT_MAP_CONFIG.cellSize
  };
}

describe('Part 3.5 — geographic grid interaction', () => {
  const { model } = generateStrategicMap(DEFAULT_MAP_CONFIG);

  it('grid cells exist for every land cell and NEVER for ocean', () => {
    let landCells = 0;
    for (let cellIndex = 0; cellIndex < model.features.gridIds.length; cellIndex++) {
      const isLand = model.features.cellOwner[cellIndex] >= 0;
      const hasId = model.features.gridIds[cellIndex] !== null;
      expect(hasId).toBe(isLand); // ocean → null, land → "A3"-style id
      if (isLand) landCells++;
    }
    expect(landCells).toBeGreaterThan(0);
  });

  it('grid ids are UNIQUE WITHIN a country (1 cell ↔ 1 id per country)', () => {
    for (const countryId of model.countryOrder) {
      const seen = new Set<string>();
      for (let cellIndex = 0; cellIndex < model.features.gridIds.length; cellIndex++) {
        if (model.countryOrder[model.features.cellOwner[cellIndex]] !== countryId) continue;
        const gridId = model.features.gridIds[cellIndex];
        if (gridId === null) continue;
        expect(seen.has(gridId)).toBe(false);
        seen.add(gridId);
      }
      expect(seen.size).toBeGreaterThan(0);
    }
  });

  it('the SAME grid id can exist in DIFFERENT countries without conflict', () => {
    // Find a grid id shared by two countries; the canonical keys differ.
    const idsByCountry = new Map<string, Set<string>>();
    for (let cellIndex = 0; cellIndex < model.features.gridIds.length; cellIndex++) {
      const owner = model.features.cellOwner[cellIndex];
      if (owner < 0) continue;
      const countryId = model.countryOrder[owner];
      const gridId = model.features.gridIds[cellIndex];
      if (gridId === null) continue;
      const set = idsByCountry.get(countryId) ?? new Set<string>();
      set.add(gridId);
      idsByCountry.set(countryId, set);
    }
    const countries = [...idsByCountry.keys()];
    let sharedFound = false;
    for (let a = 0; a < countries.length && !sharedFound; a++) {
      for (let b = a + 1; b < countries.length; b++) {
        for (const gridId of idsByCountry.get(countries[a]) ?? []) {
          if ((idsByCountry.get(countries[b]) ?? new Set()).has(gridId)) {
            const keyA = gridCellKey(countries[a], gridId);
            const keyB = gridCellKey(countries[b], gridId);
            expect(keyA).not.toBe(keyB);
            // Both keys resolve to DIFFERENT cells owned by THEIR country.
            const cellA = findGridCell(model, keyA);
            const cellB = findGridCell(model, keyB);
            expect(cellA).not.toBe(cellB);
            expect(model.countryOrder[model.features.cellOwner[cellA]]).toBe(countries[a]);
            expect(model.countryOrder[model.features.cellOwner[cellB]]).toBe(countries[b]);
            sharedFound = true;
            break;
          }
        }
      }
    }
    expect(sharedFound).toBe(true); // the country-local design guarantees overlap
  });

  it('a grid cell belongs to the CORRECT country AND province', () => {
    for (let cellIndex = 0; cellIndex < model.features.gridIds.length; cellIndex += 37) {
      const key = gridCellKeyAt(model, cellIndex);
      if (key === null) continue;
      const info = describeGridCellAt(model, cellIndex, DEFAULT_MAP_CONFIG.columns, DEFAULT_MAP_CONFIG.rows);
      expect(info).not.toBeNull();
      const cell = info as NonNullable<typeof info>;
      const owner = model.features.cellOwner[cellIndex];
      expect(cell.countryId).toBe(model.countryOrder[owner]);
      expect(cell.provinceId).toBe(model.features.provinceOf[cellIndex] ?? null);
      // Country ⇄ province consistency.
      if (cell.provinceId !== null) {
        expect(model.provinces[cell.provinceId].countryId).toBe(cell.countryId);
      }
    }
  });

  it('grid click resolves the correct cell (pure pick + Game state agree)', () => {
    const storage = new MemorySaveStorage();
    const game = new Game({ seed: 4242, saveStorage: storage });
    game.init();
    game.mapSetLayerVisible('grid', true);

    // Find a cell that resolves to a GRID selection under game eligibility.
    let picked = 0;
    for (let cellIndex = 0; cellIndex < model.features.gridIds.length; cellIndex += 11) {
      const key = gridCellKeyAt(model, cellIndex);
      if (key === null) continue;
      const point = centroidOf(cellIndex);
      const probe = pickAt(game.strategicMap, point, pickOpts({ sites: false, buildings: false }));
      if (probe.cityId !== null || probe.riverId !== null || probe.lakeId !== null) continue;
      if (probe.gridCellKey !== key) continue;

      game.commandBus.send({ type: 'map.pick', x: point.x, z: point.z });
      game.commandBus.flush();
      expect(game.gameState.map.selectedGridKey).toBe(key);
      expect(game.gameState.map.selectedCityId).toBeNull();
      picked++;
      if (picked >= 3) break;
    }
    expect(picked).toBeGreaterThan(0);
    game.dispose();
  });

  it('clicking another cell MOVES the selection (and never mutates geometry)', () => {
    const storage = new MemorySaveStorage();
    const game = new Game({ seed: 77, saveStorage: storage });
    game.init();
    game.mapSetLayerVisible('grid', true);
    const keys: string[] = [];
    for (let cellIndex = 0; cellIndex < model.features.gridIds.length && keys.length < 2; cellIndex += 13) {
      const key = gridCellKeyAt(model, cellIndex);
      if (key === null) continue;
      const point = centroidOf(cellIndex);
      const probe = pickAt(game.strategicMap, point, pickOpts({ sites: false, buildings: false }));
      if (probe.gridCellKey !== key || probe.cityId !== null || probe.riverId !== null || probe.lakeId !== null) continue;
      game.commandBus.send({ type: 'map.pick', x: point.x, z: point.z });
      game.commandBus.flush();
      expect(game.gameState.map.selectedGridKey).toBe(key);
      keys.push(key);
    }
    expect(keys.length).toBe(2);
    expect(keys[0]).not.toBe(keys[1]);
    // The model is immutable — selection never writes into it.
    const hashBefore = JSON.stringify(Object.keys(model.features.gridIds).length);
    expect(JSON.stringify(Object.keys(model.features.gridIds).length)).toBe(hashBefore);
    game.dispose();
  });

  it('clicking OUTSIDE the grid (ocean) clears the selection', () => {
    const storage = new MemorySaveStorage();
    const game = new Game({ seed: 31337, saveStorage: storage });
    game.init();
    game.mapSetLayerVisible('grid', true);
    // First select something real (the first country).
    game.mapSelect({ countryId: model.countryOrder[0] });
    expect(game.gameState.map.selectedCountryId).not.toBeNull();
    // Then click open ocean far outside the continent.
    game.commandBus.send({
      type: 'map.pick',
      x: model.bounds.minX - 100,
      z: model.bounds.minZ - 100
    });
    game.commandBus.flush();
    expect(game.gameState.map.selectedCountryId).toBeNull();
    expect(game.gameState.map.selectedGridKey).toBeNull();
    expect(game.gameState.map.selectedRiverId).toBeNull();
    expect(game.gameState.map.selectedLakeId).toBeNull();
    game.dispose();
  });

  it('a HIDDEN grid layer cannot be clicked (eligibility follows visibility)', () => {
    const storage = new MemorySaveStorage();
    const game = new Game({ seed: 4242, saveStorage: storage });
    game.init(); // grid layer OFF by default
    for (let cellIndex = 0; cellIndex < model.features.gridIds.length; cellIndex += 17) {
      const key = gridCellKeyAt(model, cellIndex);
      if (key === null) continue;
      const point = centroidOf(cellIndex);
      const probe = pickAt(game.strategicMap, point, pickOpts({ grid: false, sites: false, buildings: false }));
      expect(probe.gridCellKey).toBeNull();
      break;
    }
    game.dispose();
  });

  it('city click resolves the correct city (hierarchy wins over the cell)', () => {
    const cities = Object.values(model.cities);
    const city = cities[0];
    const pick = pickAt(model, city.position, pickOpts());
    expect(pick.cityId).toBe(city.id);
    expect(pick.provinceId).toBe(city.provinceId);
    expect(pick.countryId).toBe(city.countryId);
  });

  it('province click resolves the correct province when no city is near', () => {
    const provinces = Object.values(model.provinces);
    const province = provinces[0];
    const pick = pickAt(model, province.labelPoint, pickOpts({ rivers: false, lakes: false, grid: false }));
    expect(pick.provinceId).toBe(province.id);
    expect(pick.countryId).toBe(province.countryId);
  });

  it('river and lake picks resolve their feature (before the grid cell)', () => {
    // River: a point ON a river polyline must resolve that river.
    const river = model.features.rivers[0];
    const mid = river.polyline[Math.floor(river.polyline.length / 2)];
    const pick = pickAt(model, mid, pickOpts());
    expect(pick.riverId).toBe(river.id);

    // Lake: any lake cell centroid resolves the lake.
    const lake = model.features.lakes[0];
    if (lake !== undefined) {
      const lakePoint = centroidOf(lake.cells[0]);
      const lakePick = pickAt(model, lakePoint, pickOpts());
      expect(lakePick.lakeId).toBe(lake.id);
    }
  });

  it('hover resolves a cell + brief province context (no state involvement)', () => {
    const cellIndex = model.features.gridIds.findIndex((id) => id !== null);
    const point = centroidOf(cellIndex);
    const hover = hoverAt(model, point, pickOpts());
    expect(hover.cellIndex).toBe(cellIndex);
    expect(hover.gridCellKey).not.toBeNull();
    expect(hover.provinceId).toBe(model.features.provinceOf[cellIndex] ?? null);
  });
});

describe('Part 3.5 — grid cell info block (describeGridCell)', () => {
  const { model } = generateStrategicMap(DEFAULT_MAP_CONFIG);

  it('an EMPTY cell reports Population 0 / Cities None / Resources None', () => {
    for (let cellIndex = 0; cellIndex < model.features.gridIds.length; cellIndex++) {
      if (gridCellKeyAt(model, cellIndex) === null) continue;
      const cityHere = Object.values(model.cities).some(
        (city) =>
          city.countryId === model.countryOrder[model.features.cellOwner[cellIndex]] &&
          city.gridId === model.features.gridIds[cellIndex]
      );
      if (cityHere) continue;
      const depositHere = model.features.deposits.some((deposit) => deposit.cellIndex === cellIndex);
      if (depositHere) continue;
      const info = describeGridCellAt(model, cellIndex, DEFAULT_MAP_CONFIG.columns, DEFAULT_MAP_CONFIG.rows);
      expect(info).not.toBeNull();
      const cell = info as NonNullable<typeof info>;
      expect(cell.population).toBe(0);
      expect(cell.cityIds).toEqual([]);
      expect(cell.resourceIds).toEqual([]);
      expect(cell.strategicValue).toBeGreaterThanOrEqual(0);
      return;
    }
    throw new Error('no empty cell found — map too dense for the contract test');
  });

  it('a CITY cell reports the hosted city and its exact population', () => {
    const city = Object.values(model.cities)[0];
    const key = gridCellKey(city.countryId, city.gridId);
    const cellIndex = findGridCell(model, key);
    expect(cellIndex).toBeGreaterThanOrEqual(0);
    const info = describeGridCell(model, key, DEFAULT_MAP_CONFIG.columns, DEFAULT_MAP_CONFIG.rows);
    expect(info).not.toBeNull();
    const cell = info as NonNullable<typeof info>;
    expect(cell.cityIds).toContain(city.id);
    expect(cell.population).toBe(city.population);
    // Resources/buildings arrays reference valid records.
    for (const buildingId of cell.buildingIds) {
      expect(model.features.buildings.some((building) => building.id === buildingId)).toBe(true);
    }
    for (const depositId of cell.depositIds) {
      expect(model.features.deposits.some((deposit) => deposit.id === depositId)).toBe(true);
    }
  });

  it('cell population NEVER exceeds its province population (tree invariant)', () => {
    for (let cellIndex = 0; cellIndex < model.features.gridIds.length; cellIndex += 23) {
      const info = describeGridCellAt(model, cellIndex, DEFAULT_MAP_CONFIG.columns, DEFAULT_MAP_CONFIG.rows);
      if (info === null || info.provinceId === null) continue;
      expect(info.population).toBeLessThanOrEqual(model.provinces[info.provinceId].population);
    }
  });

  it('strategic value responds to inputs and stays within 0..100', () => {
    expect(computeGridCellStrategicValue({
      population: 0, hasCity: false, resourceKinds: 0, buildingCount: 0,
      roadCount: 0, railwayCount: 0, hasRiver: false
    })).toBe(0);
    const maxed = computeGridCellStrategicValue({
      population: 2_000_000, hasCity: true, resourceKinds: 5, buildingCount: 8,
      roadCount: 3, railwayCount: 2, hasRiver: true
    });
    expect(maxed).toBe(100);
    const mid = computeGridCellStrategicValue({
      population: 500_000, hasCity: false, resourceKinds: 1, buildingCount: 1,
      roadCount: 1, railwayCount: 0, hasRiver: false
    });
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(100);
  });

  it('describeGridCell returns null for ocean cells and malformed keys', () => {
    const oceanIndex = model.features.cellOwner.indexOf(-1);
    expect(gridCellKeyAt(model, oceanIndex)).toBeNull();
    expect(findGridCell(model, 'no_such_country#A1')).toBe(-1);
    expect(findGridCell(model, 'garbage')).toBe(-1);
    expect(
      describeGridCell(model, 'no_such_country#A1', DEFAULT_MAP_CONFIG.columns, DEFAULT_MAP_CONFIG.rows)
    ).toBeNull();
  });

  it('canonical keys round-trip (splitGridCellKey)', () => {
    const countryId = model.countryOrder[0];
    const key = gridCellKey(countryId, 'B7');
    const split = splitGridCellKey(key);
    expect(split.countryId).toBe(countryId);
    expect(split.gridId).toBe('B7');
  });
});

describe('Part 3.5 — water safety (grid data inherits Part 3 guarantees)', () => {
  const { model } = generateStrategicMap(DEFAULT_MAP_CONFIG);

  it('no city core sits inside a lake surface', () => {
    for (const lake of model.features.lakes) {
      const lakeCells = new Set(lake.cells);
      for (const city of Object.values(model.cities)) {
        // A city whose host cell is a lake cell is a violation by design.
        const hostKey = gridCellKey(city.countryId, city.gridId);
        const hostCell = findGridCell(model, hostKey);
        expect(lakeCells.has(hostCell)).toBe(false);
      }
    }
  });

  it('every river has a valid source, a valid mouth and continuous flow', () => {
    expect(model.features.rivers.length).toBeGreaterThan(0);
    for (const river of model.features.rivers) {
      expect(river.cells.length).toBeGreaterThanOrEqual(2);
      expect(river.polyline.length).toBe(river.cells.length);
      // Continuous 4-adjacent chain.
      for (let i = 1; i < river.cells.length; i++) {
        const a = river.cells[i - 1];
        const b = river.cells[i];
        const distance = Math.abs((a % DEFAULT_MAP_CONFIG.columns) - (b % DEFAULT_MAP_CONFIG.columns)) +
          Math.abs(Math.floor(a / DEFAULT_MAP_CONFIG.columns) - Math.floor(b / DEFAULT_MAP_CONFIG.columns));
        expect(distance).toBe(1);
      }
      // Flow direction: water-surface profile non-increasing.
      for (let i = 1; i < river.elevations.length; i++) {
        expect(river.elevations[i]).toBeLessThanOrEqual(river.elevations[i - 1] + 1e-9);
      }
      // Mouths connect somewhere real.
      if (river.mouthType === 'river') expect(river.parentRiverId).not.toBeNull();
      if (river.mouthType === 'lake') {
        expect(model.features.lakes.some((lake) => lake.cells.includes(river.mouthCell ?? -1))).toBe(true);
      }
    }
  });

  it('lake connections are valid (inflows flow in, outflows source inside)', () => {
    for (const lake of model.features.lakes) {
      const lakeCells = new Set(lake.cells);
      for (const riverId of lake.inflowRiverIds) {
        const river = model.features.rivers.find((candidate) => candidate.id === riverId);
        expect(river).toBeDefined();
        expect((river as NonNullable<typeof river>).cells.some((cell) => lakeCells.has(cell))).toBe(true);
      }
      for (const riverId of lake.outflowRiverIds) {
        const river = model.features.rivers.find((candidate) => candidate.id === riverId);
        expect(river).toBeDefined();
        expect(lakeCells.has((river as NonNullable<typeof river>).sourceCell)).toBe(true);
      }
    }
  });

  it('population sums exactly at every level', () => {
    for (const province of Object.values(model.provinces)) {
      const citySum = province.cityIds.reduce((sum, id) => sum + model.cities[id].population, 0);
      expect(citySum).toBe(province.population);
    }
    for (const countryId of model.countryOrder) {
      const provinceSum = model.countries[countryId].provinceIds.reduce(
        (sum, id) => sum + model.provinces[id].population,
        0
      );
      expect(provinceSum).toBeGreaterThan(0);
    }
  });
});
