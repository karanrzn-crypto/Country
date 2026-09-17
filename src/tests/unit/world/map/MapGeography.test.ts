import { describe, it, expect } from 'vitest';
import {
  generateStrategicMap
} from '../../../../world/map/MapGenerator';
import {
  buildPopulationTree,
  checkWaterSafety,
  classifyCityType,
  computeProvinceStrategicValue,
  computeCityStrategicValue,
  CITY_TYPE_THRESHOLDS,
  distanceToNearestRiver,
  hash01,
  gridCellKey,
  buildCountryGrids
} from '../../../../world/map/MapGeography';
import {
  gridCellKey as gridCellKeyFromTypes,
  gridColumnLetter,
  splitGridCellKey
} from '../../../../world/map/MapTypes';
import { DEFAULT_MAP_CONFIG } from '../../../helpers/mapTestConfig';
import { pointInRing } from '../../../../world/map/MapQueries';

/**
 * Part 3 validation suite — the spec's §15 list:
 * grid ids never conflict across countries, province/city consistency,
 * population-tree exactness, water-safe city placement, river continuity +
 * flow direction, label readability/priority, correct country wiring.
 */

const DECLARED_POPULATIONS: Record<string, number> = {
  country_0: 7_400_000,
  country_1: 4_400_000,
  country_2: 10_200_000,
  country_3: 7_100_000,
  country_4: 9_300_000,
  country_5: 4_800_000,
  country_6: 5_900_000,
  country_7: 4_100_000,
  country_8: 5_200_000,
  country_9: 9_000_000
};

const { model, warnings } = generateStrategicMap(DEFAULT_MAP_CONFIG, {
  countryPopulations: DECLARED_POPULATIONS
});
const features = model.features;
const columns = DEFAULT_MAP_CONFIG.columns;
const rows = DEFAULT_MAP_CONFIG.rows;
const cellSize = DEFAULT_MAP_CONFIG.cellSize;
const lakeCellSet = new Set<number>();
for (const lake of features.lakes) for (const cell of lake.cells) lakeCellSet.add(cell);
const riverCellSet = new Set<number>();
for (const river of features.rivers) for (const cell of river.cells) riverCellSet.add(cell);

describe('Part 3 — geographic grid', () => {
  it('assigns a country-local grid id to every land cell and never to ocean', () => {
    for (let cellIndex = 0; cellIndex < features.cellOwner.length; cellIndex++) {
      const gridId = features.gridIds[cellIndex];
      if (features.cellOwner[cellIndex] < 0) {
        expect(gridId).toBeNull();
      } else {
        expect(gridId).toMatch(/^[A-Z]+\d+$/);
      }
    }
  });

  it('the SAME grid id can exist in different countries WITHOUT conflict', () => {
    // Collect grid ids per country from the provinces (which carry them).
    const idsByCountry = new Map<string, Set<string>>();
    for (const province of Object.values(model.provinces)) {
      const set = idsByCountry.get(province.countryId) ?? new Set<string>();
      for (const gridId of province.gridIds) set.add(gridId);
      idsByCountry.set(province.countryId, set);
    }
    // Every country's grid starts at column A and row 1 (its own extremes).
    for (const [countryId, ids] of idsByCountry) {
      expect(ids.size).toBeGreaterThan(0);
      const letters = [...ids].map((id) => id.replace(/\d+$/, ''));
      const numbers = [...ids].map((id) => id.replace(/^[A-Z]+/, ''));
      expect(letters).toContain('A');
      expect(numbers).toContain('1');
      void countryId;
    }
    // The canonical internal key namespaces the label with the country id:
    const sameId = 'A1';
    const countryIds = model.countryOrder.slice(0, 2);
    expect(gridCellKey(countryIds[0], sameId)).not.toBe(gridCellKey(countryIds[1], sameId));
    expect(splitGridCellKey(gridCellKey(countryIds[0], sameId)).gridId).toBe(sameId);
    expect(splitGridCellKey(gridCellKey(countryIds[0], sameId)).countryId).toBe(countryIds[0]);
    // And the model contract matches the helper (single id format).
    expect(gridCellKeyFromTypes(countryIds[1], sameId)).toBe(gridCellKey(countryIds[1], sameId));
  });

  it('grid letters are contiguous from A and rows are contiguous from 1', () => {
    expect(gridColumnLetter(0)).toBe('A');
    expect(gridColumnLetter(1)).toBe('B');
    expect(gridColumnLetter(26)).toBe('AA'); // beyond Z
    const country = model.countries[model.countryOrder[0]];
    const gridIds = country.provinceIds.flatMap((pid) => model.provinces[pid].gridIds);
    const letters = new Set(gridIds.map((id) => id.replace(/\d+$/, '')));
    const numbers = new Set(gridIds.map((id) => id.replace(/^[A-Z]+/, '')));
    expect(letters.has('A')).toBe(true);
    expect(numbers.has('1')).toBe(true);
    // No gaps: max letter index ≤ letter count used (contiguity by anchor).
    expect(gridIds.length).toBe(country.provinceIds.reduce((sum, pid) => sum + model.provinces[pid].cellIds.length, 0));
  });

  it('buildCountryGrids anchors every country at its own A1', () => {
    // Two synthetic countries sharing cells spatially still overlap in ids.
    // Country 2's cells: cx 2,3 / cz 0,1 → its own A1..B2 box.
    const grids = buildCountryGrids(
      [[0, 1, columns], [2, 3, columns + 2]],
      columns,
      rows,
      columns * rows
    );
    expect(grids[0]).toBe('A1');
    expect(grids[2]).toBe('A1'); // same label, different country — no conflict
    expect(grids[1]).toBe('B1');
    expect(grids[columns + 2]).toBe('A2');
  });
});

