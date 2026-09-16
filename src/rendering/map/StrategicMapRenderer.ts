import * as THREE from 'three';
import type { SystemContext } from '../../core/GameContext';
import type { GameState } from '../../state/GameState';
import { MAP_LAYER_ORDER, type MapLayerId } from '../../world/map/MapLayers';
import type { StrategicMapModel } from '../../world/map/MapTypes';
import { MapCamera } from './MapCamera';
import { CountryLayer } from './CountryLayer';
import { BorderLayer } from './BorderLayer';
import { CityLayer } from './CityLayer';
import { LabelLayer } from './LabelLayer';
import { SurfaceLayer, type SurfaceMode } from './MapSurface';
import {
  createPopulationFillLayer,
  createEconomyFillLayer,
  createRoadsLayer,
  createRailwaysLayer,
  createSeaRoutesLayer,
  RiverLayer,
  SiteLayer,
  type CellFillLayer
} from './FeatureLayers';
import type { MapTheme } from './MapTheme';

/**
 * StrategicMapRenderer — the 2D political-map render path.
 *
 * Builds one Three.js group per map layer (fixed bottom→top order from
 * MAP_LAYER_ORDER — the data-driven registry), mirrors layer visibility +
 * selection from the game state each frame, and drives:
 * - the SMOOTHED presentation camera (damped zoom/pan, cursor-anchored zoom
 *   gestures arrive via the map.zoomGesture event channel);
 * - the label LOD (fade/cull/collision/cap — see LabelLod).
 *
 * Part-3 information layers (biomes/terrain/rivers/roads/sites/population/
 * economy) are LAZY: their GPU objects are created on the first visibility,
 * toggling only flips group.visible. The economy layer rebuilds whenever it
 * is (re)shown, so it always reflects the live country state.
 *
 * All map LOGIC lives in world/map + state; this class only projects state
 * to the screen (renderer as pure view — never a source of truth).
 */
export class StrategicMapRenderer {
  private readonly root = new THREE.Group();
  private readonly layerGroups = new Map<MapLayerId, THREE.Group>();
  private readonly camera: MapCamera;
  private readonly countryLayer: CountryLayer;
  private readonly borderLayer: BorderLayer;
  private readonly cityLayer: CityLayer;
  private readonly labelLayer: LabelLayer;
  private readonly surfaceLayer: SurfaceLayer;
  private readonly fillLayers = new Map<MapLayerId, CellFillLayer>();
  private readonly lazyLayers = new Map<
    MapLayerId,
    { ensureBuilt(model: StrategicMapModel): void; dispose(): void }
  >();
  private readonly ocean: THREE.Mesh;
  private readonly disposables: { dispose(): void }[] = [];
  private readonly unsubscribes: (() => void)[] = [];
  private readonly model: StrategicMapModel;
  private readonly theme: MapTheme;
  private readonly columns: number;
  private lastSelectionKey = '';
  private lastPlayerCountryId: string | null = null;

  constructor(scene: THREE.Scene, context: SystemContext, theme: MapTheme) {
    const model = context.map;
    this.model = model;
    this.theme = theme;
    this.columns = context.config.map.columns;

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

    // —— Part-3 information layers (lazy, data-driven colors from the theme) ——
    // The land SURFACE is ONE merged mesh whose exclusive mode follows the
    // layer flags (biomes XOR terrain — enforced by the layer-state policy;
    // rivers/water render ABOVE the surface as their own layer).
    const surfaceLayer = new SurfaceLayer(this.columns);
    this.surfaceLayer = surfaceLayer;
    const populationLayer = createPopulationFillLayer(this.columns, theme);
    const economyLayer = createEconomyFillLayer(this.columns, theme, (countryId) => {
      const country = context.state.countries.countries[countryId];
      return country !== undefined ? country.economy.gdp : 0;
    });
    const riverLayer = new RiverLayer(this.columns, theme);
    const roadsLayer = createRoadsLayer(theme);
    const railwaysLayer = createRailwaysLayer(theme);
    const seaRoutesLayer = createSeaRoutesLayer(theme);
    const portsLayer = new SiteLayer(['port'], 'circle', theme);
    const industryLayer = new SiteLayer(['farm', 'factory'], 'square', theme);
    const resourcesLayer = new SiteLayer(['mine', 'oil'], 'diamond', theme);
    const militaryLayer = new SiteLayer(['base', 'airbase'], 'pentagon', theme);
    // Ports & Maritime is ONE user-facing layer: port markers + sea routes.
    portsLayer.group.add(seaRoutesLayer.group);
    this.fillLayers.set('population', populationLayer);
    this.fillLayers.set('economy', economyLayer);
    const lazyEntries: readonly (readonly [
      MapLayerId,
      { ensureBuilt(model: StrategicMapModel): void; dispose(): void }
    ])[] = [
      ['biomes', {
        ensureBuilt: (model) => surfaceLayer.ensureBuilt(model, theme),
        dispose: () => surfaceLayer.dispose()
      }],
      ['terrain', {
        ensureBuilt: (model) => surfaceLayer.ensureBuilt(model, theme),
        dispose: () => surfaceLayer.dispose()
      }],
      ['population', populationLayer],
      ['economy', economyLayer],
      ['rivers', riverLayer],
      ['roads', roadsLayer],
      ['railways', railwaysLayer],
      ['ports', {
        ensureBuilt: (model) => {
          portsLayer.ensureBuilt(model);
          seaRoutesLayer.ensureBuilt(model);
        },
        dispose: () => {
          portsLayer.dispose();
          seaRoutesLayer.dispose();
        }
      }],
      ['industry', industryLayer],
      ['resources', resourcesLayer],
      ['military', militaryLayer]
    ];
    for (const [layerId, layer] of lazyEntries) {
      this.lazyLayers.set(layerId, layer);
      this.disposables.push(layer);
    }

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
    // The biomes and terrain layer groups are THE SAME SurfaceLayer group:
    // one land-surface mesh serves both (only ONE is ever active — they are
    // exclusive surface colorings, enforced in the layer state).
    const groups: Record<MapLayerId, THREE.Group> = {
      ocean: new THREE.Group(),
      land: this.countryLayer.landGroup,
      countries: this.countryLayer.countryGroup,
      biomes: surfaceLayer.group,
      terrain: surfaceLayer.group,
      rivers: riverLayer.group,
      provinceBorders: this.borderLayer.provinceGroup,
      cityAreas: this.cityLayer.cityAreasGroup,
      countryBorders: this.borderLayer.countryGroup,
      roads: roadsLayer.group,
      railways: railwaysLayer.group,
      ports: portsLayer.group,
      industry: industryLayer.group,
      resources: resourcesLayer.group,
      military: militaryLayer.group,
      cities: this.cityLayer.citiesGroup,
      capitals: this.cityLayer.capitalsGroup,
      population: populationLayer.group,
      economy: economyLayer.group,
      weather: new THREE.Group(), // extensible stub — future weather systems fill it
      intelligence: new THREE.Group(), // extensible stub — future intel systems fill it
      labels: this.labelLayer.group
    };
    groups.countryBorders.add(this.borderLayer.coastGroup);

    this.root.add(this.ocean);
    for (const layerId of MAP_LAYER_ORDER) {
      const group = groups[layerId];
      this.layerGroups.set(layerId, group);
      this.root.add(group);
    }
    // Selection + player emphasis: independent overlays above every togglable layer.
    this.root.add(this.borderLayer.selectionGroup);
    this.root.add(this.borderLayer.playerGroup);
    scene.add(this.root);
  }

