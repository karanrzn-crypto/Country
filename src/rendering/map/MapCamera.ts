import * as THREE from 'three';
import { clampCamera } from '../../world/map/MapQueries';
import type { MapBounds } from '../../world/map/MapTypes';

/**
 * Top-down orthographic camera rig for the strategic political map.
 *
 * The LOGICAL camera in the map state slice is the *target* (set exclusively
 * through map.* commands, clamped by the core). This rig is the *presentation*
 * camera: it eases towards the target with frame-rate-independent exponential
 * damping, so zooming and panning are smooth and predictable — never a jump.
 *
 * Zoom-to-cursor is EXACT for the whole animation: a zoom gesture stores the
 * anchor world point + the cursor pixel; every frame the center is re-solved
 * so the anchor stays under the cursor at the damped view height. Zooming out
 * therefore keeps the map under the pointer and softly stops at the map
 * bounds instead of flinging to a corner.
 *
 * Screen↔world conversion is exact at every zoom level because geometry and
 * this camera share world space — markers can never drift when zooming.
 */

export interface MapCameraView {
  readonly x: number;
  readonly z: number;
  readonly viewHeight: number;
}

/** A cursor-anchored zoom gesture (world point that must stay under a pixel). */
export interface MapZoomGesture {
  readonly anchorX: number;
  readonly anchorZ: number;
  readonly screenX: number;
  readonly screenY: number;
}

export interface MapCameraLimits {
  readonly bounds: MapBounds;
  readonly minViewHeight: number;
  readonly maxViewHeight: number;
}

/** Exponential damping rates (1/s). Higher = snappier. */
const ZOOM_RATE = 9.5;
const PAN_RATE = 26;
/** Zoom gesture releases when the view height is this close to the target. */
const SETTLE_EPSILON = 0.0015;
/** Never integrate more than this per update (tab-switch protection). */
const MAX_DT = 0.1;

export class MapCamera {
  readonly camera: THREE.OrthographicCamera;
  private viewportWidth = 1;
  private viewportHeight = 1;
  private limits: MapCameraLimits | null = null;

  /** Damped presentation state — what is actually on screen. */
  private current: MapCameraView;
  private gesture: MapZoomGesture | null = null;

