import * as THREE from 'three';
import type { StrategicMapModel, MapPoint } from '../../world/map/MapTypes';
import type { MapTheme } from './MapTheme';
import { themeColor } from './MapTheme';
import type { CityAreaNetwork } from '../../world/cityareas/CityAreaTypes';
import { cityConnectionsOf, type CityConnection } from '../../world/cityareas/CityConnections';
import { cellIndexAtPoint } from '../../world/map/MapQueries';
import { buildVertexElevationGrid, SURFACE_FILL_Y, SURFACE_RELIEF_AMPLITUDE } from './MapSurface';

/**
 * CityNetworkLayer — the REAL City Areas view: the country's city-to-city
 * transport network rendered from the live `state.cityAreas` slice.
 *
 * NOT decorative lines: every ribbon IS a network connection (derived by
 * CityConnections from the area graph), starting exactly at the source city
 * marker and ending exactly at the destination city marker, following the
 * shared map road/railway polylines. Visual grammar (per spec):
 *  - main (intra-province) road routes: medium gold ribbons;
 *  - inter-province routes: wider teal ribbons (a different visual class);
 *  - railways: thin violet ribbons;
 *  - cities highlighted with translucent discs, capitals with bright rings;
 *  - junction nodes marked with small diamonds.
 *
 * VISIBILITY (spec — SEPARATE systems, ONE state source per system): the
 * layer exposes THREE groups the renderer mounts under the layer registry's
 * toggles —
 *  - `urbanGroup`: city discs, capital rings, junction markers AND the
 *    ROAD-class ribbons → the merged 'Urban Areas + Roads' toggle;
 *  - `railGroup`: railway-class ribbons (the capital-to-capital spine) →
 *    the independent 'Railways' toggle;
 *  - `seaGroup`: sea-class ribbons → the 'Ports' toggle (their layer).
 * Toggling ONE system never flips another; OFF hides the same meshes back
 * ON (visibility only — never a rebuild, never a data change). The state's
 * layerVisibility record is the single visibility source for every group.
 *
 * Performance contract (same as every map layer):
 *  - ONE merged vertex-colored ribbon mesh per class + 3 InstancedMeshes —
 *    a handful of draw calls regardless of network size — no per-link meshes;
 *  - LAZY + signature-guarded: rebuilt only when the network SHAPE changes
 *    (area/link count) or the model changes; visibility flips are free;
 *  - ribbon heights follow the terrain surface (never buried, never
 *    floating) via the shared vertex-elevation grid.
 *
 * This class is a pure view: all data comes from the state slice + static
 * model; it owns no simulation state and never mutates it.
 */

/** Lifts above the local surface top (max corner of the cell) — keeps the
 * ribbons ON the ground in every surface mode and ABOVE the flat road lines
 * (y=0.85) they share geometry with. */
const LINK_LIFT = 0.18;
const DISC_LIFT = 0.08;
const RING_LIFT = 0.09;
const JUNCTION_LIFT = 0.12;

