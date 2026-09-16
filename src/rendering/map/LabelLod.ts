/**
 * LabelLod — pure, renderer-free label LOD decision logic (Part 2).
 *
 * Given the label records, the current camera view and the data-driven theme,
 * produces per-label alpha/visibility/scale for ONE frame:
 *
 *   1. zoom tier alpha — labels fade in/out over a view-height span, so the
 *      amount of visible text grows gradually with zoom (never a pop);
 *   2. viewport culling — labels outside the visible rect (with margin) are
 *      never rendered, regardless of how many exist (scales to thousands);
 *   3. collision — greedy screen-space placement ordered by priority
 *      (country > capital > province > major city > city), then population,
 *      then id — overlapping lower-priority labels are suppressed;
 *   4. cap — at most `maxVisible` labels render simultaneously;
 *   5. temporal easing — alpha approaches its target at a rate, so suppressed
 *      / re-admitted labels cross-fade instead of flickering.
 *
 * No Three.js, no DOM — unit-testable and reusable by any renderer backend.
 */

import type { MapLabelsThemeData, MapLabelTierData } from '../../data/types';

export type LabelTier = 'country' | 'province' | 'capital' | 'majorCity' | 'city' | 'settlement' | 'grid';

/** Static description of one label (built once — no per-frame allocation). */
export interface LabelRecord {
  readonly id: string;
  readonly tier: LabelTier;
  readonly x: number;
  readonly z: number;
  /** City population (0 for area labels) — collision tie-breaker. */
  readonly population: number;
  /** 0..1 city importance — nudges priority WITHIN a tier (never across). */
  readonly importance: number;
  /** Text width / height ratio (for the screen-space collision box). */
  readonly aspect: number;
  /** Area labels center on their point; city labels sit below their marker. */
  readonly offsetBelow: boolean;
}

/** Camera view snapshot needed for one decision pass. */
export interface LabelView {
  readonly centerX: number;
  readonly centerZ: number;
  readonly viewHeight: number;
  readonly aspect: number;
  readonly viewportWidthPx: number;
  readonly viewportHeightPx: number;
}

/** Mutable per-label alpha store (owned by the renderer, survives frames). */
export type LabelAlphaStore = Map<string, number>;

/** Decision output for one label this frame. */
export interface LabelFrame {
  readonly record: LabelRecord;
  readonly alpha: number;
  readonly visible: boolean;
  /** World-space sprite height that keeps the label `screenPx` tall on screen. */
  readonly scaleWorld: number;
  /** Screen anchor (px) of the label center — collision + debug. */
  readonly screenX: number;
  readonly screenY: number;
}

const ALPHA_EPSILON = 0.02;

/** Zoom-tier alpha target in [0, 1]: 1 deep inside the tier, 0 above it. */
export function tierAlpha(
  tier: MapLabelTierData,
  viewHeight: number,
  fadeSpan: number
): number {
  if (tier.maxViewHeight === null) return 1;
  if (viewHeight >= tier.maxViewHeight) return 0;
  const fadeStart = tier.maxViewHeight - fadeSpan; // fully visible at or below
  if (viewHeight <= fadeStart) return 1;
  return (tier.maxViewHeight - viewHeight) / fadeSpan;
}

function tierOf(theme: MapLabelsThemeData, tier: LabelTier): MapLabelTierData {
  return theme.tiers[tier];
}

/**
 * Effective screen size of a label: its tier size, never below the theme's
 * minimum readable size (a visible label is ALWAYS legible — spec §12).
 */
export function effectiveScreenPx(tier: MapLabelTierData, minReadablePx: number): number {
  return Math.max(tier.screenPx, minReadablePx);
}

/**
 * Collision/cap priority: the tier defines the band; city importance
 * (0..1) adds up to IMPORTANCE_BOOST within it — a more important city
 * wins overlaps against equal-tier neighbors, never against a higher tier.
 */
export const IMPORTANCE_BOOST = 8;
export function labelPriority(tier: MapLabelTierData, importance: number): number {
  return tier.priority + Math.round(Math.max(0, Math.min(1, importance)) * IMPORTANCE_BOOST);
}

/**
 * Runs one label LOD pass. `alphas` is mutated with the eased values so the
 * caller can persist them between frames (temporal cross-fading).
 */
export interface LabelLodOptions {
  /** Grid-cell labels render ONLY while the grid layer is visible. */
  readonly gridVisible: boolean;
}

