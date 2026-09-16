import { describe, it, expect } from 'vitest';
import { updateLabels, tierAlpha } from '../../../rendering/map/LabelLod';
import type { LabelAlphaStore, LabelRecord, LabelView } from '../../../rendering/map/LabelLod';
import type { MapLabelsThemeData } from '../../../data/types';
import mapThemeJson from '../../../data/mapTheme.json';

const labels = (mapThemeJson as unknown as { labels: MapLabelsThemeData }).labels;

const VIEWPORT = { widthPx: 1280, heightPx: 720 };

function view(viewHeight: number, centerX = 150, centerZ = 100): LabelView {
  return {
    centerX,
    centerZ,
    viewHeight,
    aspect: VIEWPORT.widthPx / VIEWPORT.heightPx,
    viewportWidthPx: VIEWPORT.widthPx,
    viewportHeightPx: VIEWPORT.heightPx
  };
}

function record(overrides: Partial<LabelRecord> & { id: string }): LabelRecord {
  return {
    tier: 'city',
    x: 150,
    z: 100,
    population: 100_000,
    importance: 0,
    aspect: 3,
    offsetBelow: true,
    ...overrides
  };
}

/** Runs the pass until alphas settle; returns (frames, alphas). */
function settled(records: LabelRecord[], v: LabelView, seconds = 4) {
  const alphas: LabelAlphaStore = new Map();
  let frames = updateLabels(records, v, labels, alphas, 1 / 60);
  for (let i = 0; i < seconds * 60; i++) frames = updateLabels(records, v, labels, alphas, 1 / 60);
  return { frames, alphas };
}

function alphaOf(frames: ReturnType<typeof updateLabels>, id: string): number {
  const frame = frames.find((candidate) => candidate.record.id === id);
  return frame !== undefined ? frame.alpha : 0;
}

describe('label LOD tiers (zoom-dependent visibility)', () => {
  // Positions are spread so collision never suppresses a tier member that the
  // test expects visible (bigger labels + offset need more separation now):
  // at near zoom (26) the viewport covers z 87–113, x 127–173.
  const records = [
    record({ id: 'country', tier: 'country', x: 150, z: 89 }),
    record({ id: 'province', tier: 'province', x: 140, z: 98 }),
    record({ id: 'capital', tier: 'capital', population: 1_500_000, z: 104 }),
    record({ id: 'major', tier: 'majorCity', population: 900_000, x: 162, z: 95 }),
    record({ id: 'small', tier: 'city', population: 120_000, x: 140, z: 94 })
  ];

  it('far zoom: countries + capitals only — no province/major/city labels', () => {
    // Just above the province tier's cutoff — everything below it is hidden.
    const { frames } = settled(records, view((labels.tiers.province.maxViewHeight as number) + 1));
    expect(alphaOf(frames, 'country')).toBeGreaterThan(0.9);
    expect(alphaOf(frames, 'capital')).toBeGreaterThan(0.9);
    expect(alphaOf(frames, 'province')).toBe(0);
    expect(alphaOf(frames, 'major')).toBe(0);
    expect(alphaOf(frames, 'small')).toBe(0);
  });

  it('mid zoom: provinces + capitals + major cities; plain cities still hidden', () => {
    // Just above the city tier's cutoff — plain cities stay hidden while
    // provinces/majors are fully faded in.
    const { frames } = settled(records, view((labels.tiers.city.maxViewHeight as number) + 1));
    expect(alphaOf(frames, 'country')).toBeGreaterThan(0.9);
    expect(alphaOf(frames, 'capital')).toBeGreaterThan(0.9);
    expect(alphaOf(frames, 'province')).toBeGreaterThan(0.9);
    expect(alphaOf(frames, 'major')).toBeGreaterThan(0.9);
    expect(alphaOf(frames, 'small')).toBe(0);
  });

  it('near zoom: everything visible', () => {
    const { frames } = settled(records, view(26));
    for (const id of ['country', 'province', 'capital', 'major', 'small']) {
      expect(alphaOf(frames, id)).toBeGreaterThan(0.9);
    }
  });

  it('major-city population gate: below the threshold a "major" label never shows', () => {
    const poor = [record({ id: 'poor-major', tier: 'majorCity', population: 300_000 })];
    const { frames } = settled(poor, view(26));
    expect(alphaOf(frames, 'poor-major')).toBe(0);
  });

  it('tierAlpha fades over the span instead of popping', () => {
    const city = labels.tiers.city;
    const maxV = city.maxViewHeight as number;
    const span = labels.fadeSpanViewHeight;
    expect(tierAlpha(city, maxV + 1, span)).toBe(0); // above threshold
    expect(tierAlpha(city, maxV - span / 2, span)).toBeGreaterThan(0);
    expect(tierAlpha(city, maxV - span / 2, span)).toBeLessThan(1);
    expect(tierAlpha(city, maxV - span, span)).toBe(1);
  });
});