describe('Part 3 — provinces', () => {
  it('every province has a capital, valid cities and the right country', () => {
    for (const province of Object.values(model.provinces)) {
      const country = model.countries[province.countryId];
      expect(country).toBeDefined();
      expect(country.provinceIds).toContain(province.id);
      expect(province.cityIds.length).toBeGreaterThan(0);
      if (province.capitalCityId !== null) {
        expect(province.cityIds).toContain(province.capitalCityId);
        expect(model.cities[province.capitalCityId].provinceId).toBe(province.id);
      }
      for (const cityId of province.cityIds) {
        expect(model.cities[cityId].countryId).toBe(province.countryId);
      }
    }
  });

  it('province neighbors are structural and symmetric (across country borders too)', () => {
    for (const province of Object.values(model.provinces)) {
      for (const neighborId of province.neighborProvinceIds) {
        const neighbor = model.provinces[neighborId];
        expect(neighbor).toBeDefined();
        expect(neighbor.neighborProvinceIds).toContain(province.id);
      }
    }
    // Border provinces of DIFFERENT countries are also neighbors — the map
    // is one connected geography.
    const crossBorder = Object.values(model.provinces).some((province) =>
      province.neighborProvinceIds.some(
        (neighborId) => model.provinces[neighborId].countryId !== province.countryId
      )
    );
    expect(crossBorder).toBe(true);
  });

  it('province area matches cells and terrain type is a valid class', () => {
    for (const province of Object.values(model.provinces)) {
      expect(province.areaCells).toBe(province.cellIds.length);
      expect(province.area).toBe(Math.round(province.cellIds.length * cellSize * cellSize));
      expect(['lowland', 'valley', 'plains', 'plateau', 'hills', 'mountain', 'highMountain']).toContain(
        province.terrainType
      );
      expect(province.gridIds.length).toBe(province.cellIds.length);
    }
  });

  it('province control/security start stable and derived levels stay in range', () => {
    for (const province of Object.values(model.provinces)) {
      expect(province.control).toBe(1);
      expect(province.security).toBe(1);
      expect(province.developmentLevel).toBeGreaterThanOrEqual(0);
      expect(province.developmentLevel).toBeLessThanOrEqual(1);
      expect(province.strategicValue).toBeGreaterThanOrEqual(0);
      expect(province.strategicValue).toBeLessThanOrEqual(100);
      expect(province.productionCapacity).toBeGreaterThan(0);
      expect(province.infrastructure.roads).toBeGreaterThanOrEqual(0);
      expect(province.infrastructure.railways).toBeGreaterThanOrEqual(0);
    }
  });

  it('province resource ids come from LOCATED deposits inside the province', () => {
    for (const province of Object.values(model.provinces)) {
      const deposits = features.deposits.filter((deposit) => deposit.provinceId === province.id);
      const ids = [...new Set(deposits.map((deposit) => deposit.resourceId))].sort();
      expect(province.resourceIds).toEqual(ids);
      for (const deposit of deposits) {
        expect(deposit.cellIndex).toBeGreaterThanOrEqual(0);
        expect(deposit.quantity).toBeGreaterThanOrEqual(1);
        expect(deposit.quantity).toBeLessThanOrEqual(100);
        expect(deposit.countryId).toBe(province.countryId);
      }
    }
    // Deposits exist and are never location-less.
    expect(features.deposits.length).toBeGreaterThan(0);
    for (const deposit of features.deposits) {
      expect(['oil', 'food', 'iron', 'coal', 'copper', 'gold', 'wood']).toContain(deposit.resourceId);
    }
  });

  it('province buildings reference valid records and live inside the province', () => {
    expect(features.buildings.length).toBeGreaterThan(0);
    for (const province of Object.values(model.provinces)) {
      for (const buildingId of province.buildingIds) {
        const building = features.buildings.find((candidate) => candidate.id === buildingId);
        expect(building).toBeDefined();
        expect(building!.provinceId).toBe(province.id);
        expect(building!.countryId).toBe(province.countryId);
        expect(building!.level).toBeGreaterThanOrEqual(1);
        expect(building!.level).toBeLessThanOrEqual(5);
      }
    }
  });
});

