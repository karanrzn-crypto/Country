import * as THREE from 'three';
import type { StrategicMapModel } from '../../world/map/MapTypes';
import type { MapTheme } from './MapTheme';

/**
 * BorderLayer — ALL border lines of the map, built exclusively from the
 * shared edge registry: every boundary stretch is emitted EXACTLY ONCE
 * (coast + country borders + province borders), which structurally excludes
 * double-drawn or misaligned borders. Coast and country borders are slightly
 * heavier than province borders for the classic political-map look.
 *
 * The selection outline (Part 2) is an INDEPENDENT overlay group built from
 * the selected country's shared ring edges — country geometry itself is never
 * modified by selection.
 */
export class BorderLayer {
  readonly coastGroup = new THREE.Group();
  readonly countryGroup = new THREE.Group();
  readonly provinceGroup = new THREE.Group();
  /** Selection emphasis overlay — always rendered above the border layers. */
  readonly selectionGroup = new THREE.Group();

  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private selectionLines: THREE.LineSegments | null = null;
  private selectionGeometry: THREE.BufferGeometry | null = null;
  private selectionMaterial: THREE.LineBasicMaterial | null = null;

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

  /**
   * Rebuilds the selection outline for a country (call only on selection
   * CHANGE, never per frame). The outline references the same shared edge
   * polylines as the country ring — single geometry source, no drift.
   */
  setSelectedCountry(countryId: string | null, model: StrategicMapModel, theme: MapTheme): void {
    if (this.selectionLines !== null) {
      this.selectionGroup.remove(this.selectionLines);
      this.selectionGeometry?.dispose();
      this.selectionMaterial?.dispose();
      this.selectionLines = null;
      this.selectionGeometry = null;
      this.selectionMaterial = null;
    }
    if (countryId === null) return;
    const country = model.countries[countryId];
    if (country === undefined) return;

    const points: number[] = [];
    for (const segment of country.ring.segments) {
      const edge = model.edges[segment.key];
      if (edge === undefined) continue;
      const polyline = segment.forward ? edge.polyline : [...edge.polyline].reverse();
      for (let i = 1; i < polyline.length; i++) {
        const a = polyline[i - 1];
        const b = polyline[i];
        points.push(a.x, 2.0, a.z, b.x, 2.0, b.z);
      }
    }
    if (points.length === 0) return;

    this.selectionGeometry = new THREE.BufferGeometry();
    this.selectionGeometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    this.selectionGeometry.computeBoundingSphere();
    this.selectionMaterial = new THREE.LineBasicMaterial({
      color: theme.selectionRingColor,
      transparent: true,
      opacity: 0.95
    });
    this.selectionLines = new THREE.LineSegments(this.selectionGeometry, this.selectionMaterial);
    this.selectionLines.renderOrder = 15;
    this.selectionGroup.add(this.selectionLines);
  }

  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.selectionGeometry?.dispose();
    this.selectionMaterial?.dispose();
    this.geometries.length = 0;
    this.materials.length = 0;
    this.coastGroup.clear();
    this.countryGroup.clear();
    this.provinceGroup.clear();
    this.selectionGroup.clear();
  }
}
