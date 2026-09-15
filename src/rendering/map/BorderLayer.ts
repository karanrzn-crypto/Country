import * as THREE from 'three';
import type { StrategicMapModel } from '../../world/map/MapTypes';
import type { MapTheme } from './MapTheme';

/**
 * BorderLayer — ALL border lines of the map, built exclusively from the
 * shared edge registry: every boundary stretch is emitted EXACTLY ONCE
 * (coast + country borders + province borders), which structurally excludes
 * double-drawn or misaligned borders. Coast and country borders are slightly
 * heavier than province borders for the classic political-map look.
 */
export class BorderLayer {
  readonly coastGroup = new THREE.Group();
  readonly countryGroup = new THREE.Group();
  readonly provinceGroup = new THREE.Group();

  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];

  constructor(model: StrategicMapModel, theme: MapTheme) {
    const coastMaterial = new THREE.LineBasicMaterial({ color: theme.coastStroke });
    const countryMaterial = new THREE.LineBasicMaterial({ color: theme.countryBorderStroke });
    const provinceMaterial = new THREE.LineBasicMaterial({
      color: theme.provinceBorderStroke,
      transparent: true,
      opacity: theme.provinceBorderOpacity
    });
    this.materials.push(coastMaterial, countryMaterial, provinceMaterial);

    // Segment buffers per class. Each edge polyline is appended once.
    const coast: number[] = [];
    const country: number[] = [];
    const province: number[] = [];

    for (const edge of Object.values(model.edges)) {
      const target =
        edge.kind === 'coast' ? coast : edge.kind === 'country' ? country : province;
      for (let i = 1; i < edge.polyline.length; i++) {
        const a = edge.polyline[i - 1];
        const b = edge.polyline[i];
        target.push(a.x, 1.0, a.z, b.x, 1.0, b.z);
      }
    }

    const build = (segments: number[], material: THREE.LineBasicMaterial, order: number): void => {
      if (segments.length === 0) return;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(segments, 3));
      geometry.computeBoundingSphere();
      this.geometries.push(geometry);
      const lines = new THREE.LineSegments(geometry, material);
      lines.renderOrder = order;
      (order === 10 ? this.coastGroup : order === 11 ? this.countryGroup : this.provinceGroup).add(lines);
    };
    build(coast, coastMaterial, 10);
    build(country, countryMaterial, 11);
    build(province, provinceMaterial, 12);
  }

  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.geometries.length = 0;
    this.materials.length = 0;
    this.coastGroup.clear();
    this.countryGroup.clear();
    this.provinceGroup.clear();
  }
}