  constructor(viewportWidth: number, viewportHeight: number, start: MapCameraView) {
    this.viewportWidth = Math.max(1, viewportWidth);
    this.viewportHeight = Math.max(1, viewportHeight);
    this.current = { ...start };
    // north = -Z (standard map orientation): up vector points towards -Z.
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 1000);
    this.camera.position.set(this.current.x, 100, this.current.z);
    this.camera.up.set(0, 0, -1);
    this.camera.lookAt(this.current.x, 0, this.current.z);
    this.syncProjection();
  }

  setViewport(width: number, height: number): void {
    this.viewportWidth = Math.max(1, width);
    this.viewportHeight = Math.max(1, height);
    this.syncProjection();
  }

  setLimits(limits: MapCameraLimits): void {
    this.limits = limits;
  }

  /** Begins (or replaces) the cursor-anchored zoom gesture. */
  beginZoomGesture(gesture: MapZoomGesture): void {
    this.gesture = { ...gesture };
  }

  /** Ends the gesture — the camera eases normally toward the target again. */
  cancelZoomGesture(): void {
    this.gesture = null;
  }

  /** The damped view currently on screen (renderer + labels read this). */
  get view(): MapCameraView {
    return this.current;
  }

  get aspect(): number {
    return this.viewportWidth / this.viewportHeight;
  }

  /**
   * Advances the damped camera toward the logical target. Called once per
   * rendered frame with the real frame delta.
   */
  update(dtSeconds: number, target: MapCameraView): void {
    const dt = Math.min(MAX_DT, Math.max(0, dtSeconds));
    const clampedTarget = this.clampTarget(target);

    // —— view height: exponential damping (frame-rate independent) ——
    const zoomBlend = 1 - Math.exp(-ZOOM_RATE * dt);
    let viewHeight = this.current.viewHeight + (clampedTarget.viewHeight - this.current.viewHeight) * zoomBlend;

    // —— center ——
    let x: number;
    let z: number;
    if (this.gesture !== null) {
      // Exact cursor anchoring: re-solve the center every frame so the anchor
      // world point stays under the cursor pixel at the DAMPED view height.
      const solved = this.solveAnchoredCenter(this.gesture, viewHeight);
      x = solved.x;
      z = solved.z;
      if (Math.abs(viewHeight - clampedTarget.viewHeight) <= SETTLE_EPSILON * clampedTarget.viewHeight) {
        viewHeight = clampedTarget.viewHeight;
        const final = this.solveAnchoredCenter(this.gesture, viewHeight);
        x = final.x;
        z = final.z;
        this.gesture = null;
      }
    } else {
      const panBlend = 1 - Math.exp(-PAN_RATE * dt);
      x = this.current.x + (clampedTarget.x - this.current.x) * panBlend;
      z = this.current.z + (clampedTarget.z - this.current.z) * panBlend;
    }

    const clamped = this.clampView({ x, z, viewHeight });
    this.current = { x: clamped.x, z: clamped.z, viewHeight: clamped.viewHeight };

    this.camera.position.set(this.current.x, 100, this.current.z);
    this.camera.lookAt(this.current.x, 0, this.current.z);
    this.syncProjection();
  }

  /** Converts viewport pixels (0,0 = top-left) to world ground coordinates. */
  screenToWorld(px: number, py: number): { x: number; z: number } {
    const ndcX = (px / this.viewportWidth) * 2 - 1;
    const ndcY = (py / this.viewportHeight) * 2 - 1;
    const halfHeight = (this.camera.top - this.camera.bottom) / 2;
    const halfWidth = (this.camera.right - this.camera.left) / 2;
    // Screen up = world -Z → negative sign on the Z axis.
    return {
      x: this.camera.position.x + ndcX * halfWidth,
      z: this.camera.position.z - ndcY * halfHeight
    };
  }

  /** Current visible world width/height (for pointer scaling + label culling). */
  get visibleSize(): { width: number; height: number } {
    return {
      width: this.camera.right - this.camera.left,
      height: this.camera.top - this.camera.bottom
    };
  }

  /**
   * Center that keeps `gesture.anchor` under the gesture cursor pixel when the
   * visible height is `viewHeight` (inverse of screenToWorld at the center).
   */
  private solveAnchoredCenter(gesture: MapZoomGesture, viewHeight: number): { x: number; z: number } {
    const halfHeight = viewHeight / 2;
    const halfWidth = halfHeight * this.aspect;
    const ndcX = (gesture.screenX / this.viewportWidth) * 2 - 1;
    const ndcY = (gesture.screenY / this.viewportHeight) * 2 - 1;
    return {
      x: gesture.anchorX - ndcX * halfWidth,
      z: gesture.anchorZ + ndcY * halfHeight
    };
  }

  /** Target-side clamp: the logical camera never asks for an invalid view. */
  private clampTarget(target: MapCameraView): MapCameraView {
    const clamped = this.clampView(target);
    return { x: clamped.x, z: clamped.z, viewHeight: clamped.viewHeight };
  }

  private clampView(view: MapCameraView): MapCameraView {
    if (this.limits === null) return { ...view };
    const result = clampCamera(
      { x: view.x, z: view.z, viewHeight: view.viewHeight, aspect: this.aspect },
      this.limits.bounds,
      this.limits.minViewHeight,
      this.limits.maxViewHeight
    );
    return { x: result.x, z: result.z, viewHeight: result.viewHeight };
  }

  private syncProjection(): void {
    const halfHeight = this.current.viewHeight / 2;
    const halfWidth = halfHeight * this.aspect;
    this.camera.left = -halfWidth;
    this.camera.right = halfWidth;
    this.camera.top = halfHeight;
    this.camera.bottom = -halfHeight;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
  }
}
