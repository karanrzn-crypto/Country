import * as THREE from 'three';
import type { EventBus } from '../events/EventBus';
import type { WorldConfig } from '../config/configTypes';
import type { GameState } from '../state/GameState';
import type { CameraProfile } from '../player/types';
import { lerp } from '../utils/math';

const PROFILE_ZOOM_BOUNDS: Readonly<Record<CameraProfile, readonly [number, number]>> = {
  strategic: [0.6, 4],
  tactical: [0.25, 2],
  ground: [0.08, 0.6],
  aircraft: [0.1, 1]
};

/**
 * Orthographic 2.5D strategic camera: smoothly follows the player focus
 * chunk, zooms via bound actions and clamps zoom by the active player mode.
 */
export class CameraRig {
  readonly camera: THREE.OrthographicCamera;
  private zoom = 1.4;
  private readonly target = new THREE.Vector3();
  private initialized = false;
  private currentProfile: CameraProfile = 'strategic';
  private viewportWidth = 1;
  private viewportHeight = 1;
  private readonly unsubscribes: (() => void)[] = [];

  constructor(
    private readonly config: WorldConfig,
    viewportWidth: number,
    viewportHeight: number
  ) {
    this.viewportWidth = Math.max(1, viewportWidth);
    this.viewportHeight = Math.max(1, viewportHeight);
    const aspect = this.viewportWidth / this.viewportHeight;
    this.camera = new THREE.OrthographicCamera(
      -10 * aspect, 10 * aspect, 10, -10, 1, 1000
    );
    this.applyViewport();
  }

  attach(events: EventBus): void {
    this.unsubscribes.push(
      events.on('input.actionPressed', ({ action }) => {
        if (action === 'zoomIn') this.zoomBy(0.85);
        else if (action === 'zoomOut') this.zoomBy(1.18);
      }),
      events.on('player.modeChanged', ({ to }) => {
        void to;
      })
    );
  }

  /** Applies the camera profile of a player mode (zoom bounds clamp). */
  applyModeProfile(profile: CameraProfile): void {
    this.currentProfile = profile;
    const [min, max] = PROFILE_ZOOM_BOUNDS[profile];
    this.zoom = Math.min(max, Math.max(min, this.zoom));
    this.applyViewport();
  }

  private zoomBy(factor: number): void {
    const [min, max] = PROFILE_ZOOM_BOUNDS[this.currentProfile];
    this.zoom = Math.min(max, Math.max(min, this.zoom * factor));
    this.applyViewport();
  }

  setViewport(width: number, height: number): void {
    this.viewportWidth = Math.max(1, width);
    this.viewportHeight = Math.max(1, height);
    this.applyViewport();
  }

  private applyViewport(): void {
    const aspect = this.viewportWidth / this.viewportHeight;
    const halfHeight = 22 * this.zoom;
    const halfWidth = halfHeight * aspect;
    this.camera.left = -halfWidth;
    this.camera.right = halfWidth;
    this.camera.top = halfHeight;
    this.camera.bottom = -halfHeight;
    this.camera.updateProjectionMatrix();
  }

  update(dtSeconds: number, state: GameState): void {
    const focusId = state.player.focusChunkId;
    const focus = focusId !== null ? state.world.chunks[focusId] : undefined;
    const desiredX =
      focus !== undefined ? (focus.gx + 0.5) * this.config.chunkSize : this.target.x;
    const desiredZ =
      focus !== undefined ? (focus.gz + 0.5) * this.config.chunkSize : this.target.z;

    if (!this.initialized) {
      this.target.set(desiredX, 0, desiredZ);
      this.initialized = true;
    } else {
      const t = Math.min(1, dtSeconds * 5);
      this.target.set(lerp(this.target.x, desiredX, t), 0, lerp(this.target.z, desiredZ, t));
    }

    this.camera.position.set(this.target.x, 100, this.target.z + 60);
    this.camera.lookAt(this.target);
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes.length = 0;
  }
}
