import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import { CityNetworkLayer } from '../../../rendering/map/CityNetworkLayer';
import { buildCityAreaNetwork } from '../../../world/cityareas/CityAreaGenerator';
import { cityConnectionsOf } from '../../../world/cityareas/CityConnections';
import { generateStrategicMap } from '../../../world/map/MapGenerator';
import { DEFAULT_MAP_CONFIG } from '../../helpers/mapTestConfig';
import themeJson from '../../../data/mapTheme.json';
import type { MapThemeData } from '../../../data/types';
import type { CityAreaNetwork } from '../../../world/cityareas/CityAreaTypes';
import type { StrategicMapModel } from '../../../world/map/MapTypes';

const theme = themeJson as unknown as MapThemeData;
const { model } = generateStrategicMap(DEFAULT_MAP_CONFIG);

/**
 * THE layer contract (spec §1/§2): Urban Areas + Roads is ONE toggle, and
 * Railways are FULLY INDEPENDENT of it.
 *  - urbanRoads OFF hides the ROAD ribbons (and the urban discs/rings) while
 *    the RAILWAY ribbons keep following THEIR own flag;
 *  - railways OFF hides the railway ribbons (the capital-to-capital spine)
 *    without touching the road side;
 *  - every flip is visibility-only: the SAME meshes come back — never a
 *    rebuild, never a data change.
 */
