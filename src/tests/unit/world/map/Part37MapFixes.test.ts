import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { generateStrategicMap } from '../../../../world/map/MapGenerator';
import { DEFAULT_MAP_CONFIG } from '../../../helpers/mapTestConfig';
import {
  pickAt,
  hoverAt,
  cellIndexAtPoint,
  latticeQuad,
  pointInRing,
  distanceToRing,
  visibleCellPolygon,
  gridCellKeyAt,
  type PickEligibility
} from '../../../../world/map/MapQueries';
import { cellIndexOf } from '../../../../world/map/MapFeatures';
import { GridLayer, riverDrawnRuns, buildRiverRibbons } from '../../../../rendering/map/FeatureLayers';
import themeJson from '../../../../data/mapTheme.json';
import type { MapThemeData } from '../../../../data/types';
import type { MapPoint } from '../../../../world/map/MapTypes';
import {
  createDefaultMapSlice,
  setFeatureSelection,
  setMapSelection,
  selectionSummary
} from '../../../../state/slices/mapSlice';

const theme = themeJson as unknown as MapThemeData;
const { model } = generateStrategicMap(DEFAULT_MAP_CONFIG);
const columns = DEFAULT_MAP_CONFIG.columns;
const rows = DEFAULT_MAP_CONFIG.rows;
const cellSize = DEFAULT_MAP_CONFIG.cellSize;

const ALL_ON: PickEligibility = {
  grid: true,
  rivers: true,
  lakes: true,
  sites: true,
  buildings: true,
  cities: true,
  capitals: true
};

/** Tight, marker-sized pick options (the new Game.pickOptions semantics). */
function pickOpts(eligibility: Partial<PickEligibility> = {}) {
  return {
    pickRadius: 2.2, // theme cityHitRadius — fixed world size
    riverPickDistance: 1.6, // widest ribbon half-width + slack
    columns,
    rows,
    cellSize,
    eligibility: { ...ALL_ON, ...eligibility }
  };
}

function polygonArea(points: readonly MapPoint[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.z - b.x * a.z;
  }
  return Math.abs(sum) / 2;
}

function lakeCellSetOf(m: typeof model): Set<number> {
  const set = new Set<number>();
  for (const lake of m.features.lakes) for (const cell of lake.cells) set.add(cell);
  return set;
}

