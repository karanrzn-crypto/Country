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
      const mesh = new THREE.Mesh(geometry, material);
      mesh.renderOrder = 3;
      this.provinceGroup.add(mesh);
    }
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
    // Country highlight and province highlight share the tint pipeline —
    // re-apply the province choice so the newer call never resets it.
    this.applyProvinceHighlight(theme);
  }

  /**
   * Province-layer highlight (§3): brightens the SELECTED province's fill
   * (same selected-tint pipeline as countries). Material recolor only —
   * no geometry is mutated, no GPU object is created (renderer as view).
   */
  setSelectedProvince(provinceId: string | null, theme: MapTheme): void {
    if (provinceId === this.selectedProvinceId) return;
    this.selectedProvinceId = provinceId;
    this.applyProvinceHighlight(theme);
  }

  private applyProvinceHighlight(theme: MapTheme): void {
    const tint = new THREE.Color(theme.selectedTint);
    for (const [provinceId, material] of this.provinceMaterials) {
      const base = this.provinceBaseColors.get(provinceId) as THREE.Color;
      if (provinceId === this.selectedProvinceId) {
        material.color.copy(base).lerp(tint, Math.min(1, theme.selectedOpacity * 1.6));
      } else {
        material.color.copy(base);
      }
    }
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
