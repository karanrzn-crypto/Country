import * as THREE from 'three';
import type { StrategicMapModel, MapCity } from '../../world/map/MapTypes';
import type { MapTheme } from './MapTheme';

/**
 * CityLayer — city markers (instanced) + capitals (instanced, larger, dark
 * red with ring) + the selection ring.
 *
 * Marker positions come straight from the map data (validated interior
 * points built from the shared lattice edges), so zoom can never displace
 * them. The 'City Areas' LAYER is NOT this class anymore: the real city
 * network (routes, city highlights, capital rings, junction nodes) is
 * CityNetworkLayer — a pure view of the live state.cityAreas slice.
 */
export class CityLayer {
  readonly citiesGroup = new THREE.Group();
  readonly capitalsGroup = new THREE.Group();
  readonly selectionRing: THREE.Mesh;

  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];

  constructor(model: StrategicMapModel, theme: MapTheme) {
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
  }
}