describe('Part 3.7 — §A exact visible cell polygon (display == pick == highlight)', () => {
  const cellCount = model.features.biomes.length;

  it('unclipped cells return the EXACT jittered quad; both paths occur on this seed', () => {
    let unclipped = 0;
    let clipped = 0;
    for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
      if (model.features.cellOwner[cellIndex] < 0) continue;
      const quad = latticeQuad(model.lattice, cellIndex, columns);
      const { points, clipped: isClipped } = visibleCellPolygon(model, cellIndex, columns);
      if (isClipped) {
        clipped++;
        continue;
      }
      unclipped++;
      expect(points).toHaveLength(4);
      for (let corner = 0; corner < 4; corner++) {
        expect(points[corner].x).toBe(quad[corner].x);
        expect(points[corner].z).toBe(quad[corner].z);
      }
    }
    // Both branches must be exercised: interior cells keep the raw quad,
    // border cells get the exact border-cut polygon.
    expect(unclipped).toBeGreaterThan(0);
    expect(clipped).toBeGreaterThan(0);
  });

  it('every land cell: the visible polygon lies inside quad ∩ owner ring', () => {
    for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
      const owner = model.features.cellOwner[cellIndex];
      if (owner < 0) continue;
      const quad = latticeQuad(model.lattice, cellIndex, columns);
      const countryId = model.countryOrder[owner];
      const ring = model.countries[countryId].ring.points;
      const { points } = visibleCellPolygon(model, cellIndex, columns);
      expect(points.length).toBeGreaterThanOrEqual(3);
      for (const point of points) {
        // Inside (or exactly on) the drawn cell quad…
        expect(pointInRing(point, quad) || distanceToRing(point, quad) < 1e-6).toBe(true);
        // …and inside (or exactly on) the country border drawn there.
        expect(pointInRing(point, ring) || distanceToRing(point, ring) < 1e-6).toBe(true);
      }
    }
  });

  it('the visible polygon never exceeds the cell quad (highlight can only shrink it)', () => {
    for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
      if (model.features.cellOwner[cellIndex] < 0) continue;
      const quad = latticeQuad(model.lattice, cellIndex, columns);
      const { points } = visibleCellPolygon(model, cellIndex, columns);
      // The border-cut polygon can only REMOVE area from the raw quad —
      // the highlight never spills past the visible cell.
      expect(polygonArea(points)).toBeLessThanOrEqual(polygonArea(quad) + 1e-9);
    }
  });

  it('pick == display: in-ring quad points resolve to the cell, cut-away points never do', () => {
    for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
      const owner = model.features.cellOwner[cellIndex];
      if (owner < 0) continue;
      const key = gridCellKeyAt(model, cellIndex);
      if (key === null) continue;
      const quad = latticeQuad(model.lattice, cellIndex, columns);
      const country = model.countries[model.countryOrder[owner]];
      const { points } = visibleCellPolygon(model, cellIndex, columns);
      // (a) Every INTERIOR point of the VISIBLE polygon picks this cell
      // (polygon vertices on the ring boundary are click-tolerant by design).
      const centroid = {
        x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
        z: points.reduce((sum, p) => sum + p.z, 0) / points.length
      };
      if (pointInRing(centroid, country.ring.points)) {
        const result = pickAt(model, centroid, pickOpts());
        expect(result.gridCellKey).toBe(key);
        expect(result.cellIndex).toBe(cellIndex);
      }
      // (b) A sampled quad point CLEARLY outside the ring (beyond the
      // 0.05 click-tolerance band) never picks this cell.
      let outsideChecked = 0;
      for (let stepZ = 1; stepZ < 8; stepZ++) {
        for (let stepX = 1; stepX < 8; stepX++) {
          const u = stepX / 8;
          const v = stepZ / 8;
          const point = {
            x: quad[0].x + (quad[1].x - quad[0].x) * u + (quad[3].x - quad[0].x) * v,
            z: quad[0].z + (quad[1].z - quad[0].z) * u + (quad[3].z - quad[0].z) * v
          };
          if (pointInRing(point, country.ring.points)) continue;
          if (distanceToRing(point, country.ring.points) <= 0.1) continue;
          const result = pickAt(model, point, pickOpts());
          expect(result.gridCellKey).not.toBe(key);
          outsideChecked++;
        }
      }
      if (outsideChecked > 0) {
        // This cell straddles the border — hover must agree with pick for a
        // strictly interior point (exact boundary vertices legitimately tie
        // with the neighbor cell, shared-edge ownership is scan-order).
        const centroid = {
          x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
          z: points.reduce((sum, p) => sum + p.z, 0) / points.length
        };
        if (pointInRing(centroid, country.ring.points)) {
          expect(hoverAt(model, centroid, pickOpts()).gridCellKey).toBe(key);
        }
      }
    }
  });

  it('the selection highlight renders the SAME polygon the pick resolves', () => {
    const layer = new GridLayer(columns, rows, theme);
    layer.ensureBuilt(model);
    // Pick a border cell (clipped) and an interior cell.
    let borderCell = -1;
    for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
      if (model.features.cellOwner[cellIndex] < 0) continue;
      const { clipped } = visibleCellPolygon(model, cellIndex, columns);
      if (clipped) {
        borderCell = cellIndex;
        break;
      }
    }
    expect(borderCell).toBeGreaterThanOrEqual(0);
    layer.setSelectedCell(borderCell);
    const fillMesh = layer.group.children.find(
      (child) => (child as THREE.Mesh).isMesh
    ) as THREE.Mesh;
    expect(fillMesh).toBeDefined();
    const fill = fillMesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    expect(fill.count).toBeGreaterThanOrEqual(3);
    const ring = model.countries[
      model.countryOrder[model.features.cellOwner[borderCell]]
    ].ring.points;
    for (let i = 0; i < fill.count; i++) {
      const point = { x: fill.getX(i), z: fill.getZ(i) };
      // Highlight vertices stay inside (or on) the country ring — the
      // highlight never spills past the visible cell. Tolerance covers the
      // Float32 GPU buffer rounding (~1e-5 at map scale).
      expect(pointInRing(point, ring) || distanceToRing(point, ring) < 1e-4).toBe(true);
    }
    // Clearing hides the overlays again.
    layer.setSelectedCell(null);
    expect(fillMesh.visible).toBe(false);
    layer.dispose();
  });

  it('selection geometry is deterministic across generator runs', () => {
    const second = generateStrategicMap(DEFAULT_MAP_CONFIG).model;
    for (let cellIndex = 0; cellIndex < 40; cellIndex++) {
      const a = visibleCellPolygon(model, cellIndex, columns);
      const b = visibleCellPolygon(second, cellIndex, columns);
      expect(a.clipped).toBe(b.clipped);
      expect(a.points.length).toBe(b.points.length);
      for (let i = 0; i < a.points.length; i++) {
        expect(a.points[i].x).toBe(b.points[i].x);
        expect(a.points[i].z).toBe(b.points[i].z);
      }
    }
  });
});

