import { describe, it, expect } from 'vitest';
import { MapCamera } from '../../../rendering/map/MapCamera';
import type { MapBounds } from '../../../world/map/MapTypes';
import { generateStrategicMap } from '../../../world/map/MapGenerator';
import { DEFAULT_MAP_CONFIG } from '../../helpers/mapTestConfig';
import { pickAt, pointInRing } from '../../../world/map/MapQueries';

/**
 * Part 2 camera rework — behavioral spec:
 * smooth (no teleport), cursor-centered zoom, no corner-fling on zoom-out,
 * clamped natural pan, hard zoom limits that stop without resetting.
 */
describe('MapCamera smoothing rig', () => {
  const bounds: MapBounds = { minX: 0, minZ: 0, maxX: 300, maxZ: 200 };
  const viewport = { width: 1280, height: 720 };

  function makeCamera(start = { x: 150, z: 100, viewHeight: 200 }): MapCamera {
    const camera = new MapCamera(viewport.width, viewport.height, start);
    camera.setLimits({ bounds, minViewHeight: 26, maxViewHeight: 260 });
    return camera;
  }

  /** Runs updates until the view settles (or the step budget runs out). */
  function settle(camera: MapCamera, target: { x: number; z: number; viewHeight: number }, seconds = 6): void {
    const dt = 1 / 60;
    for (let i = 0; i < seconds * 60; i++) camera.update(dt, target);
  }

  it('eases toward the target without teleporting (damped motion, bounded per-frame step)', () => {
    const camera = makeCamera({ x: 150, z: 100, viewHeight: 200 });
    const target = { x: 150, z: 100, viewHeight: 40 };
    let previous = camera.view.viewHeight;
    let maxStep = 0;
    for (let i = 0; i < 240; i++) {
      camera.update(1 / 60, target);
      const step = Math.abs(camera.view.viewHeight - previous);
      maxStep = Math.max(maxStep, step);
      previous = camera.view.viewHeight;
    }
    // Smooth: even the first frame covers only a fraction of the 160-unit
    // distance (no teleport); the ease then decays geometrically.
    expect(maxStep).toBeLessThan(40);
    expect(camera.view.viewHeight).toBeCloseTo(40, 1);
  });

  it('frame-rate independence: large dt converges to the same place', () => {
    const a = makeCamera({ x: 150, z: 100, viewHeight: 200 });
    const b = makeCamera({ x: 150, z: 100, viewHeight: 200 });
    const target = { x: 80, z: 60, viewHeight: 50 };
    for (let i = 0; i < 60; i++) a.update(1 / 60, target);
    for (let i = 0; i < 10; i++) b.update(0.1, target);
    expect(b.view.viewHeight).toBeCloseTo(a.view.viewHeight, 1);
    expect(b.view.x).toBeCloseTo(a.view.x, 0);
  });

  /** Mirrors Game.mapZoomBy: the logical target is ALWAYS anchor-consistent. */
  function coreZoomTarget(
    screenX: number,
    screenY: number,
    anchor: { x: number; z: number },
    targetViewHeight: number
  ): { x: number; z: number; viewHeight: number } {
    const aspect = viewport.width / viewport.height;
    const ndcX = (screenX / viewport.width) * 2 - 1;
    const ndcY = (screenY / viewport.height) * 2 - 1;
    return {
      x: anchor.x - ndcX * ((targetViewHeight * aspect) / 2),
      z: anchor.z - ndcY * (targetViewHeight / 2),
      viewHeight: targetViewHeight
    };
  }

  it('cursor-centered zoom: the anchor world point stays under the cursor pixel', () => {
    const camera = makeCamera({ x: 150, z: 100, viewHeight: 200 });
    const screenX = 640;
    const screenY = 360;
    const anchor = camera.screenToWorld(screenX, screenY);
    camera.beginZoomGesture({ anchorX: anchor.x, anchorZ: anchor.z, screenX, screenY });
    const target = coreZoomTarget(screenX, screenY, anchor, 40);

    let midFlightError = 0;
    for (let i = 0; i < 240; i++) {
      camera.update(1 / 60, target);
      const underCursor = camera.screenToWorld(screenX, screenY);
      const error = Math.hypot(underCursor.x - anchor.x, underCursor.z - anchor.z);
      if (i === 30) midFlightError = error;
      if (i === 239) {
        // Settled: EXACT anchor preservation.
        expect(error).toBeLessThan(0.05);
        expect(camera.view.viewHeight).toBeCloseTo(40, 1);
      }
      // Clamped every frame: never leaves the map bounds.
      expect(camera.view.x).toBeGreaterThanOrEqual(bounds.minX - 60);
      expect(camera.view.x).toBeLessThanOrEqual(bounds.maxX + 60);
    }
    // Mid-flight the anchor was already close (city barely moves under cursor).
    expect(midFlightError).toBeLessThan(6);
  });

  it('zoom-out near the edge never flings the map to a corner', () => {
    // Start fully zoomed in at the right edge of the map.
    const camera = makeCamera({ x: 290, z: 100, viewHeight: 30 });
    const screenX = 640;
    const screenY = 360;
    const anchor = camera.screenToWorld(screenX, screenY);
    camera.beginZoomGesture({ anchorX: anchor.x, anchorZ: anchor.z, screenX, screenY });
    const target = coreZoomTarget(screenX, screenY, anchor, 260);

    let previousX = camera.view.x;
    let maxJump = 0;
    for (let i = 0; i < 240; i++) {
      camera.update(1 / 60, target);
      maxJump = Math.max(maxJump, Math.abs(camera.view.x - previousX));
      previousX = camera.view.x;
      // The center stays near the map — never tossed into a far corner.
      expect(camera.view.x).toBeLessThanOrEqual(bounds.maxX + 40);
      expect(camera.view.x).toBeGreaterThanOrEqual(bounds.minX - 40);
      expect(camera.view.z).toBeGreaterThanOrEqual(bounds.minZ - 40);
      expect(camera.view.z).toBeLessThanOrEqual(bounds.maxZ + 40);
    }
    expect(maxJump).toBeLessThan(25); // smooth glide (incl. intended re-centering swing), no teleport
    expect(camera.view.viewHeight).toBeCloseTo(260, 1);
    // The zoomed-out view always ends framed around the map center.
    expect(camera.view.x).toBeCloseTo((bounds.minX + bounds.maxX) / 2, 0);
    expect(camera.view.z).toBeCloseTo((bounds.minZ + bounds.maxZ) / 2, 0);
  });

  it('pan is clamped and eases to a stop at the edge (no snap)', () => {
    const camera = makeCamera({ x: 150, z: 100, viewHeight: 60 });
    const target = { x: 100_000, z: -50_000, viewHeight: 60 };
    let previousX = camera.view.x;
    let maxJump = 0;
    for (let i = 0; i < 240; i++) {
      camera.update(1 / 60, target);
      maxJump = Math.max(maxJump, Math.abs(camera.view.x - previousX));
      previousX = camera.view.x;
      expect(camera.view.x).toBeLessThanOrEqual(bounds.maxX + 40);
    }
    // Converged to the clamped stop, not the raw (unreachable) target.
    expect(camera.view.x).toBeLessThan(bounds.maxX + 40);
    // Per-frame motion stays proportionally small even for a huge jump.
    expect(maxJump).toBeLessThan(80);
  });

  it('zoom limits stop at min/max without resetting the camera', () => {
    const camera = makeCamera({ x: 150, z: 100, viewHeight: 200 });
    // Zoom out far beyond the limit (viewHeight above max = fully zoomed out).
    settle(camera, { x: 150, z: 100, viewHeight: 100_000 }, 10);
    expect(camera.view.viewHeight).toBeCloseTo(260, 1);
    expect(camera.view.x).toBeCloseTo(150, 0); // center preserved
    // Zoom in far beyond the limit (viewHeight below min = fully zoomed in).
    settle(camera, { x: 150, z: 100, viewHeight: 0.001 }, 10);
    expect(camera.view.viewHeight).toBeCloseTo(26, 1);
    expect(camera.view.x).toBeCloseTo(150, 0); // still the same center — no reset
  });

  it('cancelZoomGesture releases the anchor and eases to the target center', () => {
    const camera = makeCamera({ x: 150, z: 100, viewHeight: 200 });
    const anchor = camera.screenToWorld(640, 360);
    camera.beginZoomGesture({ anchorX: anchor.x, anchorZ: anchor.z, screenX: 640, screenY: 360 });
    camera.update(1 / 60, { x: 150, z: 100, viewHeight: 100 });
    camera.cancelZoomGesture();
    settle(camera, { x: 180, z: 120, viewHeight: 100 });
    expect(camera.view.x).toBeCloseTo(180, 0);
    expect(camera.view.z).toBeCloseTo(120, 0);
  });

  it('screenToWorld ↔ anchored center are consistent inverses', () => {
    const camera = makeCamera({ x: 150, z: 100, viewHeight: 80 });
    const world = camera.screenToWorld(300, 200);
    const anchor = { anchorX: world.x, anchorZ: world.z, screenX: 300, screenY: 200 };
    camera.beginZoomGesture(anchor);
    camera.update(1 / 60, { x: 9999, z: 9999, viewHeight: 80 });
    const under = camera.screenToWorld(300, 200);
    expect(under.x).toBeCloseTo(world.x, 3);
    expect(under.z).toBeCloseTo(world.z, 3);
  });

  // —— orientation contract (click-selection regression) ——
  // The rig renders with up = (0,0,-1): NORTH (-Z) is the TOP of the screen.
  // screenToWorld MUST match that convention or clicks land on the mirrored
  // world position (the Part 2 selection bug: clicks picked the country
  // mirrored across the horizontal screen center line).
  describe('screenToWorld orientation contract (north = -Z = screen top)', () => {
    it('maps the four screen quadrants to the correct world quadrants', () => {
      const camera = makeCamera({ x: 150, z: 100, viewHeight: 200 });
      const topLeft = camera.screenToWorld(0, 0);
      const topRight = camera.screenToWorld(viewport.width, 0);
      const bottomLeft = camera.screenToWorld(0, viewport.height);
      const bottomRight = camera.screenToWorld(viewport.width, viewport.height);
      expect(topLeft.x).toBeLessThan(camera.view.x);
      expect(topRight.x).toBeGreaterThan(camera.view.x);
      // Screen top = world -Z: top-of-screen pixels are NORTH of the center.
      expect(topLeft.z).toBeLessThan(camera.view.z);
      expect(bottomLeft.z).toBeGreaterThan(camera.view.z);
      expect(bottomRight.x).toBeGreaterThan(camera.view.x);
      expect(bottomRight.z).toBeGreaterThan(camera.view.z);
    });

    it('screenToWorld(center pixel) returns the camera center exactly', () => {
      const camera = makeCamera({ x: 150, z: 100, viewHeight: 90 });
      const world = camera.screenToWorld(viewport.width / 2, viewport.height / 2);
      expect(world.x).toBeCloseTo(150, 6);
      expect(world.z).toBeCloseTo(100, 6);
    });

    it('zoom-anchoring keeps the VISUALLY displayed point under the cursor (not the mirrored one)', () => {
      // Anchor a point that is NORTH of the center, then verify the gesture
      // keeps THAT point under the cursor at settle time.
      const camera = makeCamera({ x: 150, z: 100, viewHeight: 200 });
      const screenX = 640;
      const screenY = 100; // upper part of the screen → world z must be < 100
      const anchor = camera.screenToWorld(screenX, screenY);
      expect(anchor.z).toBeLessThan(100); // orientation sanity for the anchor itself
      camera.beginZoomGesture({ anchorX: anchor.x, anchorZ: anchor.z, screenX, screenY });
      const target = coreZoomTarget(screenX, screenY, anchor, 40);
      for (let i = 0; i < 240; i++) camera.update(1 / 60, target);
      const under = camera.screenToWorld(screenX, screenY);
      expect(under.x).toBeCloseTo(anchor.x, 2);
      expect(under.z).toBeCloseTo(anchor.z, 2);
    });

    it('integrated: clicking (screenToWorld → pickAt) selects the country actually under the cursor', () => {
      const { model } = generateStrategicMap(DEFAULT_MAP_CONFIG);
      const camera = makeCamera({ x: 150, z: 100, viewHeight: 200 });
      const pickRadius = DEFAULT_MAP_CONFIG.pickRadiusFraction * 200;
      for (const countryId of model.countryOrder) {
        const country = model.countries[countryId];
        // Deep interior probe: the country's own label point.
        const world = { x: country.labelPoint.x, z: country.labelPoint.z };
        // world → screen (the rendering convention, north = -Z = up)…
        const halfHeight = camera.view.viewHeight / 2;
        const halfWidth = halfHeight * (viewport.width / viewport.height);
        const sx = viewport.width / 2 + ((world.x - camera.view.x) / halfWidth) * (viewport.width / 2);
        const sy = viewport.height / 2 + ((world.z - camera.view.z) / halfHeight) * (viewport.height / 2);
        // …then back through the camera the way MapPointerInput does.
        const roundTripped = camera.screenToWorld(sx, sy);
        expect(roundTripped.x).toBeCloseTo(world.x, 4);
        expect(roundTripped.z).toBeCloseTo(world.z, 4);
        const pick = pickAt(model, roundTripped, { pickRadius, riverPickDistance: pickRadius, columns: DEFAULT_MAP_CONFIG.columns, rows: DEFAULT_MAP_CONFIG.rows, cellSize: DEFAULT_MAP_CONFIG.cellSize, eligibility: { grid: false, rivers: false, lakes: false, sites: false, buildings: false } });
        expect(pick.countryId).toBe(countryId);
      }
    });

    it('integrated: picks resolve correctly in ALL FOUR screen quadrants of the real map', () => {
      const { model } = generateStrategicMap(DEFAULT_MAP_CONFIG);
      const camera = makeCamera({ x: 150, z: 100, viewHeight: 200 });
      const pickRadius = DEFAULT_MAP_CONFIG.pickRadiusFraction * 200;
      let samples = 0;
      for (const [fx, fy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]] as const) {
        const sx = viewport.width * fx;
        const sy = viewport.height * fy;
        const world = camera.screenToWorld(sx, sy);
        const expected = model.countryOrder.find((id) => pointInRing(world, model.countries[id].ring.points));
        if (expected === undefined) continue; // ocean sample
        const pick = pickAt(model, world, { pickRadius, riverPickDistance: pickRadius, columns: DEFAULT_MAP_CONFIG.columns, rows: DEFAULT_MAP_CONFIG.rows, cellSize: DEFAULT_MAP_CONFIG.cellSize, eligibility: { grid: false, rivers: false, lakes: false, sites: false, buildings: false } });
        expect(pick.countryId).toBe(expected);
        samples++;
      }
      expect(samples).toBeGreaterThanOrEqual(2); // the full view covers the continent
    });
  });
});
