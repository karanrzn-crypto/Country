import * as THREE from 'three';
import type { SystemContext } from '../core/GameContext';
import type { IGameRenderer, RenderFrame, RendererStats } from '../core/RendererAdapter';
import { SceneManager } from './SceneManager';
import { CameraRig } from './CameraRig';
import { LightingRig } from './Lighting';
import { registerThreeLoaders } from './loaders/ThreeLoaders';
import { StrategicMapRenderer } from './map/StrategicMapRenderer';
import { MapPointerInput } from './map/MapPointerInput';

/**
 * Three.js renderer — the ONLY module allowed to know Three.js.
 * Implements IGameRenderer so the core stays backend-agnostic.
 *
 * Two render paths:
 * - `config.map.enabled` (Part 1 default): the strategic political map —
 *   orthographic top-down layers driven by the map state slice.
 * - legacy chunk-streaming path (Phase 0 2.5D foundation, used when the map
 *   is disabled): mirrors chunk events into meshes.
 */
export class ThreeRenderer implements IGameRenderer {
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;

  // Strategic map path (Part 1)
  private mapRenderer: StrategicMapRenderer | null = null;
  private pointerInput: MapPointerInput | null = null;

  // Legacy chunk path
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
      map: context.map,
      assets: context.assets,
      perf: context.perf,
      commands: context.commands,
      input: context.input
    };

    // The renderer registers its own Three-backed asset loaders.
    registerThreeLoaders((loader) => context.assets.registerLoader(loader));

    const width = this.mount.clientWidth || window.innerWidth;
    const height = this.mount.clientHeight || window.innerHeight;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.mount.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();

    if (context.config.map.enabled) {
      this.mapRenderer = new StrategicMapRenderer(this.scene, context, context.data.mapTheme);
      this.pointerInput = new MapPointerInput(this.renderer.domElement, this.mapRenderer.getCamera(), context.commands);
      // The logical viewport lives in the map slice — keep it in sync.
      context.commands.send({ type: 'map.setViewport', width, height });
    } else {
      this.scene.background = new THREE.Color(0x0b0e14);
      new LightingRig(this.scene).setup();
      this.cameraRig = new CameraRig(context.config.world, width, height);
      this.cameraRig.attach(context.events);
      this.sceneManager = new SceneManager(this.scene, context.state.world, context.config.world.chunkSize);
      this.sceneManager.attach(context.events);
    }

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
    if (this.renderer === null || this.scene === null || this.context === null) {
      return;
    }
    if (this.mapRenderer !== null) {
      this.mapRenderer.update(this.context.state.map, frame.dtSeconds);
      this.renderer.render(this.scene, this.mapRenderer.getCamera().camera);
      return;
    }
    if (this.cameraRig === null) return;
    this.cameraRig.update(frame.dtSeconds, frame.state);
    this.renderer.render(this.scene, this.cameraRig.camera);
  }

  resize(width: number, height: number): void {
    this.renderer?.setSize(width, height);
    this.cameraRig?.setViewport(width, height);
    if (this.mapRenderer !== null && this.context !== null) {
      // Viewport is part of the map state (clamping + picking depend on it).
      this.context.commands.send({ type: 'map.setViewport', width, height });
    }
  }

  getStats(): RendererStats {
    const info = this.renderer?.info;
    return {
      drawCalls: info?.render.calls ?? 0,
      triangles: info?.render.triangles ?? 0,
      meshes: this.mapRenderer !== null ? this.mapRenderer.meshCount : (this.sceneManager?.meshCount ?? 0)
    };
  }

  dispose(): void {
    window.removeEventListener('resize', this.resizeHandler);
    this.pointerInput?.dispose();
    this.pointerInput = null;
    if (this.mapRenderer !== null && this.scene !== null) {
      this.mapRenderer.dispose(this.scene);
    }
    this.mapRenderer = null;
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