describe('Part 3.7 — §B/§H hit-testing priority (city vs cell vs river)', () => {
  it('a click on a city marker picks the city; a click 3u away picks the CELL', () => {
    const city = Object.values(model.cities)[0];
    expect(city).toBeDefined();
    const onMarker = pickAt(model, city.position, pickOpts());
    expect(onMarker.cityId).toBe(city.id);
    // 3 world units off the marker: beyond the 2.2 hit radius — the click
    // belongs to whatever ground is there (never the city).
    const offsets: readonly MapPoint[] = [
      { x: city.position.x + 3, z: city.position.z },
      { x: city.position.x, z: city.position.z + 3 },
      { x: city.position.x - 3, z: city.position.z - 3 }
    ];
    for (const point of offsets) {
      const result = pickAt(model, point, pickOpts());
      expect(result.cityId).toBeNull();
      const containingCell = cellIndexAtPoint(model, point, columns, rows, cellSize);
      if (containingCell >= 0 && model.features.cellOwner[containingCell] >= 0) {
        // Open ground inside a country resolves to that cell (grid on) —
        // or to water if the ground IS water.
        if (result.lakeId === null && result.riverId === null) {
          expect(result.gridCellKey ?? null).toBe(
            gridCellKeyAt(model, containingCell, point)
          );
        }
      }
    }
  });

  it('hidden Cities/Capitals layers are never selectable (visible-only picking)', () => {
    const city = Object.values(model.cities).find((candidate) => !candidate.isCapital);
    const capital = Object.values(model.cities).find((candidate) => candidate.isCapital);
    expect(city).toBeDefined();
    expect(capital).toBeDefined();
    // Both hidden: a click dead-center on a marker picks the ground instead.
    const bothHidden = pickAt(model, city!.position, pickOpts({ cities: false, capitals: false }));
    expect(bothHidden.cityId).toBeNull();
    const capitalsOnly = pickAt(model, capital!.position, pickOpts({ cities: false, capitals: true }));
    expect(capitalsOnly.cityId).toBe(capital!.id);
    const citiesOnly = pickAt(model, city!.position, pickOpts({ cities: true, capitals: false }));
    expect(citiesOnly.cityId).toBe(city!.id);
    // Hover agrees with pick (one interaction semantics).
    const hover = hoverAt(model, city!.position, pickOpts({ cities: false, capitals: false }));
    expect(hover.cityId).toBeNull();
  });

  it('river hit-testing is ribbon-precise: the centerline hits, open ground does not', () => {
    const river = model.features.rivers.find((candidate) => candidate.polyline.length >= 4);
    expect(river).toBeDefined();
    const riverRibbon = river!.polyline;
    const onLine = riverRibbon[Math.floor(riverRibbon.length / 2)];
    const hit = pickAt(model, onLine, pickOpts());
    if (hit.lakeId === null) {
      expect(hit.riverId).toBe(river!.id);
    }
    // 2.5u laterally off the ribbon (width ≤ 2.4, so ≥1.3u of open ground):
    // a 1.6 pick radius must NOT resolve to the river from there.
    const next = riverRibbon[Math.min(riverRibbon.length - 1, Math.floor(riverRibbon.length / 2) + 1)];
    const dx = next.x - onLine.x;
    const dz = next.z - onLine.z;
    const length = Math.hypot(dx, dz) || 1;
    const off = { x: onLine.x + (-dz / length) * 2.5, z: onLine.z + (dx / length) * 2.5 };
    const miss = pickAt(model, off, pickOpts());
    if (miss.lakeId === null) expect(miss.riverId).not.toBe(river!.id);
  });
});

