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
 * THE Roads-toggle defect (user report): the map's visible "roads" are the
 * City Areas network's ROAD ribbons (they ride above and follow the same
 * polylines as the thin dedicated roads layer), so toggling that layer alone
 * changed nothing on screen. The fix: the renderer forwards the roads flag
 * into the network view — OFF hides the ROAD ribbons, ON restores the SAME
 * mesh. Visibility only: never a rebuild, never a data change.
 */
describe('CityNetworkLayer respects the Roads layer flag', () => {
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

  it('roads ON → road ribbons visible; roads OFF → hidden, city view stays', () => {
    // First sync builds the layer lazily (cityAreas ON, roads ON).
    layer.sync(mapModel, network, true, true);
    expect(layer.group.visible).toBe(true);
    const roadMesh = layer.roadRibbon;
    expect(roadMesh).not.toBeNull();
    expect(roadMesh!.visible).toBe(true);

    // ROADS OFF: the road ribbons hide, the City Areas view itself stays ON
    // (discs/rings/junctions are not road display).
    layer.sync(mapModel, network, true, false);
    expect(layer.group.visible).toBe(true);
    expect(roadMesh!.visible).toBe(false);

    // ROADS ON: the SAME mesh comes back — no rebuild, no data change.
    layer.sync(mapModel, network, true, true);
    expect(layer.roadRibbon).toBe(roadMesh);
    expect(roadMesh!.visible).toBe(true);
  });

  it('toggling never touches the network data (hide ≠ delete)', () => {
    const connectionsBefore = cityConnectionsOf(network);
    const snapshot = connectionsBefore.map((connection) => connection.id).sort();
    layer.sync(mapModel, network, true, false);
    layer.sync(mapModel, network, true, true);
    const connectionsAfter = cityConnectionsOf(network);
    expect(connectionsAfter.length).toBe(connectionsBefore.length);
    expect(connectionsAfter.map((connection) => connection.id).sort()).toEqual(snapshot);
  });

  it('a selected ROAD connection never stays highlighted while roads are hidden', () => {
    const roadConnection = cityConnectionsOf(network).find(
      (connection) => connection.kind === 'road'
    );
    expect(roadConnection).toBeDefined();
    layer.setSelectedConnection(roadConnection!.id);
    layer.sync(mapModel, network, true, true);
    const emphasisWhenOn = layer.group.children.filter(
      (child) => (child as THREE.Mesh).isMesh && child.renderOrder === 11
    );
    expect(emphasisWhenOn.length).toBe(1);

    // Roads OFF → the emphasis (road display) hides with them.
    layer.sync(mapModel, network, true, false);
    const emphasisWhenOff = layer.group.children.filter(
      (child) => (child as THREE.Mesh).isMesh && child.renderOrder === 11
    );
    expect(emphasisWhenOff.length).toBe(0);

    // Roads ON → the emphasis is back.
    layer.sync(mapModel, network, true, true);
    const emphasisRestored = layer.group.children.filter(
      (child) => (child as THREE.Mesh).isMesh && child.renderOrder === 11
    );
    expect(emphasisRestored.length).toBe(1);
    layer.setSelectedConnection(null);
  });

  // ———— THE remaining defect (user report): the capital-to-capital RAILWAY
  // spine (and sea links) rendered through the SAME layer but bypassed the
  // Roads toggle — only the road-class mesh followed it. ONE visibility
  // source now governs EVERY transport ribbon class. ————
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

  it('roads OFF hides EVERY transport ribbon — capital spine included; ON restores the SAME meshes', () => {
    layer.sync(mapModel, network, true, true);
    const roadMesh = layer.roadRibbon;
    const otherMesh = layer.otherRibbon; // railway + sea ribbons
    expect(roadMesh).not.toBeNull();
    expect(otherMesh).not.toBeNull();
    expect(roadMesh!.visible).toBe(true);
    expect(otherMesh!.visible).toBe(true);

    // ROADS OFF → BOTH meshes hide (nothing road-like remains on the map).
    layer.sync(mapModel, network, true, false);
    expect(layer.group.visible).toBe(true); // the City Areas view itself stays
    expect(roadMesh!.visible).toBe(false);
    expect(otherMesh!.visible).toBe(false);

    // ROADS ON → the SAME meshes return (visibility only — never a rebuild).
    layer.sync(mapModel, network, true, true);
    expect(layer.roadRibbon).toBe(roadMesh);
    expect(layer.otherRibbon).toBe(otherMesh);
    expect(roadMesh!.visible).toBe(true);
    expect(otherMesh!.visible).toBe(true);
  });

  it('a selected RAILWAY (capital) connection also never stays highlighted while roads are hidden', () => {
    const railwayConnection = cityConnectionsOf(network).find(
      (connection) => connection.kind === 'railway'
    );
    expect(railwayConnection).toBeDefined();
    layer.setSelectedConnection(railwayConnection!.id);
    layer.sync(mapModel, network, true, true);
    const emphasisWhenOn = layer.group.children.filter(
      (child) => (child as THREE.Mesh).isMesh && child.renderOrder === 11
    );
    expect(emphasisWhenOn.length).toBe(1);

    layer.sync(mapModel, network, true, false);
    const emphasisWhenOff = layer.group.children.filter(
      (child) => (child as THREE.Mesh).isMesh && child.renderOrder === 11
    );
    expect(emphasisWhenOff.length).toBe(0);

    layer.sync(mapModel, network, true, true);
    const emphasisRestored = layer.group.children.filter(
      (child) => (child as THREE.Mesh).isMesh && child.renderOrder === 11
    );
    expect(emphasisRestored.length).toBe(1);
    layer.setSelectedConnection(null);
  });
});