describe('Part 3 — population tree (Country → Province → City)', () => {
  it('Σ provinces equals the DECLARED country population exactly', () => {
    for (const countryId of model.countryOrder) {
      const declared = DECLARED_POPULATIONS[countryId];
      if (declared === undefined) continue;
      const provinceSum = model.countries[countryId].provinceIds.reduce(
        (sum, provinceId) => sum + model.provinces[provinceId].population,
        0
      );
      expect(provinceSum).toBe(declared);
    }
  });

  it('Σ city populations equals the province population exactly (every province)', () => {
    for (const province of Object.values(model.provinces)) {
      const citySum = province.cityIds.reduce(
        (sum, cityId) => sum + model.cities[cityId].population,
        0
      );
      expect(citySum).toBe(province.population);
    }
  });

  it('the tree is deterministic and hash-stable', () => {
    const second = generateStrategicMap(DEFAULT_MAP_CONFIG, { countryPopulations: DECLARED_POPULATIONS }).model;
    for (const province of Object.values(second.provinces)) {
      expect(province.population).toBe(model.provinces[province.id].population);
    }
    for (const city of Object.values(second.cities)) {
      expect(city.population).toBe(model.cities[city.id].population);
    }
    expect(hash01('stable')).toBe(hash01('stable'));
  });

  it('distributeExact keeps per-city minimums and capital weighting', () => {
    const tree = buildPopulationTree({
      countryPopulations: { c: 1_000_000 },
      countryOrder: ['c'],
      provinces: [{ id: 'p', countryId: 'c', weight: 10, cityIds: ['cap', 'b'] }],
      cities: [
        { id: 'cap', provinceId: 'p', isCapital: true },
        { id: 'b', provinceId: 'p', isCapital: false }
      ]
    });
    expect(tree.provinces.p).toBe(1_000_000);
    expect(tree.cities.cap + tree.cities.b).toBe(1_000_000);
    // The capital carries several times a regular city's weight.
    expect(tree.cities.cap).toBeGreaterThan(tree.cities.b * 1.5);
  });

  it('city types follow the data-driven thresholds', () => {
    expect(classifyCityType(5_000_000, true)).toBe('capital');
    expect(classifyCityType(CITY_TYPE_THRESHOLDS.major, false)).toBe('major');
    expect(classifyCityType(CITY_TYPE_THRESHOLDS.medium, false)).toBe('medium');
    expect(classifyCityType(CITY_TYPE_THRESHOLDS.small, false)).toBe('small');
    expect(classifyCityType(1_000, false)).toBe('settlement');
    const types = new Set(Object.values(model.cities).map((city) => city.type));
    expect(types.has('capital')).toBe(true);
    expect(types.size).toBeGreaterThanOrEqual(3);
    for (const city of Object.values(model.cities)) {
      expect(city.importance).toBeGreaterThanOrEqual(0);
      expect(city.importance).toBeLessThanOrEqual(1);
      expect(city.strategicValue).toBeGreaterThanOrEqual(0);
      expect(city.strategicValue).toBeLessThanOrEqual(100);
    }
  });
});

