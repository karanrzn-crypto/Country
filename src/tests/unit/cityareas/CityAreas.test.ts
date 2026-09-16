import { describe, it, expect } from 'vitest';
import { createTestGame } from '../../helpers/testGame';
import { buildCityAreaNetwork } from '../../../world/cityareas/CityAreaGenerator';
import { findPath, networkSummary, linkCost, buildAdjacency, areasOfCountry } from '../../../world/cityareas/CityAreaPathfinding';
import { createCityAreasSlice, syncCityAreas, setAreaDevelopment, setLinkCondition, cityAreaNetworkIsCoherent } from '../../../state/slices/cityAreasSlice';
import { DEFAULT_CONFIG } from '../../../config/configTypes';
import { stableStringify } from '../../../utils/hash';
import type { Game } from '../../../core/Game';

function preparedGame(seed: number): { game: Game; countryId: string } {
  const game = createTestGame({ seed });
  return { game, countryId: game.strategicMap.countryOrder[0] };
}

describe('City Areas — spatial network (generator, topology, pathfinding)', () => {
  it('generation is deterministic per map model (same seed → identical network)', () => {
    const a = buildCityAreaNetwork(createTestGame({ seed: 111 }).strategicMap, DEFAULT_CONFIG.map.columns);
    const b = buildCityAreaNetwork(createTestGame({ seed: 111 }).strategicMap, DEFAULT_CONFIG.map.columns);
    expect(stableStringify(a.network)).toBe(stableStringify(b.network));
    expect(a.warnings.length).toBe(0);
  });

  it('every city has an urban core at the city position (coverage)', () => {
    const { game } = preparedGame(112);
    const model = game.strategicMap;
    const network = game.gameState.cityAreas.network;
    for (const city of Object.values(model.cities)) {
      const core = network.areas[`area_${city.id}_core`];
      expect(core, `core for ${city.id}`).toBeDefined();
      expect(core?.position).toEqual({ x: city.position.x, z: city.position.z });
      expect(core?.cityId).toBe(city.id);
      expect(core?.countryId).toBe(city.countryId);
      expect(core?.provinceId).toBe(city.provinceId);
      expect(core?.footprint.length).toBeGreaterThanOrEqual(3);
    }
    game.dispose();
  });

  it('link topology is coherent: endpoints exist, no self loops, positive length, valid condition', () => {
    const { game } = preparedGame(113);
    const network = game.gameState.cityAreas.network;
    expect(cityAreaNetworkIsCoherent(network)).toBe(true);
    for (const link of Object.values(network.links)) {
      expect(network.areas[link.a]).toBeDefined();
      expect(network.areas[link.b]).toBeDefined();
      expect(link.a).not.toBe(link.b);
      expect(link.length).toBeGreaterThan(0);
      expect(link.condition).toBeGreaterThanOrEqual(0);
      expect(link.condition).toBeLessThanOrEqual(1);
      expect(link.path.length).toBeGreaterThanOrEqual(2);
    }
    game.dispose();
  });

  it('inter-city roads pass through junction nodes (City A → district → junction → district → City B)', () => {
    const { game } = preparedGame(114);
    const model = game.strategicMap;
    const network = game.gameState.cityAreas.network;
    const roadLines = model.features.lines.filter(
      (line) => (line.kind === 'highway' || line.kind === 'secondary') && line.cityA !== null && line.cityB !== null
    );
    expect(roadLines.length).toBeGreaterThan(0);
    for (const line of roadLines) {
      const junction = network.areas[`junction_${line.id}`];
      expect(junction, `junction for ${line.id}`).toBeDefined();
      expect(junction?.type).toBe('junction');
      expect(junction?.transportHub).toBe(true);
      const linkA = network.links[`link_${line.id}_a`];
      const linkB = network.links[`link_${line.id}_b`];
      expect(linkA).toBeDefined();
      expect(linkB).toBeDefined();
      // Junction is the shared endpoint of both halves.
      const joinsA = linkA?.a === junction?.id || linkA?.b === junction?.id;
      const joinsB = linkB?.a === junction?.id || linkB?.b === junction?.id;
      expect(joinsA && joinsB).toBe(true);
      // Junction position sits on the road polyline's middle segment.
      const mid = Math.floor((line.polyline.length - 1) / 2);
      const midStart = line.polyline[mid];
      const midEnd = line.polyline[mid + 1] ?? midStart;
      expect(junction?.position.x).toBeCloseTo((midStart.x + midEnd.x) / 2, 6);
      expect(junction?.position.z).toBeCloseTo((midStart.z + midEnd.z) / 2, 6);
    }
    game.dispose();
  });

  it('railway lines become railway links between city cores (multi-network support)', () => {
    const { game } = preparedGame(115);
    const model = game.strategicMap;
    const network = game.gameState.cityAreas.network;
    const railLines = model.features.lines.filter((line) => line.kind === 'railway' && line.cityA !== null && line.cityB !== null);
    expect(railLines.length).toBeGreaterThan(0);
    const railLinks = Object.values(network.links).filter((link) => link.kind === 'railway');
    expect(railLinks.length).toBe(railLines.length);
    for (const link of railLinks) {
      expect(network.areas[link.a]?.type).toBe('urban_core');
      expect(network.areas[link.b]?.type).toBe('urban_core');
    }
    game.dispose();
  });

  it('pathfinding: cheapest path across the network is continuous and costs are positive', () => {
    const { game, countryId } = preparedGame(116);
    const network = game.gameState.cityAreas.network;
    const areas = areasOfCountry(network, countryId).filter((area) => area.type === 'urban_core');
    const start = areas[0].id;
    const goal = areas[areas.length - 1].id;
    const path = findPath(network, start, goal);
    expect(path).not.toBeNull();
    expect(path?.areaIds[0]).toBe(start);
    expect(path?.areaIds[path.areaIds.length - 1]).toBe(goal);
    expect(path?.linkIds.length).toBe(path?.areaIds.length === 1 ? 0 : path!.areaIds.length - 1);
    expect(path?.totalCost).toBeGreaterThan(0);
    // Continuity: every consecutive pair is actually linked.
    const adjacency = buildAdjacency(network);
    for (let index = 1; index < (path?.areaIds.length ?? 0); index += 1) {
      const from = path!.areaIds[index - 1];
      const to = path!.areaIds[index];
      const linkId = path!.linkIds[index - 1];
      const neighbors = adjacency.get(from) ?? [];
      expect(neighbors.some((entry) => entry.other === to && entry.linkId === linkId)).toBe(true);
    }
    game.dispose();
  });

  it('pathfinding: trivial, unknown and unreachable cases behave', () => {
    const { game } = preparedGame(117);
    const network = game.gameState.cityAreas.network;
    const areas = areasOfCountry(network, game.strategicMap.countryOrder[0]);
    const start = areas[0].id;
    // Trivial.
    const trivial = findPath(network, start, start);
    expect(trivial).toEqual({ areaIds: [start], linkIds: [], totalCost: 0 });
    // Unknown ids.
    expect(findPath(network, 'nope', start)).toBeNull();
    expect(findPath(network, start, 'nope')).toBeNull();
    // Unreachable: two islands with no links.
    const islands = { areas: { a: { ...areas[0], id: 'a' }, b: { ...areas[1], id: 'b' } }, links: {} };
    expect(findPath(islands, 'a', 'b')).toBeNull();
    // Cost model: worn links cost more than pristine ones.
    const link = Object.values(network.links)[0];
    expect(linkCost({ ...link, condition: 0.2 })).toBeGreaterThan(linkCost({ ...link, condition: 1 }));
    // Railways are faster per world unit than roads.
    expect(linkCost({ ...link, kind: 'railway' })).toBeLessThan(linkCost({ ...link, kind: 'road' }));
    game.dispose();
  });

  it('networkSummary aggregates connectivity, capacity and junction counts', () => {
    const { game, countryId } = preparedGame(118);
    const summary = networkSummary(game.gameState.cityAreas.network, countryId);
    expect(summary.areas).toBeGreaterThan(0);
    expect(summary.links).toBeGreaterThan(0);
    expect(summary.averageDevelopment).toBeGreaterThan(0);
    expect(summary.totalCapacity).toBeGreaterThan(0);
    // Border cities whose ONLY road leads abroad (through a foreign junction)
    // legitimately form small domestic components — connectivity stays high
    // but need not be 1. Transport hubs are shared infrastructure, so the
    // metric walks through foreign junctions when routing exists.
    expect(summary.connectivity).toBeGreaterThan(0.5);
    game.dispose();
  });

  it('the slice is wired into GameState for every country and schema-safe', () => {
    const { game } = preparedGame(119);
    const network = game.gameState.cityAreas.network;
    for (const countryId of game.strategicMap.countryOrder) {
      expect(areasOfCountry(network, countryId).length).toBeGreaterThan(0);
    }
    expect(cityAreaNetworkIsCoherent(network)).toBe(true);
    game.dispose();
  });

  it('syncCityAreas overlays saved runtime fields by id and drops stale ids', () => {
    const { game } = preparedGame(120);
    const model = game.strategicMap;
    const slice = createCityAreasSlice(model, DEFAULT_CONFIG.map.columns);
    const firstAreaId = Object.keys(slice.network.areas)[0];
    const firstLinkId = Object.keys(slice.network.links)[0];
    setAreaDevelopment(slice, firstAreaId, 0.99);
    setLinkCondition(slice, firstLinkId, 0.42);
    // Stale runtime data must not survive the sync.
    slice.network.areas['area_ghost'] = { ...slice.network.areas[firstAreaId], id: 'area_ghost' };
    slice.network.areas[firstAreaId].population = 123_456;

    syncCityAreas(slice, model, DEFAULT_CONFIG.map.columns);
    expect(slice.network.areas['area_ghost']).toBeUndefined();
    expect(slice.network.areas[firstAreaId].development).toBeCloseTo(0.99, 9);
    expect(slice.network.areas[firstAreaId].population).toBeCloseTo(123_456, 6);
    expect(slice.network.links[firstLinkId].condition).toBeCloseTo(0.42, 9);
    // Geometry regenerated identically.
    expect(cityAreaNetworkIsCoherent(slice.network)).toBe(true);
    game.dispose();
  });

  it('mutators clamp and reject unknown ids', () => {
    const { game } = preparedGame(121);
    const slice = game.gameState.cityAreas;
    const areaId = Object.keys(slice.network.areas)[0];
    const linkId = Object.keys(slice.network.links)[0];
    expect(setAreaDevelopment(slice, areaId, 2)).toBe(1);
    expect(setAreaDevelopment(slice, areaId, -1)).toBe(0);
    expect(setAreaDevelopment(slice, 'ghost', 0.5)).toBe(0);
    expect(setLinkCondition(slice, linkId, 7)).toBe(1);
    expect(setLinkCondition(slice, 'ghost', 0.5)).toBe(0);
    game.dispose();
  });
});