  /** Per-frame view sync: smoothed camera, layers, selection, label LOD. */
  update(state: GameState, dtSeconds: number): void {
    const map = state.map;
    // 0. Keep the presentation viewport in lock-step with the logical one
    //    (resize-safe aspect: picking and labels never drift after a resize).
    this.camera.setViewport(map.viewport.width, map.viewport.height);
    // 1. Advance the damped presentation camera toward the logical target.
    this.camera.update(dtSeconds, {
      x: map.camera.x,
      z: map.camera.z,
      viewHeight: map.camera.viewHeight
    });

    // 2. Layer visibility toggles — lazy layers build on their FIRST show.
    //    (biomes/terrain share ONE surface group; handled after the loop.)
    for (const [layerId, group] of this.layerGroups) {
      if (layerId === 'biomes' || layerId === 'terrain') continue;
      const visible = map.layerVisibility[layerId] !== false;
      if (visible && this.lazyLayers.has(layerId)) {
        const layer = this.lazyLayers.get(layerId);
        if (layer !== undefined) {
          // Economy re-reads the LIVE country values whenever it (re)shows.
          if (layerId === 'economy' && this.fillLayers.get('economy')?.isBuilt === true) {
            this.fillLayers.get('economy')?.invalidate();
          }
          layer.ensureBuilt(this.model);
        }
      }
      group.visible = visible;
    }

    // 2b. The land surface: exclusive mode follows the layer flags (biomes
    // XOR terrain — the layer-state policy guarantees at most one is on; if
    // a hand-crafted state ever carries both, the registry's FIRST member
    // wins, matching normalizeLayerVisibility). The mesh rebuilds ONLY when
    // the mode changes (SurfaceLayer checks internally).
    const biomesOn = map.layerVisibility.biomes === true;
    const terrainOn = map.layerVisibility.terrain === true;
    const mode: SurfaceMode = biomesOn ? 'biomes' : terrainOn ? 'terrain' : 'political';
    const surfaceGroup = this.layerGroups.get('biomes');
    if (surfaceGroup !== undefined) {
      surfaceGroup.visible = biomesOn || terrainOn;
      this.surfaceLayer.setMode(mode);
      if (surfaceGroup.visible) {
        const layer = this.lazyLayers.get(biomesOn ? 'biomes' : 'terrain');
        if (layer !== undefined) layer.ensureBuilt(this.model);
      }
    }

    // 3. Selection (country highlight, city ring, border emphasis) + the
    //    persistent player-country outline (rebuilt only on change).
    const selectionKey = `${map.selectedCountryId}|${map.selectedProvinceId}|${map.selectedCityId}`;
    if (selectionKey !== this.lastSelectionKey) {
      this.lastSelectionKey = selectionKey;
      this.countryLayer.setSelection(map.selectedCountryId, this.theme);
      this.cityLayer.setSelectedCity(map.selectedCityId, this.model);
      this.borderLayer.setSelectedCountry(map.selectedCountryId, this.model, this.theme);
    }
    const playerCountryId = state.player.countryConfirmed ? state.player.countryId : null;
    if (playerCountryId !== this.lastPlayerCountryId) {
      this.lastPlayerCountryId = playerCountryId;
      this.borderLayer.setPlayerCountry(playerCountryId, this.model, this.theme);
    }

    // 4. Label LOD — decision pass + sprite sync from the DAMPED camera view.
    const view = this.camera.view;
    this.labelLayer.update(
      {
        centerX: view.x,
        centerZ: view.z,
        viewHeight: view.viewHeight,
        aspect: this.camera.aspect,
        viewportWidthPx: map.viewport.width,
        viewportHeightPx: map.viewport.height
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
