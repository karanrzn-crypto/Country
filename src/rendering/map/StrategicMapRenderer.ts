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
 * StrategicMapRenderer — the 2D political-map render path.
 *
 * Builds one Three.js group per map layer (fixed bottom→top order from
 * MAP_LAYER_ORDER), mirrors layer visibility + selection from the map state
 * slice each frame, and drives:
 * - the SMOOTHED presentation camera (damped zoom/pan, cursor-anchored zoom
 *   gestures arrive via the map.zoomGesture event channel);
 * - the label LOD (fade/cull/collision/cap — see LabelLod).
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
  private readonly unsubscribes: (() => void)[] = [];
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

    const mapState = context.state.map;
    this.camera = new MapCamera(
      mapState.viewport.width,
      mapState.viewport.height,
      { x: mapState.camera.x, z: mapState.camera.z, viewHeight: mapState.camera.viewHeight }
    );
    this.camera.setLimits({
      bounds: model.bounds,
      minViewHeight: context.config.map.minViewHeight,
      maxViewHeight: context.config.map.maxViewHeight
    });
    this.unsubscribes.push(
      context.events.on('map.zoomGesture', ({ anchor }) => {
        if (anchor === null) this.camera.cancelZoomGesture();
        else {
          this.camera.beginZoomGesture({
            anchorX: anchor.x,
            anchorZ: anchor.z,
            screenX: anchor.screenX,
            screenY: anchor.screenY
          });
        }
      })
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
      labels: this.labelLayer.group
    };
    groups.countryBorders.add(this.borderLayer.coastGroup);

    this.root.add(this.ocean);
    for (const layerId of MAP_LAYER_ORDER) {
      const group = groups[layerId];
      this.layerGroups.set(layerId, group);
      this.root.add(group);
    }
    // Selection emphasis: independent overlay above every togglable layer.
    this.root.add(this.borderLayer.selectionGroup);
    scene.add(this.root);
  }

  /** Per-frame view sync: smoothed camera, layers, selection, label LOD. */
  update(state: MapSlice, dtSeconds: number): void {
    // 0. Keep the presentation viewport in lock-step with the logical one
    //    (resize-safe aspect: picking and labels never drift after a resize).
    this.camera.setViewport(state.viewport.width, state.viewport.height);
    // 1. Advance the damped presentation camera toward the logical target.
    this.camera.update(dtSeconds, {
      x: state.camera.x,
      z: state.camera.z,
      viewHeight: state.camera.viewHeight
    });

    // 2. Layer visibility toggles.
    for (const [layerId, group] of this.layerGroups) {
      group.visible = state.layerVisibility[layerId] !== false;
    }

    // 3. Selection (country highlight, city ring, border emphasis).
    const selectionKey = `${state.selectedCountryId}|${state.selectedProvinceId}|${state.selectedCityId}`;
    if (selectionKey !== this.lastSelectionKey) {
      this.lastSelectionKey = selectionKey;
      this.countryLayer.setSelection(state.selectedCountryId, this.theme);
      this.cityLayer.setSelectedCity(state.selectedCityId, this.model);
      this.borderLayer.setSelectedCountry(state.selectedCountryId, this.model, this.theme);
    }

    // 4. Label LOD — decision pass + sprite sync from the DAMPED camera view.
    const view = this.camera.view;
    this.labelLayer.update(
      {
        centerX: view.x,
        centerZ: view.z,
        viewHeight: view.viewHeight,
        aspect: this.camera.aspect,
        viewportWidthPx: state.viewport.width,
        viewportHeightPx: state.viewport.height
      },
      dtSeconds
    );
  }

  getCamera(): MapCamera {
    return this.camera;
  }

  get renderedLabelCount(): number {
    return this.labelLayer.renderedCount;
  }

  get meshCount(): number {
    let count = 0;
    this.root.traverse((object) => {
      if ((object as THREE.Mesh).isMesh || (object as THREE.LineSegments).isLineSegments) count++;
    });
    return count;
  }

  dispose(scene: THREE.Scene): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes.length = 0;
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
    scene.remove(this.root);
    this.root.clear();
  }
}
