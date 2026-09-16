import { describe, it, expect } from 'vitest';
import { generateStrategicMap } from '../../../../world/map/MapGenerator';
import { DEFAULT_MAP_CONFIG } from '../../../helpers/mapTestConfig';
import {
  pickAt,
  hoverAt,
  cellIndexAtPoint,
  cellIndexAtWorld,
  latticeQuad,
  pointInRing,
  type PickEligibility
} from '../../../../world/map/MapQueries';
import {
  describeProvince,
  checkWaterSafety
} from '../../../../world/map/MapGeography';
import { cellCornerPoints } from '../../../../world/map/MapFeatures';
import type { MapPoint } from '../../../../world/map/MapTypes';
import {
  createDefaultMapSlice,
  setFeatureSelection,
  setMapSelection,
  clearMapSelection,
  selectionSummary
} from '../../../../state/slices/mapSlice';
import { Random } from '../../../../utils/Random';

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

describe('Part 3.6 — selection integrity, provinces, capitals', () => {
  const { model } = generateStrategicMap(DEFAULT_MAP_CONFIG);
  const columns = DEFAULT_MAP_CONFIG.columns;
  const rows = DEFAULT_MAP_CONFIG.rows;
  const cellSize = DEFAULT_MAP_CONFIG.cellSize;

  // ————————————————— §1 pick = display geometry —————————————————

  it('latticeQuad returns the SAME jittered corners the grid layer draws', () => {
    for (let cellIndex = 0; cellIndex < model.features.biomes.length; cellIndex++) {
      const quad = latticeQuad(model.lattice, cellIndex, columns);
      const corners = cellCornerPoints(cellIndex, model.lattice, columns);
      for (let corner = 0; corner < 4; corner++) {
        expect(quad[corner].x).toBe(corners[corner].x);
        expect(quad[corner].z).toBe(corners[corner].z);
      }
    }
  });

  it('the lattice is genuinely JITTERED (the historic pick/display mismatch exists)', () => {
    // Guard for the regression this file exists for: interior lattice points
    // must actually be displaced, otherwise "picking = drawing" is trivial.
    const stride = columns + 1;
    let displaced = 0;
    for (let index = 0; index < model.lattice.length; index++) {
      const point = model.lattice[index];
      const cx = index % stride;
      const cz = Math.floor(index / stride);
      const onBorder = cx === 0 || cz === 0 || cx === columns || cz === rows;
      if (onBorder) continue;
      const exactX = cx * cellSize;
      const exactZ = cz * cellSize;
      if (Math.abs(point.x - exactX) > 1e-9 || Math.abs(point.z - exactZ) > 1e-9) displaced++;
    }
    expect(displaced).toBeGreaterThan(0);
  });

  it('cellIndexAtPoint ALWAYS returns the jittered quad that contains the point', () => {
    const rng = new Random(20260917);
    let checked = 0;
    for (let sample = 0; sample < 4000; sample++) {
      const point: MapPoint = {
        x: rng.next() * columns * cellSize,
        z: rng.next() * rows * cellSize
      };
      const resolved = cellIndexAtPoint(model, point, columns, rows, cellSize);
      expect(resolved).toBeGreaterThanOrEqual(0);
      const quad = latticeQuad(model.lattice, resolved, columns);
      // THE invariant: the resolved cell is the drawn polygon under the point.
      expect(pointInRing(point, quad)).toBe(true);
      checked++;
    }
    expect(checked).toBe(4000);
  });

  it('clicks near shared jittered edges resolve to the DRAWN cell (not the arithmetic one)', () => {
    // Sample finely; wherever the old arithmetic picker and the polygon
    // picker disagree, the PICK must follow the polygon — the exact bug the
    // user reported ("sometimes only part of the cell gets selected").
    const step = cellSize / 9;
    let disagreements = 0;
    for (let z = step; z < rows * cellSize; z += step) {
      for (let x = step; x < columns * cellSize; x += step) {
        const point: MapPoint = { x, z };
        const arithmetic = cellIndexAtWorld(point, columns, rows, cellSize);
        const polygon = cellIndexAtPoint(model, point, columns, rows, cellSize);
        if (arithmetic === polygon) continue;
        disagreements++;
        const quad = latticeQuad(model.lattice, polygon, columns);
        expect(pointInRing(point, quad)).toBe(true);
        const result = pickAt(model, point, pickOpts());
        expect(result.cellIndex).toBe(polygon);
        if (result.gridCellKey !== null) {
          expect(result.gridCellKey.split('#')[0]).toBe(
            model.countryOrder[model.features.cellOwner[polygon]]
          );
        }
      }
    }
    // The jitter is real, so the sample grid MUST contain disagreement points
    // — otherwise this test would silently verify nothing.
    expect(disagreements).toBeGreaterThan(0);
  });

  it('hover resolves the SAME cell as pick (hover/click can never disagree)', () => {
    const rng = new Random(777);
    for (let sample = 0; sample < 1500; sample++) {
      const point: MapPoint = {
        x: rng.next() * columns * cellSize,
        z: rng.next() * rows * cellSize
      };
      const pick = pickAt(model, point, pickOpts());
      const hover = hoverAt(model, point, pickOpts());
      expect(hover.cellIndex).toBe(pick.cellIndex);
      expect(hover.gridCellKey).toBe(pick.gridCellKey);
      // Province context agrees wherever both resolve one.
      if (pick.provinceId !== null || hover.provinceId !== null) {
        expect(hover.provinceId).toBe(pick.provinceId);
      }
    }
  });

  it('cell-centroid clicks always select their own cell (whole-cell highlight)', () => {
    for (let cellIndex = 0; cellIndex < model.features.biomes.length; cellIndex++) {
      if (model.features.cellOwner[cellIndex] < 0) continue;
      const quad = latticeQuad(model.lattice, cellIndex, columns);
      // Strict interior point of the jittered quad.
      const point: MapPoint = {
        x: (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4,
        z: (quad[0].z + quad[1].z + quad[2].z + quad[3].z) / 4
      };
      expect(cellIndexAtPoint(model, point, columns, rows, cellSize)).toBe(cellIndex);
    }
  });

  // ————————————————— §2 ONE central selection —————————————————

  it('selectionSummary reports EVERY selection kind from the central state', () => {
    const slice = createDefaultMapSlice(columns, rows, cellSize);

    // None → empty state.
    expect(selectionSummary(slice, model)).toBe('nothing — click the map');

    // Grid cell (canonical countryId#gridId).
    let gridKey: string | null = null;
    for (let cellIndex = 0; cellIndex < model.features.gridIds.length && gridKey === null; cellIndex++) {
      gridKey = pickAt(model, centroidOfCell(cellIndex), pickOpts({ grid: true })).gridCellKey;
    }
    expect(gridKey).not.toBeNull();
    setFeatureSelection(slice, { kind: 'grid', gridKey: gridKey as string });
    const gridSummary = selectionSummary(slice, model);
    expect(gridSummary).toContain('(grid cell');
    expect(gridSummary.startsWith(gridKey?.split('#')[1] ?? '')).toBe(true);

    // River / lake / site / building kinds (first of each in the model).
    const river = model.features.rivers[0];
    if (river !== undefined) {
      setFeatureSelection(slice, { kind: 'river', riverId: river.id });
      expect(selectionSummary(slice, model)).toBe(`${river.name} (river)`);
    }
    const lake = model.features.lakes[0];
    if (lake !== undefined) {
      setFeatureSelection(slice, { kind: 'lake', lakeId: lake.id });
      expect(selectionSummary(slice, model)).toBe(`${lake.name} (lake)`);
    }
    const site = model.features.sites[0];
    if (site !== undefined) {
      setFeatureSelection(slice, { kind: 'site', siteId: site.id });
      expect(selectionSummary(slice, model)).toBe(`${site.kind} (site)`);
    }
    const building = model.features.buildings[0];
    if (building !== undefined) {
      setFeatureSelection(slice, { kind: 'building', buildingId: building.id });
      expect(selectionSummary(slice, model)).toBe(`${building.kind} (building)`);
    }

    // Hierarchy kinds.
    setMapSelection(slice, { countryId: model.countryOrder[0] });
    expect(selectionSummary(slice, model)).toContain('(country)');
    clearMapSelection(slice);
    expect(selectionSummary(slice, model)).toBe('nothing — click the map');
  });

  it('a grid selection and the country detail agree (panel sync contract)', () => {
    const slice = createDefaultMapSlice(columns, rows, cellSize);
    // Click a land cell through the REAL pick path.
    let clicked: ReturnType<typeof pickAt> | null = null;
    for (let cellIndex = 0; cellIndex < model.features.biomes.length; cellIndex++) {
      if (model.features.cellOwner[cellIndex] < 0) continue;
      const result = pickAt(model, centroidOfCell(cellIndex), pickOpts());
      if (result.gridCellKey !== null) {
        clicked = result;
        break;
      }
    }
    expect(clicked).not.toBeNull();
    if (clicked?.gridCellKey === null || clicked === null) return;
    setFeatureSelection(slice, { kind: 'grid', gridKey: clicked.gridCellKey });
    // The general panel reads the SAME state: a grid selection is visible in
    // the summary (not "nothing") while the country rows stay empty.
    expect(selectionSummary(slice, model)).toContain('(grid cell');
    expect(slice.selectedCountryId).toBeNull();
    expect(slice.selectedProvinceId).toBeNull();
  });

  // ————————————————— §3 province layer data —————————————————

  it('describeProvince exposes the enriched province block for EVERY province', () => {
    for (const provinceId of Object.keys(model.provinces)) {
      const info = describeProvince(model, provinceId);
      expect(info).not.toBeNull();
      if (info === null) continue;
      const province = model.provinces[provinceId];
      expect(info.name).toBe(province.name);
      expect(info.countryId).toBe(province.countryId);
      expect(info.areaCells).toBe(province.cellIds.length);
      // Population tree invariant: province population = Σ member cities.
      let citySum = 0;
      for (const cityId of province.cityIds) citySum += model.cities[cityId].population;
      expect(info.population).toBe(citySum);
      expect(info.strategicValue).toBeGreaterThanOrEqual(0);
      expect(info.developmentLevel).toBeGreaterThanOrEqual(0);
      expect(info.developmentLevel).toBeLessThanOrEqual(1);
      // Neighbors are structural cell adjacency — may cross country borders
      // (foreign provinces ARE neighbors; useful for future war systems).
      for (const neighborId of info.neighborProvinceIds) {
        expect(model.provinces[neighborId]).toBeDefined();
      }
    }
  });

  it('describeProvince returns null for unknown ids (stale-state heal)', () => {
    expect(describeProvince(model, 'province_missing')).toBeNull();
  });

  it('the country capital leads its province (province.capitalCityId rule)', () => {
    for (const countryId of model.countryOrder) {
      const country = model.countries[countryId];
      const capital = model.cities[country.capitalCityId];
      const province = model.provinces[capital.provinceId];
      expect(province.capitalCityId).toBe(country.capitalCityId);
    }
  });

  // ————————————————— §4 capitals —————————————————

  it('every capital is inside its OWN country ring', () => {
    for (const countryId of model.countryOrder) {
      const country = model.countries[countryId];
      const capital = model.cities[country.capitalCityId];
      expect(pointInRing(capital.position, country.ring.points)).toBe(true);
    }
  });

  it('every capital is inside its own province and belongs to the right country', () => {
    for (const countryId of model.countryOrder) {
      const country = model.countries[countryId];
      const capital = model.cities[country.capitalCityId];
      expect(capital.countryId).toBe(countryId);
      const province = model.provinces[capital.provinceId];
      expect(province.countryId).toBe(countryId);
      expect(province.cityIds).toContain(country.capitalCityId);
      expect(pointInRing(capital.position, province.ring.points)).toBe(true);
    }
  });

  it('no capital sits on water: dry host cell, no lake, no river centerline', () => {
    const lakeCellSet = new Set<number>();
    for (const lake of model.features.lakes) {
      for (const cellIndex of lake.cells) lakeCellSet.add(cellIndex);
    }
    const riverCellSet = new Set<number>();
    for (const river of model.features.rivers) {
      for (const cellIndex of river.cells) riverCellSet.add(cellIndex);
    }
    for (const countryId of model.countryOrder) {
      const capital = model.cities[model.countries[countryId].capitalCityId];
      const hostCell = cellIndexAtPoint(model, capital.position, columns, rows, cellSize);
      expect(hostCell).toBeGreaterThanOrEqual(0);
      expect(model.features.biomes[hostCell]).not.toBe('ocean');
      expect(lakeCellSet.has(hostCell)).toBe(false);
      const verdict = checkWaterSafety({
        position: capital.position,
        hostCell,
        cellSize,
        rivers: model.features.rivers,
        lakeCellSet,
        riverCellSet
      });
      expect(verdict.safe).toBe(true);
    }
  });

  it('capitals are GEOGRAPHICALLY CENTRAL — the closest valid candidate to the country centroid', () => {
    for (const countryId of model.countryOrder) {
      const country = model.countries[countryId];
      const capital = model.cities[country.capitalCityId];
      // Centroid of the member-cell centroids — the ground truth of "middle".
      let cx = 0;
      let cz = 0;
      for (const cellIndex of country.cellIds) {
        const quad = latticeQuad(model.lattice, cellIndex, columns);
        cx += (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
        cz += (quad[0].z + quad[1].z + quad[2].z + quad[3].z) / 4;
      }
      cx /= country.cellIds.length;
      cz /= country.cellIds.length;
      const capitalDistance = Math.hypot(capital.position.x - cx, capital.position.z - cz);
      // No member-cell centroid may be closer to the centroid than the
      // capital within one cell of slack (the capital is picked among
      // validated interior points near those centroids).
      let bestCellDistance = Number.POSITIVE_INFINITY;
      for (const cellIndex of country.cellIds) {
        const quad = latticeQuad(model.lattice, cellIndex, columns);
        const px = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
        const pz = (quad[0].z + quad[1].z + quad[2].z + quad[3].z) / 4;
        const distance = Math.hypot(px - cx, pz - cz);
        if (distance < bestCellDistance) bestCellDistance = distance;
      }
      expect(capitalDistance).toBeLessThanOrEqual(bestCellDistance + cellSize);
    }
  });

  it('capital placement is deterministic across generations (same seed)', () => {
    const second = generateStrategicMap(DEFAULT_MAP_CONFIG);
    for (const countryId of model.countryOrder) {
      expect(second.model.countries[countryId].capitalCityId).toBe(
        model.countries[countryId].capitalCityId
      );
      expect(second.model.cities[second.model.countries[countryId].capitalCityId].position).toEqual(
        model.cities[model.countries[countryId].capitalCityId].position
      );
    }
  });

  // ————————————————— shared helper —————————————————

  function centroidOfCell(cellIndex: number): MapPoint {
    const quad = latticeQuad(model.lattice, cellIndex, columns);
    return {
      x: (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4,
      z: (quad[0].z + quad[1].z + quad[2].z + quad[3].z) / 4
    };
  }
});
