import * as THREE from 'three';
import type { SystemContext } from '../../core/GameContext';
import type { GameState } from '../../state/GameState';
import { MAP_LAYER_ORDER, type MapLayerId } from '../../world/map/MapLayers';
import { gridCellKey, type StrategicMapModel } from '../../world/map/MapTypes';
import { cellEconomyTintOf } from '../../economy/resources';
import { findGridCell } from '../../world/map/MapGeography';
import { MapCamera } from './MapCamera';
import { CountryLayer } from './CountryLayer';
import { BorderLayer } from './BorderLayer';
import { CityLayer } from './CityLayer';
import { CityNetworkLayer } from './CityNetworkLayer';
import { LabelLayer } from './LabelLayer';
import { SurfaceLayer, economyTintRGB, type SurfaceMode, type RGB } from './MapSurface';
import {
  createPopulationFillLayer,
  createEconomyFillLayer,
  createStrategicFillLayer,
  createRoadsLayer,
  createRailwaysLayer,
  createSeaRoutesLayer,
  RiverLayer,
  LakeLayer,
  GridLayer,
  BuildingsLayer,
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
 * Part-3 information layers (biomes/terrain/rivers/sites/population/
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
  /** The REAL City Areas view — the live city network (state.cityAreas). */
  private readonly cityNetworkLayer: CityNetworkLayer;
  private readonly labelLayer: LabelLayer;
  private readonly gridLayer: GridLayer;
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
    this.cityNetworkLayer = new CityNetworkLayer(
      this.columns,
      context.config.map.rows,
      context.config.map.cellSize,
      theme
    );
    this.labelLayer = new LabelLayer(model, theme, this.columns);
    this.disposables.push(
      this.countryLayer,
      this.borderLayer,
      this.cityLayer,
      this.cityNetworkLayer,
      this.labelLayer
    );

    // —— Part-3 information layers (lazy, data-driven colors from the theme) ——
    // The land SURFACE is ONE merged mesh whose exclusive mode follows the
    // layer flags (biomes XOR terrain — enforced by the layer-state policy;
    // rivers/water render ABOVE the surface as their own layer).
    const surfaceLayer = new SurfaceLayer(this.columns);
    this.surfaceLayer = surfaceLayer;
    const populationLayer = createPopulationFillLayer(this.columns, theme);
    // Economy tint (spec §3): the LIVE economic building of each cell — the
    // type's own theme color, the PALE variant while it is still under
    // construction, and NO tint on building-free cells. The tint lookup is
    // cached per rebuild (one Map, dropped on every construction event) so
    // the per-cell state reads stay cheap on big maps.
    let economyTintCache: Map<string, RGB | null> | null = null;
    const economyTintFor = (cellKey: string): RGB | null => {
      if (economyTintCache === null) economyTintCache = new Map<string, RGB | null>();
      const cached = economyTintCache.get(cellKey);
      if (cached !== undefined) return cached;
      const tint = cellEconomyTintOf(context.state, cellKey);
      const color = tint !== null ? economyTintRGB(tint.typeId, tint.underConstruction, theme) : null;
      economyTintCache.set(cellKey, color);
      return color;
    };
    const economyLayer = createEconomyFillLayer(this.columns, theme, (cellIndex, model) => {
      const owner = model.features.cellOwner[cellIndex];
      if (owner < 0) return null; // ocean
      const countryId = model.countryOrder[owner];
      const gridId = model.features.gridIds[cellIndex];
      if (countryId === undefined || gridId === null) return null;
      return economyTintFor(gridCellKey(countryId, gridId));
    });
    const strategicLayer = createStrategicFillLayer(this.columns, theme);
    const riverLayer = new RiverLayer(this.columns, theme);
    const lakeLayer = new LakeLayer(this.columns, theme);
    const gridLayer = new GridLayer(this.columns, context.config.map.rows, theme);
    this.gridLayer = gridLayer;
    // Roads/railways FOLLOW THE TERRAIN (grid context) — visible in every
    // surface mode, never buried under lifted relief.
    const lineGrid = {
      columns: this.columns,
      rows: context.config.map.rows,
      cellSize: context.config.map.cellSize
    };
    const roadsLayer = createRoadsLayer(theme, lineGrid);
    const railwaysLayer = createRailwaysLayer(theme, lineGrid);
    const seaRoutesLayer = createSeaRoutesLayer(theme);
    const portsLayer = new SiteLayer(['port'], 'circle', theme);
    const industryLayer = new SiteLayer(['farm', 'factory'], 'square', theme);
    const resourcesLayer = new SiteLayer(['mine', 'oil', 'lumber'], 'diamond', theme);
    const militaryLayer = new SiteLayer(['base', 'airbase'], 'pentagon', theme);
    const airportBuildings = new BuildingsLayer(['airport'], theme);
    const cityBuildings = new BuildingsLayer(
      ['residential', 'industrial', 'commercial', 'government', 'hospital', 'militaryBase', 'railwayStation', 'power'],
      theme
    );
    // Ports & Maritime is ONE user-facing layer: port markers + sea routes.
    portsLayer.group.add(seaRoutesLayer.group);
    this.fillLayers.set('population', populationLayer);
    this.fillLayers.set('economy', economyLayer);
    this.fillLayers.set('strategic', strategicLayer);
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
      ['strategic', strategicLayer],
      ['rivers', riverLayer],
      ['lakes', lakeLayer],
      ['grid', gridLayer],
      ['urbanRoads', roadsLayer],
      ['railways', railwaysLayer],
      ['airports', airportBuildings],
      ['buildings', cityBuildings],
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
      }),
      // Hover highlight (presentation-only): the core resolves the hovered
      // cell, the renderer just paints its preallocated overlay quad.
      context.events.on('map.hoverChanged', ({ hover }) => {
        this.gridLayer.setHoveredCell(hover !== null ? hover.cellIndex : null);
      }),
      // Economy colors follow the LIVE buildings (spec §2/§3): a project
      // starting or completing repaints the economy layer immediately.
      context.events.on('economy.constructionStarted', () => {
        economyTintCache = null;
        const layer = this.fillLayers.get('economy');
        if (layer?.isBuilt === true) layer.invalidate();
      }),
      context.events.on('economy.constructionCompleted', () => {
        economyTintCache = null;
        const layer = this.fillLayers.get('economy');
        if (layer?.isBuilt === true) layer.invalidate();
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
      lakes: lakeLayer.group,
      grid: gridLayer.group,
      // ONE user-facing 'Provinces' layer: province border lines AND the
      // per-province fills (with the selection highlight) live together —
      // toggling it hides/shows the whole province presentation.
      provinceBorders: this.borderLayer.provinceGroup,
      // ONE user-facing 'Urban Areas + Roads' layer (spec): the REAL city
      // connection network's urban view (road ribbons + city highlights +
      // capital rings + junction nodes) AND the thin road lines — ONE toggle
      // drives ONE parent group, so they can never disagree. The network's
      // RAILWAY ribbons are NOT here (independent Railways layer below).
      urbanRoads: (() => {
        const group = new THREE.Group();
        group.add(roadsLayer.group);
        group.add(this.cityNetworkLayer.urbanGroup);
        return group;
      })(),
      // ONE independent 'Railways' layer (spec): the thin railway lines AND
      // the network's railway-class ribbons (the capital-to-capital spine).
      // Neither this flag nor urbanRoads influences the other.
      railways: (() => {
        const group = new THREE.Group();
        group.add(railwaysLayer.group);
        group.add(this.cityNetworkLayer.railGroup);
        return group;
      })(),
      countryBorders: this.borderLayer.countryGroup,
      airports: airportBuildings.group,
      ports: portsLayer.group,
      industry: industryLayer.group,
      buildings: cityBuildings.group,
      resources: resourcesLayer.group,
      military: militaryLayer.group,
      cities: this.cityLayer.citiesGroup,
      capitals: this.cityLayer.capitalsGroup,
      population: populationLayer.group,
      economy: economyLayer.group,
      strategic: strategicLayer.group,
      weather: new THREE.Group(), // extensible stub — future weather systems fill it
      intelligence: new THREE.Group(), // extensible stub — future intel systems fill it
      labels: this.labelLayer.group
    };
    groups.countryBorders.add(this.borderLayer.coastGroup);
    // Province fills ride on the 'Provinces' layer group (see groups table).
    groups.provinceBorders.add(this.countryLayer.provinceGroup);
    // Sea-class city-network ribbons belong to the Ports layer (its toggle).
    groups.ports.add(this.cityNetworkLayer.seaGroup);

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

    // 2c. City Areas network: lazy + signature-guarded rebuild on show; the
    //     THREE system flags come STRAIGHT from the state's layerVisibility
    //     record — the single visibility source (spec): urban+roads, rail
    //     and sea each follow ONLY their own toggle, never each other.
    this.cityNetworkLayer.sync(
      this.model,
      state.cityAreas.network,
      map.layerVisibility.urbanRoads !== false,
      map.layerVisibility.railways !== false,
      map.layerVisibility.ports !== false
    );

    // 3. Selection (country highlight, city ring, border emphasis, grid-cell
    //    fill/outline, city-connection emphasis) + the persistent player-country
    //    outline — all rebuilt ONLY when the selection key actually changes.
    const selectionKey =
      `${map.selectedCountryId}|${map.selectedProvinceId}|${map.selectedCityId}` +
      `|${map.selectedGridKey}|${map.selectedRiverId}|${map.selectedLakeId}` +
      `|${map.selectedSiteId}|${map.selectedBuildingId}|${map.selectedCityConnectionId}`;
    if (selectionKey !== this.lastSelectionKey) {
      this.lastSelectionKey = selectionKey;
      this.countryLayer.setSelection(map.selectedCountryId, this.theme);
      this.countryLayer.setSelectedProvince(map.selectedProvinceId, this.theme);
      this.cityLayer.setSelectedCity(map.selectedCityId, this.model);
      this.borderLayer.setSelectedCountry(map.selectedCountryId, this.model, this.theme);
      this.cityNetworkLayer.setSelectedConnection(map.selectedCityConnectionId);
      const gridCell =
        map.selectedGridKey !== null ? findGridCell(this.model, map.selectedGridKey) : -1;
      this.gridLayer.setSelectedCell(gridCell >= 0 ? gridCell : null);
    }
    const playerCountryId = state.player.countryConfirmed ? state.player.countryId : null;
    if (playerCountryId !== this.lastPlayerCountryId) {
      this.lastPlayerCountryId = playerCountryId;
      this.borderLayer.setPlayerCountry(playerCountryId, this.model, this.theme);
    }

    // 4. Label LOD — decision pass + sprite sync from the DAMPED camera view.
    //    Grid labels render only while the grid layer is visible.
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
      dtSeconds,
      map.layerVisibility.grid === true
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