describe('Part 3.7 — §C one central selection state (panel synchronization)', () => {
  it('every selection kind reports through selectionSummary and clears the others', () => {
    const slice = createDefaultMapSlice(columns, rows, cellSize);
    expect(selectionSummary(slice, model)).toBe('nothing — click the map');

    const someKey = gridCellKeyAt(model, model.features.cellOwner.findIndex((o) => o >= 0));
    expect(someKey).not.toBeNull();
    setFeatureSelection(slice, { kind: 'grid', gridKey: someKey! });
    expect(slice.selectedGridKey).toBe(someKey);
    expect(selectionSummary(slice, model)).toBe(
      `${someKey!.slice(someKey!.indexOf('#') + 1)} (grid cell, ${model.countries[someKey!.slice(0, someKey!.indexOf('#'))].name})`
    );

    const city = Object.values(model.cities)[0];
    setMapSelection(slice, { countryId: city.countryId, provinceId: city.provinceId, cityId: city.id });
    expect(slice.selectedGridKey).toBeNull(); // feature kinds cleared
    expect(selectionSummary(slice, model)).toContain(city.name);

    const river = model.features.rivers[0];
    setFeatureSelection(slice, { kind: 'river', riverId: river.id });
    expect(slice.selectedCityId).toBeNull(); // hierarchy cleared
    expect(slice.selectedProvinceId).toBeNull();
    expect(slice.selectedCountryId).toBeNull();
    expect(selectionSummary(slice, model)).toBe(`${river.name} (river)`);

    const lake = model.features.lakes[0];
    if (lake !== undefined) {
      setFeatureSelection(slice, { kind: 'lake', lakeId: lake.id });
      expect(slice.selectedRiverId).toBeNull();
      expect(selectionSummary(slice, model)).toBe(`${lake.name} (lake)`);
    }

    const province = model.provinces[Object.keys(model.provinces)[0]];
    setMapSelection(slice, { provinceId: province.id, countryId: province.countryId });
    expect(selectionSummary(slice, model)).toBe(`${province.name} (province)`);

    setFeatureSelection(slice, { kind: 'grid', gridKey: someKey! });
    expect(slice.selectedProvinceId).toBeNull();
    expect(slice.selectedCountryId).toBeNull();
    expect(selectionSummary(slice, model)).toContain('(grid cell');
  });

  it('stale feature selections re-validate against the model (no phantom panels)', () => {
    const slice = createDefaultMapSlice(columns, rows, cellSize);
    setFeatureSelection(slice, { kind: 'grid', gridKey: 'country_999#Z9' });
    // The summary must not crash or invent data for unknown ids.
    expect(selectionSummary(slice, model)).toContain('grid cell');
  });
});