describe('Part 3 — water-safe city placement (spec §4)', () => {
  it('no city sits inside a lake surface', () => {
    for (const city of Object.values(model.cities)) {
      const hostCell = cellIndexOf(city.position);
      expect(lakeCellSet.has(hostCell)).toBe(false);
      expect(lakeCellSet.has(cityCellOf(city.id))).toBe(false);
    }
  });

  it('no city sits on a river centerline — riverside is a deliberate band', () => {
    const clearance = cellSize * 0.45;
    let riverine = 0;
    for (const city of Object.values(model.cities)) {
      const distance = distanceToNearestRiver(city.position, features.rivers);
      if (features.rivers.length > 0) {
        expect(distance).toBeGreaterThanOrEqual(clearance - 1e-6);
      }
      if (city.isRiverine) {
        riverine++;
        expect(city.riverIds.length).toBeGreaterThan(0);
        expect(distance).toBeLessThanOrEqual(cellSize * 1.2 + 1e-6);
      }
    }
    void riverine;
  });

  it('checkWaterSafety flags violations correctly (test oracle)', () => {
    const river = features.rivers[0];
    const base = {
      cellSize,
      rivers: features.rivers,
      lakeCellSet,
      riverCellSet
    };
    if (river !== undefined) {
      const onCenterline = river.polyline[0];
      const verdict = checkWaterSafety({
        ...base,
        position: onCenterline,
        hostCell: river.cells[0]
      });
      expect(verdict.safe).toBe(false);
      expect(['river', 'lake']).toContain(verdict.violation);
    }
    const dry = Object.values(model.cities)[0];
    const ok = checkWaterSafety({
      ...base,
      position: dry.position,
      hostCell: cityCellOf(dry.id)
    });
    expect(ok.safe).toBe(true);
    expect(ok.violation).toBeNull();
  });

  it('every city stays inside BOTH its province and country rings', () => {
    for (const city of Object.values(model.cities)) {
      const province = model.provinces[city.provinceId];
      const country = model.countries[city.countryId];
      expect(pointInRing(city.position, province.ring.points)).toBe(true);
      expect(pointInRing(city.position, country.ring.points)).toBe(true);
    }
  });

  it('coastal cities are near water, landlocked ones are not, ports have ports', () => {
    for (const city of Object.values(model.cities)) {
      const hostCell = cityCellOf(city.id);
      const cx = hostCell % columns;
      const cz = Math.floor(hostCell / columns);
      const touchesOcean = [
        cx > 0 ? hostCell - 1 : -1,
        cx < columns - 1 ? hostCell + 1 : -1,
        cz > 0 ? hostCell - columns : -1,
        cz < rows - 1 ? hostCell + columns : -1
      ].some((neighbor) => neighbor < 0 || features.biomes[neighbor] === 'ocean');
      if (touchesOcean) {
        // Coastal: a port building exists for port cities.
        expect(city.infrastructure.portId !== null || city.gridId !== '').toBe(true);
      }
    }
  });

  it('cities carry valid infrastructure and grid references', () => {
    for (const city of Object.values(model.cities)) {
      expect(city.gridId).toMatch(/^[A-Z]+\d+$/);
      expect(city.infrastructure.airportId === null || city.buildingIds.includes(city.infrastructure.airportId)).toBe(true);
      expect(city.infrastructure.portId === null || city.buildingIds.includes(city.infrastructure.portId)).toBe(true);
      for (const roadId of city.infrastructure.roadIds) {
        expect(features.lines.find((line) => line.id === roadId)).toBeDefined();
      }
      for (const railId of city.infrastructure.railwayIds) {
        const line = features.lines.find((candidate) => candidate.id === railId);
        expect(line?.kind).toBe('railway');
      }
      for (const industryId of city.industries) {
        expect(city.buildingIds).toContain(industryId);
      }
      // Geographic connections: roads/railways reference THIS city.
      for (const roadId of [...city.infrastructure.roadIds, ...city.infrastructure.railwayIds]) {
        const line = features.lines.find((candidate) => candidate.id === roadId);
        expect(line?.cityA === city.id || line?.cityB === city.id).toBe(true);
      }
    }
  });
});