describe('CityNetworkLayer: merged Urban+Roads toggle, independent Railways', () => {
  let layer: CityNetworkLayer;
  let network: CityAreaNetwork;
  let mapModel: StrategicMapModel;

  beforeAll(() => {
    mapModel = model;
    network = buildCityAreaNetwork(mapModel, DEFAULT_MAP_CONFIG.columns).network;
    layer = new CityNetworkLayer(
      DEFAULT_MAP_CONFIG.columns,
      DEFAULT_MAP_CONFIG.rows,
      DEFAULT_MAP_CONFIG.cellSize,
      theme
    );
  });

  it('the premise holds — the network actually contains road-class routes', () => {
    const connections = cityConnectionsOf(network);
    expect(connections.length).toBeGreaterThan(0);
    expect(connections.some((connection) => connection.kind === 'road')).toBe(true);
  });

  it('the premise holds — the network contains capital-to-capital railway routes', () => {
    const connections = cityConnectionsOf(network);
    const railwayConnections = connections.filter((connection) => connection.kind === 'railway');
    expect(railwayConnections.length).toBeGreaterThan(0);
    // The railway spine connects CAPITALS of the countries by construction
    // (MapFeatures: MST over the capitals).
    const capitalPairs = railwayConnections.filter((connection) => {
      const a = mapModel.cities[connection.cityA];
      const b = mapModel.cities[connection.cityB];
      return a?.isCapital === true && b?.isCapital === true;
    });
    expect(capitalPairs.length).toBeGreaterThan(0);
  });

  it('urbanRoads OFF hides road ribbons; Railways flag keeps the rail ribbons', () => {
    // First sync builds the layer lazily (both systems ON).
    layer.sync(mapModel, network, true, true, true);
    const roadMesh = layer.roadRibbon;
    const railMesh = layer.railRibbon;
    expect(roadMesh).not.toBeNull();
    expect(railMesh).not.toBeNull();
    expect(roadMesh!.visible).toBe(true);
    expect(railMesh!.visible).toBe(true);

    // Urban+Roads OFF → road ribbons hide, RAIL ribbons STAY (independent).
    layer.sync(mapModel, network, false, true, true);
    expect(layer.urbanGroup.visible).toBe(false);
    expect(layer.railGroup.visible).toBe(true);
    expect(roadMesh!.visible).toBe(false);
    expect(railMesh!.visible).toBe(true);

    // Back ON → the SAME road mesh returns (visibility only).
    layer.sync(mapModel, network, true, true, true);
    expect(layer.roadRibbon).toBe(roadMesh);
    expect(roadMesh!.visible).toBe(true);
  });

  it('railways OFF hides the capital spine; roads stay; no cross-influence either way', () => {
    layer.sync(mapModel, network, true, true, true);
    const roadMesh = layer.roadRibbon!;
    const railMesh = layer.railRibbon!;

    // Railways OFF → rail ribbons hide, road ribbons STAY.
    layer.sync(mapModel, network, true, false, true);
    expect(layer.railGroup.visible).toBe(false);
    expect(layer.urbanGroup.visible).toBe(true);
    expect(railMesh.visible).toBe(false);
    expect(roadMesh.visible).toBe(true);

    // Railways back ON → the SAME mesh returns.
    layer.sync(mapModel, network, true, true, true);
    expect(layer.railRibbon).toBe(railMesh);
    expect(railMesh.visible).toBe(true);
  });

  it('BOTH systems OFF → nothing transport-like remains; data never deleted', () => {
    const connectionsBefore = cityConnectionsOf(network);
    const snapshot = connectionsBefore.map((connection) => connection.id).sort();

    layer.sync(mapModel, network, true, true, true);
    const roadMesh = layer.roadRibbon!;
    const railMesh = layer.railRibbon!;

    // OFF / OFF (spec's matrix) → both hidden.
    layer.sync(mapModel, network, false, false, false);
    expect(layer.urbanGroup.visible).toBe(false);
    expect(layer.railGroup.visible).toBe(false);
    expect(roadMesh.visible).toBe(false);
    expect(railMesh.visible).toBe(false);

    // ON again → the SAME meshes, and the network data is untouched.
    layer.sync(mapModel, network, true, true, true);
    expect(layer.roadRibbon).toBe(roadMesh);
    expect(layer.railRibbon).toBe(railMesh);
    const connectionsAfter = cityConnectionsOf(network);
    expect(connectionsAfter.length).toBe(connectionsBefore.length);
    expect(connectionsAfter.map((connection) => connection.id).sort()).toEqual(snapshot);
  });

  it('a selected ROAD connection never stays highlighted while urbanRoads is hidden', () => {
    const roadConnection = cityConnectionsOf(network).find(
      (connection) => connection.kind === 'road'
    );
    expect(roadConnection).toBeDefined();
    layer.setSelectedConnection(roadConnection!.id);
    layer.sync(mapModel, network, true, true, true);
    const emphasisIn = (group: THREE.Group) =>
      group.children.filter((child) => (child as THREE.Mesh).isMesh && child.renderOrder === 11);
    expect(emphasisIn(layer.urbanGroup).length).toBe(1);

    // Urban+Roads OFF → the road emphasis hides.
    layer.sync(mapModel, network, false, true, true);
    expect(emphasisIn(layer.urbanGroup).length).toBe(0);

    // ON → back.
    layer.sync(mapModel, network, true, true, true);
    expect(emphasisIn(layer.urbanGroup).length).toBe(1);
    layer.setSelectedConnection(null);
  });

  it('a selected RAILWAY (capital) connection follows the RAILWAYS flag, not roads', () => {
    const railwayConnection = cityConnectionsOf(network).find(
      (connection) => connection.kind === 'railway'
    );
    expect(railwayConnection).toBeDefined();
    layer.setSelectedConnection(railwayConnection!.id);
    layer.sync(mapModel, network, true, true, true);
    const emphasisIn = (group: THREE.Group) =>
      group.children.filter((child) => (child as THREE.Mesh).isMesh && child.renderOrder === 11);
    expect(emphasisIn(layer.railGroup).length).toBe(1);

    // THE independent-systems proof: roads OFF + railways ON → the railway
    // emphasis STAYS (the old bug: it disappeared with the roads toggle).
    layer.sync(mapModel, network, false, true, true);
    expect(emphasisIn(layer.railGroup).length).toBe(1);

    // Railways OFF → it hides.
    layer.sync(mapModel, network, true, false, true);
    expect(emphasisIn(layer.railGroup).length).toBe(0);

    layer.sync(mapModel, network, true, true, true);
    expect(emphasisIn(layer.railGroup).length).toBe(1);
    layer.setSelectedConnection(null);
  });
});
