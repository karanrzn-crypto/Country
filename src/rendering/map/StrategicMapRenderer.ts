import * as THREE from 'three';
import type { SystemContext } from '../../core/GameContext';
import type { MapSlice } from '../../state/slices/mapSlice';
import { MAP_LAYER_ORDER, type MapLayerId } from '../../world/map/MapLayers';
import type { StrategicMapModel } from '../../world/map/MapTypes';
import { MapCamera } from './MapCamera';
import { CountryLayer } from './CountryLayer';
import { BorderLayer } from './BorderLayer';
import { CityLayer } from './CityLayer';
import { LabelLayer } from './LabelLayer';
import type { MapTheme } from './MapTheme';

/**
 * StrategicMapRenderer — the 2D political-map render path (Part 1).
 *
 * Builds one Three.js group per map layer (fixed bottom→top order from
 * MAP_LAYER_ORDER), mirrors layer visibility + selection + logical camera
 * from the map state slice each frame, and applies zoom-based label LOD.
 *
 * All map LOGIC lives in world/map + state; this class only projects state
 * to the screen (renderer as pure view).
 */
export class StrategicMapRenderer {
  private readonly root = new THREE.Group();
  private readonly layerGroups = new Map<MapLayerId, THREE.Group>();
  private readonly camera: MapCamera;
  private readonly countryLayer: CountryLayer;
  private readonly borderLayer: BorderLayer;
  private readonly cityLayer: CityLayer;
  private readonly labelLayer: LabelLayer;
  private readonly ocean: THREE.Mesh;
  private readonly disposables: { dispose(): void }[] = [];
  private readonly model: StrategicMapModel;
  private readonly theme: MapTheme;
  private lastSelectionKey = '';

  constructor(scene: THREE.Scene, context: SystemContext, theme: MapTheme) {
    const model = context.map;
    this.model = model;
    this.theme = theme;

    // Ocean plane: big, flat, below everything; togglable like any layer.
    const oceanGeometry = new THREE.PlaneGeometry(
      (model.bounds.maxX - model.bounds.minX) * 6,
      (model.bounds.maxZ - model.bounds.minZ) * 6
    );
    oceanGeometry.rotateX(-Math.PI / 2);
    const oceanMaterial = new THREE.MeshBasicMaterial({ color: theme.oceanColor });
    this.ocean = new THREE.Mesh(oceanGeometry, oceanMaterial);
    this.ocean.position.set(
      (model.bounds.minX + model.bounds.maxX) / 2,
      -0.5,
      (model.bounds.minZ + model.bounds.maxZ) / 2
    );
    this.ocean.renderOrder = 0;
    this.disposables.push(oceanGeometry, oceanMaterial);

    scene.background = new THREE.Color(theme.oceanTone);

    this.countryLayer = new CountryLayer(model, theme);
    this.borderLayer = new BorderLayer(model, theme);
    this.cityLayer = new CityLayer(model, theme);
    this.labelLayer = new LabelLayer(model, theme);
    this.disposables.push(this.countryLayer, this.borderLayer, this.cityLayer, this.labelLayer);

    this.camera = new MapCamera(
      context.state.map.viewport.width,
      context.state.map.viewport.height
    );

    // Fixed layer order (bottom → top) — borders/cities/labels can never be
    // hidden by fills because they sit above them in both order and height.
    const groups: Record<MapLayerId, THREE.Group> = {
      ocean: new THREE.Group(),
      land: this.countryLayer.landGroup,
      countries: this.countryLayer.countryGroup,
      provinceBorders: this.borderLayer.provinceGroup,
      countryBorders: this.borderLayer.countryGroup,
      cities: this.cityLayer.citiesGroup,
      capitals: this.cityLayer.capitalsGroup,
      labels: new THREE.Group()
    };
    groups.countryBorders.add(this.borderLayer.coastGroup);
    groups.labels.add(this.labelLayer.countryGroup);
    groups.labels.add(this.labelLayer.cityGroup);

    this.root.add(this.ocean);
    for (const layerId of MAP_LAYER_ORDER) {
      const group = groups[layerId];
      this.layerGroups.set(layerId, group);
      this.root.add(group);
    }
    scene.add(this.root);
  }

  /** Per-frame view sync: camera, layer visibility, selection, label LOD. */
  update(state: MapSlice, cityLabelMaxViewHeight: number): void {
    const camera = state.camera;
    this.camera.sync(camera.x, camera.z, camera.viewHeight);

    for (const [layerId, group] of this.layerGroups) {
      group.visible = state.layerVisibility[layerId] !== false;
    }

    const selectionKey = `${state.selectedCountryId}|${state.selectedProvinceId}|${state.selectedCityId}`;
    if (selectionKey !== this.lastSelectionKey) {
      this.lastSelectionKey = selectionKey;
      this.countryLayer.setSelection(state.selectedCountryId, this.theme);
      this.cityLayer.setSelectedCity(state.selectedCityId, this.model);
    }

    this.labelLayer.applyZoomLod(camera.viewHeight, cityLabelMaxViewHeight);
  }

  getCamera(): MapCamera {
    return this.camera;
  }

  get meshCount(): number {
    let count = 0;
    this.root.traverse((object) => {
      if ((object as THREE.Mesh).isMesh || (object as THREE.LineSegments).isLineSegments) count++;
    });
    return count;
  }

  dispose(scene: THREE.Scene): void {
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
    scene.remove(this.root);
    this.root.clear();
  }
}