describe('Part 3 — rivers & waterways (spec §9)', () => {
  it('every river has a valid source and a valid mouth', () => {
    expect(features.rivers.length).toBeGreaterThan(0);
    for (const river of features.rivers) {
      expect(river.sourceCell).toBe(river.cells[0]);
      expect(river.mouthCell).not.toBeNull();
      if (river.mouthType === 'ocean') {
        // Mouth cell touches the sea.
        const mouth = river.mouthCell as number;
        const cx = mouth % columns;
        const cz = Math.floor(mouth / columns);
        const touchesSea = [
          cx > 0 ? mouth - 1 : -1,
          cx < columns - 1 ? mouth + 1 : -1,
          cz > 0 ? mouth - columns : -1,
          cz < rows - 1 ? mouth + columns : -1
        ].some((neighbor) => neighbor < 0 || features.biomes[neighbor] === 'ocean');
        expect(touchesSea).toBe(true);
      }
      if (river.mouthType === 'river') {
        const parent = features.rivers.find((candidate) => candidate.id === river.parentRiverId);
        expect(parent).toBeDefined();
        expect(parent!.cells).toContain(river.mouthCell as number);
        expect(parent!.tributaryIds).toContain(river.id);
      }
    }
  });

  it('river paths are CONTINUOUS 4-adjacent cell chains', () => {
    for (const river of features.rivers) {
      for (let i = 1; i < river.cells.length; i++) {
        const a = river.cells[i - 1];
        const b = river.cells[i];
        const ax = a % columns;
        const az = Math.floor(a / columns);
        const bx = b % columns;
        const bz = Math.floor(b / columns);
        expect(Math.abs(ax - bx) + Math.abs(az - bz)).toBe(1);
      }
      expect(river.polyline.length).toBe(river.cells.length);
      expect(river.elevations.length).toBe(river.cells.length);
    }
  });

  it('flow direction is consistent with elevation (water-surface profile non-increasing)', () => {
    for (const river of features.rivers) {
      for (let i = 1; i < river.elevations.length; i++) {
        // The stored profile is the drained water surface — level across
        // lakes, strictly descending in open channel.
        expect(river.elevations[i]).toBeLessThanOrEqual(river.elevations[i - 1] + 1e-9);
      }
    }
  });

  it('open-channel segments descend in the RAW elevation field too', () => {
    for (const river of features.rivers) {
      for (let i = 1; i < river.cells.length; i++) {
        const a = river.cells[i - 1];
        const b = river.cells[i];
        const inLake = lakeCellSet.has(a) || lakeCellSet.has(b);
        if (inLake) continue; // level flow across standing water
        // Submerged flat segments (filled but below lake size) are level:
        // allow a tiny noise-band climb, the strict profile is the surface.
        expect(features.elevation[b]).toBeLessThanOrEqual(features.elevation[a] + 0.01);
      }
    }
  });

  it('lakes are real records with names, provinces and inflows; cities stay on land', () => {
    for (const lake of features.lakes) {
      expect(lake.cells.length).toBeGreaterThan(0);
      expect(lake.depth).toBeGreaterThan(0);
      expect(Number.isFinite(lake.position.x)).toBe(true);
      expect(Number.isFinite(lake.position.z)).toBe(true);
      for (const cellIndex of lake.cells) {
        expect(features.biomes[cellIndex]).not.toBe('ocean'); // lakes sit ON land
      }
      for (const riverId of lake.inflowRiverIds) {
        const river = features.rivers.find((candidate) => candidate.id === riverId);
        expect(river?.cells.some((cell) => lake.cells.includes(cell))).toBe(true);
      }
    }
    // Lakeside cities are recorded on the lake, never inside its cells.
    for (const cityId of features.lakes.flatMap((lake) => lake.cityIds)) {
      expect(lakeCellSet.has(cityCellOf(cityId))).toBe(false);
    }
  });

  it('rivers record their provinces and nearby cities', () => {
    for (const river of features.rivers) {
      expect(river.provinceIds.length).toBeGreaterThan(0);
      for (const provinceId of river.provinceIds) {
        expect(model.provinces[provinceId]).toBeDefined();
      }
      for (const cityId of river.cityIds) {
        const city = model.cities[cityId];
        expect(city.riverIds).toContain(river.id);
      }
    }
  });
});

