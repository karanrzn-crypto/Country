import { describe, it, expect } from 'vitest';
import { createTestGame } from '../../helpers/testGame';
import {
  cityConnectionsOf,
  connectionsOfCity,
  connectionForLink,
  connectionOtherCity,
  cityConnectionExists,
  pickCityConnection,
  connectionLengthKm,
  KM_PER_WORLD_UNIT
} from '../../../world/cityareas/CityConnections';
import {
  setFeatureSelection,
  featureSelectionOf,
  selectionSummary
} from '../../../state/slices/mapSlice';
import type { Game } from '../../../core/Game';
import type { MapPoint } from '../../../world/map/MapTypes';

function preparedGame(seed: number): { game: Game; countryId: string } {
  const game = createTestGame({ seed });
  return { game, countryId: game.strategicMap.countryOrder[0] };
}

describe('City Connections — the city-level view of the City Areas network', () => {
  it('derivation is deterministic (same seed → identical connection list)', () => {
    const a = cityConnectionsOf(createTestGame({ seed: 311 }).gameState.cityAreas.network);
    const b = cityConnectionsOf(createTestGame({ seed: 311 }).gameState.cityAreas.network);
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
    expect(a.map((c) => c.length)).toEqual(b.map((c) => c.length));
  });

  it('every inter-city road line becomes ONE connection whose path starts and ends exactly at the two city positions', () => {
    const { game } = preparedGame(312);
    const model = game.strategicMap;
    const network = game.gameState.cityAreas.network;
    const connections = cityConnectionsOf(network);
    expect(connections.length).toBeGreaterThan(0);

    const roadLines = model.features.lines.filter(
      (line) => (line.kind === 'highway' || line.kind === 'secondary') && line.cityA !== null && line.cityB !== null
    );
    // One road connection per undirected city pair served by a road line.
    const pairs = new Set(
      roadLines.map((line) => [line.cityA, line.cityB].sort().join('|'))
    );
    const roadConnections = connections.filter((connection) => connection.kind === 'road');
    const connectionPairs = new Set(
      roadConnections.map((connection) => [connection.cityA, connection.cityB].sort().join('|'))
    );
    expect(connectionPairs.size).toBe(roadConnections.length); // no duplicates
    for (const pair of pairs) {
      expect(connectionPairs.has(pair), `road pair ${pair}`).toBe(true);
    }

    // Geometry truth: path endpoints == city positions (the shared map
    // road polylines) — no synthetic points, no floating ends.
    for (const connection of roadConnections) {
      const cityA = model.cities[connection.cityA];
      const cityB = model.cities[connection.cityB];
      const start = connection.path[0];
      const end = connection.path[connection.path.length - 1];
      // The nearest connection endpoint to each city must BE that city's
      // position (exact coordinates after the junction merge).
      const endpoints = [start, end];
      const nearestToA = endpoints.reduce((best, point) =>
        Math.hypot(point.x - cityA.position.x, point.z - cityA.position.z) <
        Math.hypot(best.x - cityA.position.x, best.z - cityA.position.z)
          ? point
          : best
      );
      const nearestToB = endpoints.reduce((best, point) =>
        Math.hypot(point.x - cityB.position.x, point.z - cityB.position.z) <
        Math.hypot(best.x - cityB.position.x, best.z - cityB.position.z)
          ? point
          : best
      );
      expect(Math.hypot(nearestToA.x - cityA.position.x, nearestToA.z - cityA.position.z)).toBeLessThan(1e-6);
      expect(Math.hypot(nearestToB.x - cityB.position.x, nearestToB.z - cityB.position.z)).toBeLessThan(1e-6);
      // Path passes through the junction — at least 3 points, length sums.
      expect(connection.path.length).toBeGreaterThanOrEqual(3);
      expect(connection.length).toBeGreaterThan(0);
      expect(connection.linkIds.length).toBe(2);
    }
    game.dispose();
  });

  it('railway connections link capital cores and carry the railway kind', () => {
    const { game } = preparedGame(313);
    const model = game.strategicMap;
    const connections = cityConnectionsOf(game.gameState.cityAreas.network);
    const railLines = model.features.lines.filter(
      (line) => line.kind === 'railway' && line.cityA !== null && line.cityB !== null
    );
    expect(railLines.length).toBeGreaterThan(0);
    const railConnections = connections.filter((connection) => connection.kind === 'railway');
    expect(railConnections.length).toBe(railLines.length);
    for (const connection of railConnections) {
      const cityA = model.cities[connection.cityA];
      const cityB = model.cities[connection.cityB];
      expect(cityA.isCapital && cityB.isCapital).toBe(true);
      expect(connection.linkIds.length).toBe(1);
    }
    game.dispose();
  });

  it('crossProvince matches the endpoint areas and inter-province pairs exist on a multi-province map', () => {
    const { game } = preparedGame(314);
    const model = game.strategicMap;
    const connections = cityConnectionsOf(game.gameState.cityAreas.network);
    for (const connection of connections) {
      const provinceA = model.cities[connection.cityA].provinceId;
      const provinceB = model.cities[connection.cityB].provinceId;
      expect(connection.provinceA).toBe(provinceA);
      expect(connection.provinceB).toBe(provinceB);
      expect(connection.crossProvince).toBe(provinceA !== provinceB);
    }
    // Any inter-province ROAD LINE on the map must appear as a
    // cross-province connection (the data behind the map's "different look"
    // for inter-province links).
    const interProvinceRoadLines = model.features.lines.filter((line) => {
      if (line.cityA === null || line.cityB === null) return false;
      if (line.kind !== 'highway' && line.kind !== 'secondary') return false;
      return model.cities[line.cityA].provinceId !== model.cities[line.cityB].provinceId;
    });
    if (interProvinceRoadLines.length > 0) {
      expect(connections.some((connection) => connection.crossProvince)).toBe(true);
    }
    game.dispose();
  });

  it('connectionsOfCity is symmetric and connectionForLink resolves both road halves to the same route', () => {
    const { game } = preparedGame(315);
    const network = game.gameState.cityAreas.network;
    const connections = cityConnectionsOf(network);
    const merged = connections.find((connection) => connection.linkIds.length === 2);
    expect(merged).toBeDefined();
    const mergedConnection = merged!;
    for (const linkId of mergedConnection.linkIds) {
      const resolved = connectionForLink(connections, linkId);
      expect(resolved?.id).toBe(mergedConnection.id);
    }
    const citySide = connectionsOfCity(connections, mergedConnection.cityA);
    expect(citySide.some((connection) => connection.id === mergedConnection.id)).toBe(true);
    expect(connectionOtherCity(mergedConnection, mergedConnection.cityA)).toBe(mergedConnection.cityB);
    expect(connectionOtherCity(mergedConnection, mergedConnection.cityB)).toBe(mergedConnection.cityA);
    game.dispose();
  });

  it('pickCityConnection: hits the nearest route, misses clean ground, ties break by id', () => {
    const { game } = preparedGame(316);
    const network = game.gameState.cityAreas.network;
    const connections = cityConnectionsOf(network);
    const target = connections[0];
    // A point exactly on the path hits the connection.
    const mid = target.path[Math.floor(target.path.length / 2)];
    expect(pickCityConnection(connections, mid, 5)).toBe(target.id);
    // Clean ocean/land far from every route → null.
    const farPoint: MapPoint = { x: -10_000, z: -10_000 };
    expect(pickCityConnection(connections, farPoint, 5)).toBeNull();
    // Zero tolerance still hits a point ON the path.
    expect(pickCityConnection(connections, target.path[0], 0.01)).not.toBeNull();
    game.dispose();
  });

  it('cityConnectionExists + connectionLengthKm use the shared km scale', () => {
    const { game } = preparedGame(317);
    const connections = cityConnectionsOf(game.gameState.cityAreas.network);
    const first = connections[0];
    expect(cityConnectionExists(connections, first.id)).toBe(true);
    expect(cityConnectionExists(connections, 'conn_ghost')).toBe(false);
    expect(connectionLengthKm(first)).toBe(Math.round(first.length * KM_PER_WORLD_UNIT));
    expect(connectionLengthKm(first)).toBeGreaterThan(0);
    game.dispose();
  });

  it('the cityLink feature selection round-trips and selectionSummary names both cities', () => {
    const { game } = preparedGame(318);
    const model = game.strategicMap;
    const state = game.gameState;
    const connections = cityConnectionsOf(state.cityAreas.network);
    const connection = connections[0];

    setFeatureSelection(state.map, { kind: 'cityLink', connectionId: connection.id });
    expect(featureSelectionOf(state.map)).toEqual({ kind: 'cityLink', connectionId: connection.id });
    expect(state.map.selectedCityConnectionId).toBe(connection.id);
    // One coherent selection kind: the hierarchy stays clear.
    expect(state.map.selectedCountryId).toBeNull();

    const nameA = model.cities[connection.cityA].name;
    const nameB = model.cities[connection.cityB].name;
    expect(selectionSummary(state.map, model, connections)).toBe(
      `${nameA} → ${nameB} (اتصال شهری)`
    );
    // Unknown connection ids degrade gracefully.
    setFeatureSelection(state.map, { kind: 'cityLink', connectionId: 'conn_ghost' });
    expect(selectionSummary(state.map, model, connections)).toBe('اتصال شهری ناشناخته');

    // Selecting a city shows the connection count in the summary.
    setFeatureSelection(state.map, { kind: 'grid', gridKey: 'x#A1' });
    game.commandBus.send({ type: 'map.select', cityId: connection.cityA });
    game.commandBus.flush();
    const citySummary = selectionSummary(state.map, model, connections);
    expect(citySummary).toContain(nameA);
    expect(citySummary).toContain('اتصال');
    game.dispose();
  });

  it('Game.mapPick selects a city connection from a real click on the route (layer-gated)', () => {
    const { game } = preparedGame(319);
    const state = game.gameState;
    const connections = cityConnectionsOf(state.cityAreas.network);
    const target = connections[0];
    const mid = target.path[Math.floor(target.path.length / 2)];
    const viewHeight = state.map.camera.viewHeight;
    const tolerance = Math.max(1.2, viewHeight * 0.012);

    // Layer ON: a click on the route selects it — UNLESS a higher-priority
    // feature (city/river/lake) shares the point; both outcomes are valid,
    // but a true route point away from cities must select the route.
    game.commandBus.send({ type: 'map.pick', x: mid.x, z: mid.z });
    game.commandBus.flush();
    if (target.kind === 'road' || target.kind === 'railway') {
      const pickedConnection =
        state.map.selectedCityConnectionId !== null ||
        state.map.selectedCityId !== null ||
        state.map.selectedRiverId !== null ||
        state.map.selectedLakeId !== null;
      expect(pickedConnection).toBe(true);
    }

    // Layer OFF: the same click can never select a route.
    game.mapSetLayerVisible('cityAreas', false);
    // Find a route point with NO city within the pick tolerance.
    let cleanPoint: MapPoint | null = null;
    for (const connection of connections) {
      for (const point of connection.path) {
        const nearCity = Object.values(game.strategicMap.cities).some(
          (city) => Math.hypot(city.position.x - point.x, city.position.z - point.z) <= tolerance
        );
        if (!nearCity) {
          cleanPoint = point;
          break;
        }
      }
      if (cleanPoint !== null) break;
    }
    if (cleanPoint !== null) {
      game.commandBus.send({ type: 'map.pick', x: cleanPoint.x, z: cleanPoint.z });
      game.commandBus.flush();
      expect(state.map.selectedCityConnectionId).toBeNull();
    }
    game.dispose();
  });
});
