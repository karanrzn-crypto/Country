import * as THREE from 'three';
import type { StrategicMapModel, MapProvince } from '../../world/map/MapTypes';
import type { MapTheme } from './MapTheme';

/**
 * CountryLayer — filled polygons for the 'land', 'countries' and 'province'
 * layers, all triangulated ONCE from the shared ring geometry.
 *
 * The country fills reach exactly to the shared border polylines, so
 * neighboring fills always meet perfectly (single geometry source).
 * Toggling 'countries' off reveals the neutral 'land' union (same shapes,
 * land material) — classic political-map layering.
 */
export class CountryLayer {
  readonly landGroup = new THREE.Group();
  readonly countryGroup = new THREE.Group();
  readonly provinceGroup = new THREE.Group();

  private readonly countryMaterials = new Map<string, THREE.MeshBasicMaterial>();
  private readonly baseColors = new Map<string, THREE.Color>();
  /** Per-province materials — ONE selected province is brightened at a time. */
  private readonly provinceMaterials = new Map<string, THREE.MeshBasicMaterial>();
  private readonly provinceBaseColors = new Map<string, THREE.Color>();
  private selectedProvinceId: string | null = null;
  /** Ring polygons by province id — source for the selection overlay. */
  private readonly provinceRings = new Map<string, MapProvince>();
  /**
   * Dedicated SELECTION overlay above every map level (depthTest off) —
   * the per-province fill lives under the opaque biomes/terrain surface,
   * so the highlight would be invisible there. This mesh guarantees the
   * selected province reads clearly in EVERY surface mode (§D).
   */
  private readonly provinceHighlightMesh: THREE.Mesh;
  private readonly provinceHighlightMaterial: THREE.MeshBasicMaterial;
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];

  constructor(model: StrategicMapModel, theme: MapTheme) {
    // Land union: same triangulations, neutral land color, lowest of fills.
    // DoubleSide: ring winding varies with traversal direction — the map is
    // top-down flat, so both faces are valid.
    const landMaterial = new THREE.MeshBasicMaterial({ color: theme.landColor, side: THREE.DoubleSide });
    this.materials.push(landMaterial);

    model.countryOrder.forEach((countryId, index) => {
      const country = model.countries[countryId];
      const geometry = triangulateRing(country.ring.points, 0.5);
      this.geometries.push(geometry);

      const landMesh = new THREE.Mesh(geometry, landMaterial);
      landMesh.renderOrder = 1;
      this.landGroup.add(landMesh);

      const baseColor = new THREE.Color(theme.countryPalette[index % theme.countryPalette.length]);
      const countryMaterial = new THREE.MeshBasicMaterial({ color: baseColor, side: THREE.DoubleSide });
      this.materials.push(countryMaterial);
      this.countryMaterials.set(countryId, countryMaterial);
      this.baseColors.set(countryId, baseColor);

      const countryMesh = new THREE.Mesh(geometry, countryMaterial);
      countryMesh.renderOrder = 2;
      countryMesh.position.y = 0.05;
      this.countryGroup.add(countryMesh);
    });

    for (const province of Object.values(model.provinces) as readonly MapProvince[]) {
      const geometry = triangulateRing(province.ring.points, 0.6);
      this.geometries.push(geometry);
      // Per-province material: the selection highlight recolors ONE province
      // without touching any other (same pattern as the country fills).
      const material = new THREE.MeshBasicMaterial({
        color: theme.provinceFill,
        transparent: true,
        opacity: theme.provinceFillOpacity,
        depthWrite: false,
        side: THREE.DoubleSide
      });
      this.materials.push(material);
      this.provinceMaterials.set(province.id, material);
      this.provinceBaseColors.set(province.id, new THREE.Color(theme.provinceFill));
      this.provinceRings.set(province.id, province);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.renderOrder = 3;
      this.provinceGroup.add(mesh);
    }

    // Selection overlay: one reusable mesh ABOVE the surface (depthTest
    // off, high render order); geometry swapped only on selection change.
    this.provinceHighlightMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(theme.provinceSelectColor),
      transparent: true,
      opacity: theme.provinceSelectOpacity,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide
    });
    this.materials.push(this.provinceHighlightMaterial);
    this.provinceHighlightMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.provinceHighlightMaterial);
    this.provinceHighlightMesh.renderOrder = 13;
    this.provinceHighlightMesh.visible = false;
    this.provinceHighlightMesh.frustumCulled = false;
    this.provinceGroup.add(this.provinceHighlightMesh);
  }

  /**
   * Applies the selection highlight: the selected country is brightened
   * towards the theme's selected tint; all others keep their base color.
   */
  setSelection(selectedCountryId: string | null, theme: MapTheme): void {
    const tint = new THREE.Color(theme.selectedTint);
    for (const [countryId, material] of this.countryMaterials) {
      const base = this.baseColors.get(countryId) as THREE.Color;
      if (countryId === selectedCountryId) {
        material.color.copy(base).lerp(tint, theme.selectedOpacity);
      } else {
        material.color.copy(base);
      }
    }
  }

  /**
   * Province-layer highlight (§D): the dedicated overlay mesh shows the
   * selected province's EXACT ring polygon above every map level; the faint
   * per-province fill keeps its base color (the overlay carries the accent).
   * Material/geometry swap only — no per-frame work.
   */
  setSelectedProvince(provinceId: string | null, theme: MapTheme): void {
    if (provinceId === this.selectedProvinceId) return;
    this.selectedProvinceId = provinceId;
    const mesh = this.provinceHighlightMesh;
    const previous = mesh.geometry;
    if (provinceId === null) {
      mesh.visible = false;
      mesh.geometry = new THREE.BufferGeometry();
      previous.dispose();
      return;
    }
    const province = this.provinceRings.get(provinceId);
    if (province === undefined) {
      mesh.visible = false;
      mesh.geometry = new THREE.BufferGeometry();
      previous.dispose();
      return;
    }
    this.provinceHighlightMaterial.color.set(theme.provinceSelectColor);
    this.provinceHighlightMaterial.opacity = theme.provinceSelectOpacity;
    mesh.geometry = triangulateRing(province.ring.points, 1.2);
    previous.dispose();
    mesh.visible = true;
  }

  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.geometries.length = 0;
    this.materials.length = 0;
    this.countryMaterials.clear();
    this.baseColors.clear();
    this.provinceMaterials.clear();
    this.provinceBaseColors.clear();
    this.landGroup.clear();
    this.countryGroup.clear();
    this.provinceGroup.clear();
  }
}

/**
 * Triangulates a ring (implicit closure) into a flat BufferGeometry.
 * Vertices are laid flat in the XZ plane at the given height.
 */
export function triangulateRing(points: readonly { x: number; z: number }[], y: number): THREE.BufferGeometry {
  const contour = points.map((point) => new THREE.Vector2(point.x, point.z));
  const triangles = THREE.ShapeUtils.triangulateShape(contour, []);
  const positionArray = new Float32Array(triangles.length * 9);
  let offset = 0;
  for (const [a, b, c] of triangles) {
    const pa = points[a];
    const pb = points[b];
    const pc = points[c];
    positionArray[offset++] = pa.x;
    positionArray[offset++] = y;
    positionArray[offset++] = pa.z;
    positionArray[offset++] = pb.x;
    positionArray[offset++] = y;
    positionArray[offset++] = pb.z;
    positionArray[offset++] = pc.x;
    positionArray[offset++] = y;
    positionArray[offset++] = pc.z;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positionArray, 3));
  geometry.computeBoundingSphere();
  return geometry;
}