describe('label LOD fading (no sudden pops)', () => {
  it('alpha eases smoothly frame by frame (bounded per-frame change)', () => {
    const records = [record({ id: 'city', tier: 'city', population: 500_000 })];
    const alphas: LabelAlphaStore = new Map();
    const v = view(60);
    let previous = 0;
    for (let i = 0; i < 60; i++) {
      const frames = updateLabels(records, v, labels, alphas, 1 / 60);
      const alpha = alphaOf(frames, 'city');
      // Per-frame alpha delta is small: gradual appearance, never a pop.
      expect(Math.abs(alpha - previous)).toBeLessThan(0.35);
      previous = alpha;
    }
    expect(previous).toBeGreaterThan(0.9);
  });

  it('alpha is continuous across the tier boundary (crossing takes the whole span)', () => {
    const records = [record({ id: 'capital', tier: 'capital' })];
    // Both probe points sit INSIDE the fade zone [max-span, max] so the
    // comparison exercises the fade itself (not the saturated ends).
    const maxV = labels.tiers.capital.maxViewHeight as number;
    const span = labels.fadeSpanViewHeight;
    const atUpper = settled(records, view(maxV - span * 0.25)).frames; // α ≈ 0.25
    const atLower = settled(records, view(maxV - span * 0.75)).frames; // α ≈ 0.75
    expect(alphaOf(atUpper, 'capital')).toBeGreaterThan(0);
    expect(alphaOf(atUpper, 'capital')).toBeLessThan(1);
    expect(alphaOf(atLower, 'capital')).toBeGreaterThan(alphaOf(atUpper, 'capital'));
  });
});

describe('label LOD culling, collision and cap', () => {
  it('labels outside the viewport are never rendered', () => {
    const records = [record({ id: 'offscreen', tier: 'city', x: 2_000, z: -1_500 })];
    const { frames } = settled(records, view(26));
    expect(alphaOf(frames, 'offscreen')).toBe(0);
  });

  it('collision: the higher-priority label wins, the loser is suppressed', () => {
    const records = [
      record({ id: 'capital', tier: 'capital', population: 2_000_000 }),
      record({ id: 'small', tier: 'city', population: 90_000, x: 150.5, z: 100.5 })
    ];
    const { frames } = settled(records, view(40));
    expect(alphaOf(frames, 'capital')).toBeGreaterThan(0.9);
    expect(alphaOf(frames, 'small')).toBe(0);
  });

  it('collision is distance-dependent: non-overlapping labels coexist', () => {
    const records = [
      record({ id: 'a', tier: 'city', x: 130, z: 90 }),
      record({ id: 'b', tier: 'city', x: 170, z: 110 })
    ];
    const { frames } = settled(records, view(30));
    expect(alphaOf(frames, 'a')).toBeGreaterThan(0.9);
    expect(alphaOf(frames, 'b')).toBeGreaterThan(0.9);
  });

  it('cap: no more than maxVisible labels render at once', () => {
    const records: LabelRecord[] = [];
    // 300 cities spread over the visible area at view 30 (z 85–115, x 123–177)
    // with enough spacing that collision is not the limiting factor.
    for (let i = 0; i < 300; i++) {
      records.push(
        record({
          id: `city-${i}`,
          tier: 'city',
          x: 128 + (i % 30) * 1.7,
          z: 86 + Math.floor(i / 30) * 4
        })
      );
    }
    const { frames } = settled(records, view(30), 8);
    const visible = frames.filter((frame) => frame.visible);
    expect(visible.length).toBeLessThanOrEqual(labels.maxVisible);
    expect(visible.length).toBeGreaterThan(50); // sanity: culling/collision not over-aggressive
  });

  it('priority ordering: capitals beat provinces beat cities at equal spots', () => {
    const records = [
      record({ id: 'province', tier: 'province' }),
      record({ id: 'capital', tier: 'capital' })
    ];
    const { frames } = settled(records, view(80));
    expect(alphaOf(frames, 'capital')).toBeGreaterThan(0.9);
    expect(alphaOf(frames, 'province')).toBe(0);
  });
});

describe('Part 3 label rules (settlement tier, readability floor, importance)', () => {
  it('settlement labels only appear when deeply zoomed in', () => {
    const settlement = record({ id: 'village', tier: 'settlement', population: 5_000 });
    const { frames: far } = settled([settlement], view(200));
    expect(alphaOf(far, 'village')).toBe(0);
    const { frames: near } = settled([settlement], view(40));
    expect(alphaOf(near, 'village')).toBeGreaterThan(0.9);
  });

  it('a visible label never shrinks below the theme minimum readable size', () => {
    const tierPx = labels.tiers.settlement.screenPx;
    expect(tierPx).toBeGreaterThanOrEqual(labels.minReadablePx);
    for (const tierName of Object.keys(labels.tiers) as (keyof typeof labels.tiers)[]) {
      expect(labels.tiers[tierName].screenPx).toBeGreaterThanOrEqual(labels.minReadablePx);
    }
  });

  it('importance nudges collision priority WITHIN a tier, never across tiers', () => {
    // Same tier: the more important city wins the overlap.
    const a = record({ id: 'a', tier: 'settlement', x: 150, z: 100, importance: 1 });
    const b = record({ id: 'b', tier: 'settlement', x: 151, z: 100, importance: 0 });
    const { frames } = settled([a, b], view(40));
    expect(alphaOf(frames, 'a')).toBeGreaterThan(0.9);
    expect(alphaOf(frames, 'b')).toBe(0);
    // Cross-tier: the boost can never let a settlement beat a capital.
    const boosted = record({ id: 'boosted', tier: 'settlement', x: 150, z: 100, importance: 1 });
    const capital = record({ id: 'capital', tier: 'capital', x: 151, z: 100 });
    const { frames: cross } = settled([boosted, capital], view(40));
    expect(alphaOf(cross, 'capital')).toBeGreaterThan(0.9);
    expect(alphaOf(cross, 'boosted')).toBe(0);
  });
});