export function updateLabels(
  records: readonly LabelRecord[],
  view: LabelView,
  theme: MapLabelsThemeData,
  alphas: LabelAlphaStore,
  dtSeconds: number,
  options: LabelLodOptions = { gridVisible: true }
): LabelFrame[] {
  const fadeSpan = theme.fadeSpanViewHeight;
  const halfHeight = view.viewHeight / 2;
  const halfWidth = halfHeight * view.aspect;
  const worldPerPx = view.viewHeight / view.viewportHeightPx;

  const minX = view.centerX - halfWidth;
  const maxX = view.centerX + halfWidth;
  const minZ = view.centerZ - halfHeight;
  const maxZ = view.centerZ + halfHeight;

  // Culling margin: enough for the biggest label fully inside the viewport.
  const marginZ = 60 * worldPerPx;
  const marginX = marginZ;

  const worldToScreenX = (x: number): number =>
    ((x - view.centerX) / halfWidth) * (view.viewportWidthPx / 2) + view.viewportWidthPx / 2;
  const worldToScreenY = (z: number): number =>
    ((z - view.centerZ) / halfHeight) * (view.viewportHeightPx / 2) + view.viewportHeightPx / 2;

  const fadeBlend = 1 - Math.exp(-theme.fadeRatePerSecond * Math.max(0, dtSeconds));

  // —— pass 1: tier + cull, collect candidates ——
  interface Candidate {
    record: LabelRecord;
    target: number;
    screenX: number;
    screenY: number;
    priority: number;
  }
  const candidates: Candidate[] = [];
  const frames: LabelFrame[] = [];

  for (const record of records) {
    let target = tierAlpha(tierOf(theme, record.tier), view.viewHeight, fadeSpan);
    if (record.tier === 'grid' && !options.gridVisible) target = 0;
    if (record.tier === 'majorCity' || record.tier === 'city' || record.tier === 'settlement') {
      const minPopulation = tierOf(theme, record.tier).minPopulation;
      if (record.population < minPopulation) target = 0;
    }
    // Viewport culling: outside (expanded) view → invisible this frame.
    const culled =
      record.x < minX - marginX ||
      record.x > maxX + marginX ||
      record.z < minZ - marginZ ||
      record.z > maxZ + marginZ;
    if (culled) target = 0;

    if (target <= 0 && (alphas.get(record.id) ?? 0) <= ALPHA_EPSILON) {
      // Fully invisible: fast path (no easing work, no sprite).
      if (alphas.has(record.id)) alphas.delete(record.id);
      continue;
    }
    candidates.push({
      record,
      target,
      screenX: worldToScreenX(record.x),
      screenY: worldToScreenY(record.z),
      priority: labelPriority(tierOf(theme, record.tier), record.importance)
    });
  }

  // —— pass 2: priority order → collision + cap ——
  candidates.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    if (b.record.population !== a.record.population) return b.record.population - a.record.population;
    return a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0;
  });

  const accepted: { x0: number; x1: number; y0: number; y1: number }[] = [];
  let visibleCount = 0;

  for (const candidate of candidates) {
    let visible = candidate.target > 0;
    if (visible) {
      if (visibleCount >= theme.maxVisible) {
        visible = false;
      } else {
        const tier = tierOf(theme, candidate.record.tier);
        const box = labelBox(
          candidate.screenX,
          candidate.screenY,
          effectiveScreenPx(tier, theme.minReadablePx),
          candidate.record.aspect,
          candidate.record.offsetBelow,
          theme.labelOffsetPx,
          theme.collisionPaddingPx
        );
        for (const other of accepted) {
          if (
            box.x0 < other.x1 &&
            box.x1 > other.x0 &&
            box.y0 < other.y1 &&
            box.y1 > other.y0
          ) {
            visible = false;
            break;
          }
        }
        if (visible) {
          accepted.push(box);
          visibleCount += 1;
        }
      }
    }

    // —— pass 3: temporal alpha easing (no popping, in or out) ——
    const previous = alphas.get(candidate.record.id) ?? 0;
    const easedTarget = visible ? Math.max(candidate.target, ALPHA_EPSILON) : 0;
    const alpha = previous + (easedTarget - previous) * fadeBlend;
    const finalAlpha = alpha <= ALPHA_EPSILON && easedTarget === 0 ? 0 : alpha;
    alphas.set(candidate.record.id, finalAlpha);

    if (finalAlpha <= ALPHA_EPSILON) {
      if (alphas.get(candidate.record.id) === 0) alphas.delete(candidate.record.id);
      frames.push({
        record: candidate.record,
        alpha: 0,
        visible: false,
        scaleWorld: scaledScreenPx(theme, candidate.record) * worldPerPx,
        screenX: candidate.screenX,
        screenY: candidate.screenY
      });
      continue;
    }
    frames.push({
      record: candidate.record,
      alpha: finalAlpha,
      visible: true,
      scaleWorld: scaledScreenPx(theme, candidate.record) * worldPerPx,
      screenX: candidate.screenX,
      screenY: candidate.screenY
    });
  }

  return frames;
}

/** Effective (floored) screen-pixel height for one record. */
function scaledScreenPx(theme: MapLabelsThemeData, record: LabelRecord): number {
  return effectiveScreenPx(tierOf(theme, record.tier), theme.minReadablePx);
}

/** Screen-space AABB of a label (px), including collision padding. */
function labelBox(
  screenX: number,
  screenY: number,
  screenPx: number,
  aspect: number,
  offsetBelow: boolean,
  labelOffsetPx: number,
  paddingPx: number
): { x0: number; x1: number; y0: number; y1: number } {
  const width = screenPx * aspect;
  const height = screenPx;
  const centerY = offsetBelow ? screenY + labelOffsetPx : screenY;
  return {
    x0: screenX - width / 2 - paddingPx,
    x1: screenX + width / 2 + paddingPx,
    y0: centerY - height / 2 - paddingPx,
    y1: centerY + height / 2 + paddingPx
  };
}
