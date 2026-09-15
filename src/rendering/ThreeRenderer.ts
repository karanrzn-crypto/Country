import * as THREE from 'three';
import type { SystemContext } from '../core/GameContext';
import type { IGameRenderer, RenderFrame, RendererStats } from '../core/RendererAdapter';
import { SceneManager } from './SceneManager';
import { CameraRig } from './CameraRig';
import { LightingRig } from './Lighting';
import { registerThreeLoaders } from './loaders/ThreeLoaders';

/**
 * Three.js renderer — the ONLY module allowed to know Three.js.
 * Implements IGameRenderer so the core stays backend-agnostic. Mirrors
 * chunk events into meshes, follows the player focus and scales pixel ratio
 * with the automatic quality tier.
 */
export class ThreeRenderer implements IGameRenderer {
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private cameraRig: CameraRig | null = null;
  private sceneManager: SceneManager | null = null;
  private context: SystemContext | null = null;
  private readonly resizeHandler = (): void => {
    this.resize(window.innerWidth, window.innerHeight);
  };

  constructor(private readonly mount: HTMLElement) {}

  init(context: SystemContext): void {
    this.context = {
      config: context.config,
      events: context.events,
      state: context.state,
      time: context.time,
      rng: context.rng,
      ids: context.ids,
      logger: context.logger,
      profiler: context.profiler,
      data: context.data,
      world: context.world,
      assets: context.assets,
      perf: context.perf,
      commands: context.commands,
      input: context.input
    };

    // The renderer registers its own Three-backed asset loaders.
    registerThreeLoaders((loader) => context.assets.registerLoader(loader));

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setSize(this.mount.clientWidth || window.innerWidth, this.mount.clientHeight || window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.mount.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b0e14);
    new LightingRig(this.scene).setup();

    this.cameraRig = new CameraRig(
      context.config.world,
      this.mount.clientWidth || window.innerWidth,
      this.mount.clientHeight || window.innerHeight
    );
    this.cameraRig.attach(context.events);

    this.sceneManager = new SceneManager(this.scene, context.state.world, context.config.world.chunkSize);
    this.sceneManager.attach(context.events);

    context.events.on('perf.qualityTierChanged', ({ tier }) => {
      if (this.renderer === null) return;
      this.renderer.setPixelRatio(tier === 'low' ? 0.75 : tier === 'medium' ? 1 : Math.min(window.devicePixelRatio, 1.5));
    });
    context.events.on('player.modeChanged', ({ to }) => {
      const modeDef = to !== null ? this.context?.data.playerModeList.find((mode) => mode.id === to) : undefined;
      if (modeDef !== undefined) this.cameraRig?.applyModeProfile(modeDef.camera);
    });

    window.addEventListener('resize', this.resizeHandler);
  }

  render(frame: RenderFrame): void {
    if (this.renderer === null || this.scene === null || this.cameraRig === null || this.context === null) {
      return;
    }
    this.cameraRig.update(frame.dtSeconds, frame.state);
    this.renderer.render(this.scene, this.cameraRig.camera);
  }

  resize(width: number, height: number): void {
    this.renderer?.setSize(width, height);
    this.cameraRig?.setViewport(width, height);
  }

  getStats(): RendererStats {
    const info = this.renderer?.info;
    return {
      drawCalls: info?.render.calls ?? 0,
      triangles: info?.render.triangles ?? 0,
      meshes: this.sceneManager?.meshCount ?? 0
    };
  }

  dispose(): void {
    window.removeEventListener('resize', this.resizeHandler);
    this.sceneManager?.dispose();
    this.sceneManager = null;
    this.cameraRig?.dispose();
    this.cameraRig = null;
    this.renderer?.dispose();
    if (this.renderer !== null) {
      this.renderer.domElement.remove();
      this.renderer = null;
    }
    this.scene = null;
    this.context = null;
  }
}
