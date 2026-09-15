import * as THREE from 'three';

/**
 * Lighting rig: cheap ambient + directional setup tuned for the strategic
 * view. Shadows intentionally off (performance-first foundation); per-mode
 * lighting profiles come with the tactical view later.
 */
export class LightingRig {
  constructor(private readonly scene: THREE.Scene) {}

  setup(): void {
    const ambient = new THREE.AmbientLight(0x8fa3bf, 0.7);
    const directional = new THREE.DirectionalLight(0xffffff, 1.1);
    directional.position.set(60, 100, 40);
    this.scene.add(ambient);
    this.scene.add(directional);
  }
}