describe('Part 3.7 — §E/§F river/lake geometry separation + natural rivers', () => {
  const lakeCells = lakeCellSetOf(model);

  it('drawn runs: interiors are strictly non-lake; shore stubs reach at most ONE lake point', () => {
    for (const river of model.features.rivers) {
      const runs = riverDrawnRuns(river, lakeCells);
      // Coverage: every non-lake index belongs to at least one run (shore
      // stub endpoints may be shared between two consecutive runs).
      const covered = new Set<number>();
      for (const [start, end] of runs) {
        expect(end).toBeGreaterThanOrEqual(start);
        for (let i = start; i <= end; i++) covered.add(i);
      }
      for (let i = 0; i < river.cells.length; i++) {
        if (!lakeCells.has(river.cells[i])) expect(covered.has(i)).toBe(true);
      }
      // Purity: a lake cell may only appear as a run ENDPOINT (shore stub) —
      // never strictly inside a drawn span (no ribbons across the lake).
      for (const [start, end] of runs) {
        for (let i = start + 1; i < end; i++) {
          expect(lakeCells.has(river.cells[i])).toBe(false);
        }
      }
    }
  });

  it('rivers touching a lake connect to the shore (inflow/outflow stubs exist)', () => {
    let touching = 0;
    for (const river of model.features.rivers) {
      const crosses = river.cells.some((cell) => lakeCells.has(cell));
      if (!crosses) continue;
      touching++;
      const runs = riverDrawnRuns(river, lakeCells);
      // At least one run boundary must be a lake cell (the shore stub).
      const stubs = runs.filter(
        ([start, end]) =>
          lakeCells.has(river.cells[start]) || lakeCells.has(river.cells[end])
      );
      expect(stubs.length).toBeGreaterThan(0);
    }
    // Guard: this seed must actually exercise lake/river interaction.
    expect(touching).toBeGreaterThan(0);
  });

  it('the built ribbon mesh never spans more than one lake point per run', () => {
    const geometry = buildRiverRibbons(model, columns, theme);
    expect(geometry).not.toBeNull();
    // Vertex-level check: count ribbon vertices per cell must be bounded by
    // the drawn runs (the mesh is exactly the union of the run strips).
    let expected = 0;
    for (const river of model.features.rivers) {
      for (const [start, end] of riverDrawnRuns(river, lakeCells)) {
        expected += (end - start) * 6;
      }
    }
    const pos = (geometry as THREE.BufferGeometry).getAttribute('position') as THREE.BufferAttribute;
    expect(pos.count).toBe(expected);
  });
});

describe('Part 3.7 — §I capital water safety + province correctness', () => {
  const lakeCells = lakeCellSetOf(model);
  const riverCells = new Set<number>();
  for (const river of model.features.rivers) {
    for (const cell of river.cells) riverCells.add(cell);
  }

  it('every capital: own country, dry land, not lake, not river cell, correct province', () => {
    for (const countryId of model.countryOrder) {
      const country = model.countries[countryId];
      const capital = model.cities[country.capitalCityId];
      expect(capital).toBeDefined();
      expect(capital.isCapital).toBe(true);
      expect(capital.countryId).toBe(countryId);
      // Inside its own country's ring (never abroad, never ocean-side).
      expect(pointInRing(capital.position, country.ring.points)).toBe(true);
      // On land, out of every lake, out of every river channel cell.
      const cell = cellIndexOf(capital.position, columns, cellSize);
      expect(model.features.biomes[cell]).not.toBe('ocean');
      expect(lakeCells.has(cell)).toBe(false);
      expect(riverCells.has(cell)).toBe(false);
      // In a VALID province of THIS country, and that province's capital.
      const province = model.provinces[capital.provinceId];
      expect(province).toBeDefined();
      expect(province.countryId).toBe(countryId);
      expect(country.provinceIds).toContain(province.id);
      expect(province.capitalCityId).toBe(capital.id);
      // City marker and capital data are ONE location (no drift).
      const quad = latticeQuad(model.lattice, cell, columns);
      expect(pointInRing(capital.position, quad)).toBe(true);
    }
  });
});
