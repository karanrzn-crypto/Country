import type { CommandBus } from '../../core/CommandBus';
import type { MapCamera } from './MapCamera';

/**
 * MapPointerInput — presentation-side pointer handling for the strategic map
 * (browser only, like the keyboard source). Converts raw pointer events into
 * COMMANDS — it never mutates state:
 *
 * - click (with drag threshold) → map.pick at the world position
 * - left-drag → map.setCamera pan (clamped by the core)
 * - wheel → map.setCamera zoom-to-cursor (anchor stays under the pointer)
 */
export class MapPointerInput {
  private readonly canvas: HTMLCanvasElement;
  private readonly camera: MapCamera;
  private readonly commands: CommandBus;
  private readonly unsubscribeHandlers: (() => void)[] = [];

  private dragging = false;
  private pointerId: number | null = null;
  private lastX = 0;
  private lastY = 0;
  private downX = 0;
  private downY = 0;
  private moved = false;

  private static readonly DRAG_THRESHOLD_PX = 5;

  constructor(canvas: HTMLCanvasElement, camera: MapCamera, commands: CommandBus) {
    this.canvas = canvas;
    this.camera = camera;
    this.commands = commands;

    const options: AddEventListenerOptions = { passive: false };
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove, options);
    window.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('wheel', this.onWheel, options);
    this.canvas.addEventListener('contextmenu', this.onContextMenu);
    this.unsubscribeHandlers.push(() => {
      this.canvas.removeEventListener('pointerdown', this.onPointerDown);
      window.removeEventListener('pointermove', this.onPointerMove);
      window.removeEventListener('pointerup', this.onPointerUp);
      this.canvas.removeEventListener('wheel', this.onWheel);
      this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    });
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    this.dragging = true;
    this.pointerId = event.pointerId;
    this.lastX = this.downX = event.clientX;
    this.lastY = this.downY = event.clientY;
    this.moved = false;
    this.canvas.setPointerCapture?.(event.pointerId);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.dragging || event.pointerId !== this.pointerId) return;
    const dxPx = event.clientX - this.lastX;
    const dyPx = event.clientY - this.lastY;
    if (Math.hypot(event.clientX - this.downX, event.clientY - this.downY) > MapPointerInput.DRAG_THRESHOLD_PX) {
      this.moved = true;
    }
    if (!this.moved) return;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    const visible = this.camera.visibleSize;
    const worldPerPxX = visible.width / this.canvas.clientWidth;
    const worldPerPxZ = visible.height / this.canvas.clientHeight;
    // Drag right → map moves right → logical camera moves left.
    this.commands.send({
      type: 'map.panBy',
      dx: -dxPx * worldPerPxX,
      dz: -dyPx * worldPerPxZ
    });
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (!this.dragging || event.pointerId !== this.pointerId) return;
    this.dragging = false;
    this.pointerId = null;
    if (this.moved) return;
    // Click (not drag): resolve to a world pick.
    const rect = this.canvas.getBoundingClientRect();
    const world = this.camera.screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    this.commands.send({ type: 'map.pick', x: world.x, z: world.z });
  };

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const cursorPxX = event.clientX - rect.left;
    const cursorPxY = event.clientY - rect.top;
    const cursorWorld = this.camera.screenToWorld(cursorPxX, cursorPxY);
    const factor = event.deltaY > 0 ? 1.15 : 1 / 1.15;
    this.commands.send({
      type: 'map.zoomBy',
      factor,
      anchorX: cursorWorld.x,
      anchorZ: cursorWorld.z
    });
  };

  private readonly onContextMenu = (event: Event): void => {
    event.preventDefault();
  };

  dispose(): void {
    for (const unsubscribe of this.unsubscribeHandlers) unsubscribe();
    this.unsubscribeHandlers.length = 0;
  }
}