export class CityNetworkLayer {
  /** The merged 'Urban Areas + Roads' surface: road ribbons + city discs,
   *  capital rings and junction markers (the urban view itself). */
  readonly urbanGroup = new THREE.Group();
  /** Railway-class ribbons (the capital-to-capital spine) — the INDEPENDENT
   *  Railways toggle governs exactly this group and nothing else. */
  readonly railGroup = new THREE.Group();
  /** Sea-class ribbons — governed by the Ports toggle (their own layer). */
  readonly seaGroup = new THREE.Group();
  private readonly columns: number;
  private readonly rows: number;
  private readonly cellSize: number;
  private readonly theme: MapTheme;
  private built = false;
  private signature = '';
  private builtModel: StrategicMapModel | null = null;
  private selectedConnectionId: string | null = null;
  /** The ROAD-class ribbon mesh — visibility follows the merged toggle. */
  private roadRibbonMesh: THREE.Mesh | null = null;
  /** The RAILWAY-class ribbon mesh — visibility follows Railways alone. */
  private railRibbonMesh: THREE.Mesh | null = null;
  /** The SEA-class ribbon mesh — visibility follows Ports. */
  private seaRibbonMesh: THREE.Mesh | null = null;
  /** Last applied visibilities (selection emphasis re-evaluates on flips). */
  private urbanVisible = true;
  private railVisible = true;
  private seaVisible = true;
  /** Connections of the last rebuild (selection overlay source). */
  private connections: readonly CityConnection[] = [];
  private lastModel: StrategicMapModel | null = null;
  private lastHeights: Float64Array | null = null;
  private selectionMesh: THREE.Mesh | null = null;
  private selectionGeometry: THREE.BufferGeometry | null = null;
  private selectionMaterial: THREE.MeshBasicMaterial | null = null;
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];

  constructor(columns: number, rows: number, cellSize: number, theme: MapTheme) {
    this.columns = columns;
    this.rows = rows;
    this.cellSize = cellSize;
    this.theme = theme;
    this.urbanGroup.visible = false;
    this.railGroup.visible = false;
    this.seaGroup.visible = false;
  }

  /**
   * Per-frame sync: flips group visibilities and rebuilds ONLY when the
   * network shape changed (area/link counts — the topology is regenerated
   * as a whole, never mutated piecemeal). Cheap even when called every
   * frame. The three flags come straight from the state's layerVisibility
   * record (single visibility source): urban = 'urbanRoads', rail =
   * 'railways', sea = 'ports'. OFF hides, ON restores the SAME meshes —
   * data never rebuilt or dropped by a visibility flip.
   */
  sync(
    model: StrategicMapModel,
    network: CityAreaNetwork,
    urbanVisible: boolean,
    railVisible: boolean,
    seaVisible: boolean
  ): void {
    const signature = `${Object.keys(network.areas).length}|${Object.keys(network.links).length}`;
    const wanted = urbanVisible || railVisible || seaVisible;
    if (wanted && (!this.built || signature !== this.signature || this.builtModel !== model)) {
      this.rebuild(model, network, signature);
    }
    this.urbanGroup.visible = urbanVisible;
    this.railGroup.visible = railVisible;
    this.seaGroup.visible = seaVisible;
    // The meshes track their system flag too (coherent at both levels —
    // reading either the group or the mesh gives the same answer).
    if (this.roadRibbonMesh !== null) this.roadRibbonMesh.visible = urbanVisible;
    if (this.railRibbonMesh !== null) this.railRibbonMesh.visible = railVisible;
    if (this.seaRibbonMesh !== null) this.seaRibbonMesh.visible = seaVisible;
    if (
      urbanVisible !== this.urbanVisible ||
      railVisible !== this.railVisible ||
      seaVisible !== this.seaVisible
    ) {
      this.urbanVisible = urbanVisible;
      this.railVisible = railVisible;
      this.seaVisible = seaVisible;
      // The selection emphasis rides ABOVE the route — re-evaluate it so a
      // selected connection never stays bright while its system is hidden.
      this.redrawSelection();
    }
  }

  /** Forces the next visible sync to rebuild (e.g. runtime link conditions). */
  invalidate(): void {
    this.built = false;
  }

  /** The ROAD-class ribbon mesh (visibility governed by the merged toggle). */
  get roadRibbon(): THREE.Mesh | null {
    return this.roadRibbonMesh;
  }

  /** The RAILWAY-class ribbon mesh — governed by Railways alone. */
  get railRibbon(): THREE.Mesh | null {
    return this.railRibbonMesh;
  }

  /** The SEA-class ribbon mesh — governed by Ports. */
  get seaRibbon(): THREE.Mesh | null {
    return this.seaRibbonMesh;
  }

  /**
   * Highlights the SELECTED city connection (bright emphasis ribbon above
   * the route) — rebuilt only when the selection changes, never per frame.
   * Pass null to clear. Safe before the lazy build (applied on it).
   */
  setSelectedConnection(connectionId: string | null): void {
    if (connectionId === this.selectedConnectionId) return;
    this.selectedConnectionId = connectionId;
    if (this.built) this.redrawSelection();
  }

  // —————————————————————————————————————————————————————————————— build ——

  private surfaceTopAt(heights: Float64Array, point: MapPoint, model: StrategicMapModel): number {
    const cellIndex = cellIndexAtPoint(model, point, this.columns, this.rows, this.cellSize);
    if (cellIndex < 0) return SURFACE_FILL_Y;
    const cz = Math.floor(cellIndex / this.columns);
    const cx = cellIndex - cz * this.columns;
    const stride = this.columns + 1;
    const maxCorner = Math.max(
      heights[cz * stride + cx],
      heights[cz * stride + cx + 1],
      heights[(cz + 1) * stride + cx + 1],
      heights[(cz + 1) * stride + cx]
    );
    return SURFACE_FILL_Y + maxCorner * SURFACE_RELIEF_AMPLITUDE;
  }

  private rebuild(model: StrategicMapModel, network: CityAreaNetwork, signature: string): void {
    this.clearObjects();
    const heights = buildVertexElevationGrid(model, this.columns);
    this.lastModel = model;
    this.lastHeights = heights;

    // —— 1. connection ribbons, ONE mesh per class in its OWN system group:
    // road → urbanGroup (merged toggle), railway → railGroup (Railways
    // toggle), sea → seaGroup (Ports toggle). No shared gating anywhere. ——
    const connections = cityConnectionsOf(network);
    this.connections = connections;
    const ribbonMaterial = (): THREE.MeshBasicMaterial =>
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: this.theme.cityLinkOpacity,
        depthWrite: false,
        side: THREE.DoubleSide
      });
    const addRibbon = (
      group: THREE.Group,
      meshSlot: 'road' | 'rail' | 'sea',
      classConnections: readonly CityConnection[],
      visible: boolean
    ): void => {
      const geometry = this.buildRibbonGeometry(model, heights, classConnections);
      if (geometry === null) return;
      const material = ribbonMaterial();
      this.materials.push(material);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.renderOrder = 10;
      mesh.visible = visible;
      group.add(mesh);
      if (meshSlot === 'road') this.roadRibbonMesh = mesh;
      else if (meshSlot === 'rail') this.railRibbonMesh = mesh;
      else this.seaRibbonMesh = mesh;
    };
    addRibbon(
      this.urbanGroup,
      'road',
      connections.filter((connection) => connection.kind === 'road'),
      this.urbanVisible
    );
    addRibbon(
      this.railGroup,
      'rail',
      connections.filter((connection) => connection.kind === 'railway'),
      this.railVisible
    );
    addRibbon(
      this.seaGroup,
      'sea',
      connections.filter((connection) => connection.kind === 'sea'),
      this.seaVisible
    );

    // —— 2. city highlight discs (all cities, one instanced mesh) ——
    const cities = Object.values(model.cities);
    if (cities.length > 0) {
      const discGeometry = new THREE.CircleGeometry(this.theme.cityRadius * 1.9, 16);
      discGeometry.rotateX(-Math.PI / 2);
      const highlightColor = themeColor(this.theme.cityHighlightColor);
      const discMaterial = new THREE.MeshBasicMaterial({
        color: new THREE.Color(highlightColor.r, highlightColor.g, highlightColor.b),
        transparent: true,
        opacity: this.theme.cityHighlightOpacity,
        depthWrite: false,
        side: THREE.DoubleSide
      });
      this.geometries.push(discGeometry);
      this.materials.push(discMaterial);
      const discs = new THREE.InstancedMesh(discGeometry, discMaterial, cities.length);
      const matrix = new THREE.Matrix4();
      cities.forEach((city, index) => {
        const y = this.surfaceTopAt(heights, city.position, model) + DISC_LIFT;
        matrix.makeTranslation(city.position.x, y, city.position.z);
        discs.setMatrixAt(index, matrix);
      });
      discs.renderOrder = 10.4;
      this.urbanGroup.add(discs);
    }

    // —— 3. capital rings (one instanced mesh — capitals stand out) ——
    const capitals = cities.filter((city) => city.isCapital);
    if (capitals.length > 0) {
      const ringGeometry = new THREE.RingGeometry(
        this.theme.capitalRadius * 1.35,
        this.theme.capitalRadius * 1.8,
        24
      );
      ringGeometry.rotateX(-Math.PI / 2);
      const capitalColor = themeColor(this.theme.capitalHighlightColor);
      const ringMaterial = new THREE.MeshBasicMaterial({
        color: new THREE.Color(capitalColor.r, capitalColor.g, capitalColor.b),
        transparent: true,
        opacity: this.theme.capitalHighlightOpacity,
        depthWrite: false,
        side: THREE.DoubleSide
      });
      this.geometries.push(ringGeometry);
      this.materials.push(ringMaterial);
      const rings = new THREE.InstancedMesh(ringGeometry, ringMaterial, capitals.length);
      const matrix = new THREE.Matrix4();
      capitals.forEach((city, index) => {
        const y = this.surfaceTopAt(heights, city.position, model) + RING_LIFT;
        matrix.makeTranslation(city.position.x, y, city.position.z);
        rings.setMatrixAt(index, matrix);
      });
      rings.renderOrder = 10.6;
      this.urbanGroup.add(rings);
    }

    // —— 4. junction nodes (transport hubs — the graph's interchange points) ——
    const junctions = Object.values(network.areas).filter((area) => area.transportHub);
    if (junctions.length > 0) {
      const junctionGeometry = new THREE.PlaneGeometry(1.05, 1.05);
      junctionGeometry.rotateZ(Math.PI / 4);
      junctionGeometry.rotateX(-Math.PI / 2);
      const junctionColor = themeColor(this.theme.cityAreaStroke);
      const junctionMaterial = new THREE.MeshBasicMaterial({
        color: new THREE.Color(junctionColor.r, junctionColor.g, junctionColor.b),
        transparent: true,
        opacity: 0.8,
        depthWrite: false,
        side: THREE.DoubleSide
      });
      this.geometries.push(junctionGeometry);
      this.materials.push(junctionMaterial);
      const markers = new THREE.InstancedMesh(junctionGeometry, junctionMaterial, junctions.length);
      const matrix = new THREE.Matrix4();
      junctions.forEach((area, index) => {
        const y = this.surfaceTopAt(heights, area.position, model) + JUNCTION_LIFT;
        matrix.makeTranslation(area.position.x, y, area.position.z);
        markers.setMatrixAt(index, matrix);
      });
      markers.renderOrder = 10.5;
      this.urbanGroup.add(markers);
    }

    this.built = true;
    this.signature = signature;
    this.builtModel = model;
    // Re-apply any selection that arrived before the lazy build.
    this.redrawSelection();
  }

  /** Rebuilds the bright emphasis ribbon over the selected route. */
  private redrawSelection(): void {
    if (this.selectionMesh !== null) {
      this.selectionMesh.parent?.remove(this.selectionMesh);
      this.selectionGeometry?.dispose();
      this.selectionMaterial?.dispose();
      this.selectionMesh = null;
      this.selectionGeometry = null;
      this.selectionMaterial = null;
    }
    if (
      this.selectedConnectionId === null ||
      this.lastModel === null ||
      this.lastHeights === null
    ) {
      return;
    }
    const selected = this.connections.find((entry) => entry.id === this.selectedConnectionId);
    if (selected === undefined) return;
    // The emphasis rides above the route — a route display. It follows the
    // selected connection's OWN system flag: a road route shows only while
    // the merged Urban+Roads toggle is on, a railway only while Railways is
    // on, a sea link only while Ports is on.
    const emphasisVisible =
      selected.kind === 'railway'
        ? this.railVisible
        : selected.kind === 'sea'
          ? this.seaVisible
          : this.urbanVisible;
    if (!emphasisVisible) return;
    const geometry = this.buildRibbonGeometry(this.lastModel, this.lastHeights, [selected], 0.5);
    if (geometry === null) return;
    this.selectionGeometry = geometry;
    const selectionColor = themeColor(this.theme.selectionRingColor);
    this.selectionMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(selectionColor.r, selectionColor.g, selectionColor.b),
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    this.selectionMesh = new THREE.Mesh(geometry, this.selectionMaterial);
    this.selectionMesh.renderOrder = 11;
    (selected.kind === 'railway'
      ? this.railGroup
      : selected.kind === 'sea'
        ? this.seaGroup
        : this.urbanGroup
    ).add(this.selectionMesh);
  }

  /** ONE merged ribbon geometry for every connection (2 triangles/segment).
   *  `widthBoost` grows a ribbon (selection emphasis rides ABOVE the route). */
  private buildRibbonGeometry(
    model: StrategicMapModel,
    heights: Float64Array,
    connections: readonly CityConnection[],
    widthBoost = 0
  ): THREE.BufferGeometry | null {
    const roadColor = themeColor(this.theme.cityLinkRoad);
    const crossColor = themeColor(this.theme.cityLinkCrossProvince);
    const railColor = themeColor(this.theme.cityLinkRailway);
    const positions: number[] = [];
    const colors: number[] = [];

    for (const connection of connections) {
      const path = connection.path;
      if (path.length < 2) continue;
      const color =
        connection.kind === 'railway'
          ? railColor
          : connection.crossProvince
            ? crossColor
            : roadColor;
      const width =
        connection.kind === 'railway'
          ? this.theme.cityLinkRailwayWidth
          : connection.crossProvince
            ? this.theme.cityLinkCrossProvinceWidth
            : this.theme.cityLinkRoadWidth;
      const halfWidth = width / 2 + widthBoost;

      const left: { x: number; y: number; z: number }[] = [];
      const right: { x: number; y: number; z: number }[] = [];
      for (let i = 0; i < path.length; i++) {
        const previous = path[Math.max(0, i - 1)];
        const next = path[Math.min(path.length - 1, i + 1)];
        const tx = next.x - previous.x;
        const tz = next.z - previous.z;
        const length = Math.hypot(tx, tz) || 1;
        const nx = -tz / length;
        const nz = tx / length;
        const point = path[i];
        const y = this.surfaceTopAt(heights, point, model) + LINK_LIFT;
        left.push({ x: point.x + nx * halfWidth, y, z: point.z + nz * halfWidth });
        right.push({ x: point.x - nx * halfWidth, y, z: point.z - nz * halfWidth });
      }
      for (let i = 1; i < left.length; i++) {
        for (const vertex of [left[i - 1], right[i - 1], right[i], left[i - 1], right[i], left[i]]) {
          positions.push(vertex.x, vertex.y, vertex.z);
          colors.push(color.r, color.g, color.b);
        }
      }
    }

    if (positions.length === 0) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.computeBoundingSphere();
    if (widthBoost === 0) this.geometries.push(geometry);
    return geometry;
  }

  private clearObjects(): void {
    this.urbanGroup.clear();
    this.railGroup.clear();
    this.seaGroup.clear();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.geometries.length = 0;
    this.materials.length = 0;
    this.roadRibbonMesh = null;
    this.railRibbonMesh = null;
    this.seaRibbonMesh = null;
    this.selectionGeometry?.dispose();
    this.selectionMaterial?.dispose();
    this.selectionMesh = null;
    this.selectionGeometry = null;
    this.selectionMaterial = null;
    this.connections = [];
    this.lastModel = null;
    this.lastHeights = null;
    this.built = false;
    this.signature = '';
    this.builtModel = null;
  }

  dispose(): void {
    this.clearObjects();
  }
}
