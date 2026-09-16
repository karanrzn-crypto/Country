import * as THREE from 'three';
import type { StrategicMapModel, MapCity } from '../../world/map/MapTypes';
import type { MapTheme } from './MapTheme';

/**
 * CityLayer — city markers (instanced) + capitals (instanced, larger, dark
 * red with ring) + the selection ring + city-district boundaries.
 *
 * Marker positions and district boundaries come straight from the map data
 * (validated interior points + area rings built from the shared lattice
 * edges), so zoom can never displace them. District boundaries are ONE
 * merged LineSegments (single geometry, single draw call) where every shared
 * edge stretch is emitted EXACTLY ONCE (deduped by edge key across all
 * districts) — same guarantee as the border layers. Only 'interior' edges
 * are drawn: district stretches that coincide with province/coast/country
 * borders are already rendered by those layers, so nothing is double-drawn.
 */
export class CityLayer {
  readonly citiesGroup = new THREE.Group();
  readonly capitalsGroup = new THREE.Group();
  /** Subtle district-boundary lines ('cityAreas' layer). */
  readonly cityAreasGroup = new THREE.Group();
  readonly selectionRing: THREE.Mesh;

  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];

  constructor(model: StrategicMapModel, theme: MapTheme) {
    // —— city-district boundaries (ONE LineSegments, built once) ——
    const areaMaterial = new THREE.LineBasicMaterial({
      color: theme.cityAreaStroke,
      transparent: true,
      opacity: theme.cityAreaOpacity,
      depthWrite: false
    });
    this.materials.push(areaMaterial);
    const emittedKeys = new Set<string>();
    const areaSegments: number[] = [];
    for (const city of Object.values(model.cities) as readonly MapCity[]) {
      for (const segment of city.areaRing.segments) {
        if (emittedKeys.has(segment.key)) continue;
        emittedKeys.add(segment.key);
        const edge = model.edges[segment.key];
        if (edge === undefined || edge.kind !== 'interior') continue;
        for (let i = 1; i < edge.polyline.length; i++) {
          const a = edge.polyline[i - 1];
          const b = edge.polyline[i];
          areaSegments.push(a.x, 0.9, a.z, b.x, 0.9, b.z);
        }
      }
    }
    if (areaSegments.length > 0) {
      const areaGeometry = new THREE.BufferGeometry();
      areaGeometry.setAttribute('position', new THREE.Float32BufferAttribute(areaSegments, 3));
      areaGeometry.computeBoundingSphere();
      this.geometries.push(areaGeometry);
      const areaLines = new THREE.LineSegments(areaGeometry, areaMaterial);
      areaLines.renderOrder = 13;
      this.cityAreasGroup.add(areaLines);
    }

    const cityGeometry = new THREE.CircleGeometry(theme.cityRadius, 12);
    cityGeometry.rotateX(-Math.PI / 2);
    const capitalGeometry = new THREE.CircleGeometry(theme.capitalRadius, 20);
    capitalGeometry.rotateX(-Math.PI / 2);
    this.geometries.push(cityGeometry, capitalGeometry);

    const cityMaterial = new THREE.MeshBasicMaterial({ color: theme.cityFill });
    const capitalMaterial = new THREE.MeshBasicMaterial({ color: theme.capitalFill });
    this.materials.push(cityMaterial, capitalMaterial);

    const cities = Object.values(model.cities) as readonly MapCity[];
    const normalCities = cities.filter((city) => !city.isCapital);
    const capitals = cities.filter((city) => city.isCapital);

    const cityMesh = new THREE.InstancedMesh(cityGeometry, cityMaterial, Math.max(1, normalCities.length));
    cityMesh.count = normalCities.length;
    const matrix = new THREE.Matrix4();
    normalCities.forEach((city, index) => {
      matrix.makeTranslation(city.position.x, 1.4, city.position.z);
      cityMesh.setMatrixAt(index, matrix);
    });
    cityMesh.renderOrder = 20;
    this.citiesGroup.add(cityMesh);

    const capitalMesh = new THREE.InstancedMesh(capitalGeometry, capitalMaterial, Math.max(1, capitals.length));
    capitalMesh.count = capitals.length;
    capitals.forEach((city, index) => {
      matrix.makeTranslation(city.position.x, 1.5, city.position.z);
      capitalMesh.setMatrixAt(index, matrix);
    });
    capitalMesh.renderOrder = 21;
    this.capitalsGroup.add(capitalMesh);

    const ringGeometry = new THREE.RingGeometry(theme.capitalRadius * 1.4, theme.capitalRadius * 1.9, 24);
    ringGeometry.rotateX(-Math.PI / 2);
    this.geometries.push(ringGeometry);
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: theme.selectionRingColor,
      transparent: true,
      opacity: 0.9,
      depthWrite: false
    });
    this.materials.push(ringMaterial);
    this.selectionRing = new THREE.Mesh(ringGeometry, ringMaterial);
    this.selectionRing.renderOrder = 22;
    this.selectionRing.visible = false;
    this.capitalsGroup.add(this.selectionRing);
  }

  /** Shows the ring on a city position, or hides it when nothing is selected. */
  setSelectedCity(cityId: string | null, model: StrategicMapModel): void {
    if (cityId === null || model.cities[cityId] === undefined) {
      this.selectionRing.visible = false;
      return;
    }
    const city = model.cities[cityId];
    this.selectionRing.position.set(city.position.x, 1.6, city.position.z);
    this.selectionRing.visible = true;
  }

  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.geometries.length = 0;
    this.materials.length = 0;
    this.citiesGroup.clear();
    this.capitalsGroup.clear();
    this.cityAreasGroup.clear();
  }
}