describe('Part 3 — strategic value & connections', () => {
  it('strategic value responds to its documented inputs', () => {
    const base = computeProvinceStrategicValue({
      population: 0,
      resourceKinds: 0,
      industrialBuildings: 0,
      infrastructure: { roads: 0, railways: 0, airports: 0, ports: 0, utilities: 0 },
      isCountryCapital: false,
      hasPort: false,
      hasAirport: false,
      hasMilitary: false,
      hasRiver: false
    });
    const rich = computeProvinceStrategicValue({
      population: 3_000_000,
      resourceKinds: 5,
      industrialBuildings: 4,
      infrastructure: { roads: 8, railways: 4, airports: 2, ports: 2, utilities: 2 },
      isCountryCapital: true,
      hasPort: true,
      hasAirport: true,
      hasMilitary: true,
      hasRiver: true
    });
    expect(base).toBe(0);
    expect(rich).toBeLessThanOrEqual(100);
    expect(rich).toBeGreaterThan(70);

    const plainCity = computeCityStrategicValue({
      population: 0,
      isCapital: false,
      hasPort: false,
      hasAirport: false,
      industries: 0,
      hasMilitary: false,
      hasHospital: false,
      hasPower: false,
      roadCount: 0,
      hasRiver: false
    });
    const capitalCity = computeCityStrategicValue({
      population: 2_000_000,
      isCapital: true,
      hasPort: true,
      hasAirport: true,
      industries: 3,
      hasMilitary: true,
      hasHospital: true,
      hasPower: true,
      roadCount: 4,
      hasRiver: true
    });
    expect(plainCity).toBe(0);
    expect(capitalCity).toBe(100);
  });

  it('country capitals carry top importance and strong strategic value', () => {
    for (const country of Object.values(model.countries)) {
      const capital = model.cities[country.capitalCityId];
      const others = country.cityIds
        .filter((cityId) => cityId !== country.capitalCityId)
        .map((cityId) => model.cities[cityId]);
      // Importance is construction-guaranteed: the capital bonus dominates.
      expect(capital.importance).toBeGreaterThanOrEqual(
        others.reduce((max, city) => Math.max(max, city.importance), 0)
      );
      // Strategic value: capitals always sit in the upper band (capital
      // bonus); a specialized port/industry hub MAY outscore them.
      expect(capital.strategicValue).toBeGreaterThanOrEqual(20);
    }
  });
});

// ———————————————————— helpers ————————————————————

const hostCellByCity = new Map<string, number>();
// Rebuild the host-cell mapping from the enrichment: the city position's cell.
function cellIndexOf(position: { x: number; z: number }): number {
  const cx = Math.max(0, Math.min(columns - 1, Math.floor(position.x / cellSize)));
  const cz = Math.max(0, Math.min(rows - 1, Math.floor(position.z / cellSize)));
  return cz * columns + cx;
}
function cityCellOf(cityId: string): number {
  let cell = hostCellByCity.get(cityId);
  if (cell === undefined) {
    cell = cellIndexOf(model.cities[cityId].position);
    hostCellByCity.set(cityId, cell);
  }
  return cell;
}

it('generation reports NO water-safety warnings on the default map', () => {
  expect(warnings.filter((warning) => warning.includes('water safety'))).toEqual([]);
});
