import * as THREE from 'three';

/**
 * Top-down orthographic camera for the strategic political map.
 *
 * The LOGICAL camera (center / view height) lives in the map state slice;
 * this rig is a thin Three.js projection of it. Screen↔world conversion is
 * exact at every zoom level because geometry and camera share world space —
 * markers can never drift when zooming.
 */
export class MapCamera {
  readonly camera: THREE.OrthographicCamera;
  private viewportWidth = 1;
  private viewportHeight = 1;

  constructor(viewportWidth: number, viewportHeight: number) {
    this.viewportWidth = Math.max(1, viewportWidth);
    this.viewportHeight = Math.max(1, viewportHeight);
    // north = -Z (standard map orientation): up vector points towards -Z.
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 1000);
    this.camera.position.set(0, 100, 0);
    this.camera.up.set(0, 0, -1);
    this.camera.lookAt(0, 0, 0);
    this.applyViewport();
  }

  setViewport(width: number, height: number): void {
    this.viewportWidth = Math.max(1, width);
    this.viewportHeight = Math.max(1, height);
    this.applyViewport();
  }

  private applyViewport(): void {
    // Frustum is set per-frame in sync(); viewport only affects aspect.
  }

  /**
   * Syncs the Three.js camera with the logical map camera.
   * `viewHeight` = visible world height (smaller = closer zoom).
   * Screen up = world -Z (north up).
   */
  sync(x: number, z: number, viewHeight: number): void {
    const aspect = this.viewportWidth / this.viewportHeight;
    const halfHeight = viewHeight / 2;
    const halfWidth = halfHeight * aspect;
    this.camera.left = -halfWidth;
    this.camera.right = halfWidth;
    this.camera.top = halfHeight;
    this.camera.bottom = -halfHeight;
    this.camera.position.set(x, 100, z);
    this.camera.lookAt(x, 0, z);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
  }

  get aspect(): number {
    return this.viewportWidth / this.viewportHeight;
  }

  /** Converts viewport pixels (0,0 = top-left) to world ground coordinates. */
  screenToWorld(px: number, py: number): { x: number; z: number } {
    const ndcX = (px / this.viewportWidth) * 2 - 1;
    const ndcY = (py / this.viewportHeight) * 2 - 1;
    const halfHeight = (this.camera.top - this.camera.bottom) / 2;
    const halfWidth = (this.camera.right - this.camera.left) / 2;
    // Screen up = world -Z → negative sign on the Y axis.
    return {
      x: this.camera.position.x + ndcX * halfWidth,
      z: this.camera.position.z - ndcY * halfHeight
    };
  }

  /** Current visible world width/height (for pointer scaling). */
  get visibleSize(): { width: number; height: number } {
    return {
      width: this.camera.right - this.camera.left,
      height: this.camera.top - this.camera.bottom
    };
  }
}
