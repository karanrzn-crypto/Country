import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { InMemoryDomAdapter, InMemoryUIElement } from '../../helpers/InMemoryDomAdapter';
import { ScreenManager } from '../../../ui/ScreenManager';
import { MapUI, formatCompact } from '../../../ui/MapUI';
import { flagDataUrl, flagSvg, clearFlagCache } from '../../../ui/flags';
import { createTestGame } from '../../helpers/testGame';
import type { Game } from '../../../core/Game';
import type { SystemContext } from '../../../core/GameContext';

describe('flag asset pipeline', () => {
  const flag = {
    layout: 'horizontal-stripes' as const,
    colors: ['#b23a48', '#f5efe2', '#b23a48'],
    emblem: 'star' as const,
    emblemColor: '#f0c75e'
  };

  it('renders a small SVG with the spec colors and emblem', () => {
    const svg = flagSvg(flag);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('#b23a48');
    expect(svg).toContain('<polygon'); // star
  });

  it('all four layouts render', () => {
    for (const layout of ['solid', 'horizontal-stripes', 'vertical-stripes', 'canton'] as const) {
      expect(flagSvg({ ...flag, layout })).toContain('<svg');
    }
    expect(flagSvg({ ...flag, layout: 'canton' })).toContain('<rect'); // canton block
  });

  it('data URLs are cached and stable', () => {
    clearFlagCache();
    const a = flagDataUrl(flag);
    const b = flagDataUrl(flag);
    expect(a).toBe(b);
    expect(a.startsWith('data:image/svg+xml')).toBe(true);
  });

  it('malformed colors fall back safely instead of injecting markup', () => {
    const svg = flagSvg({
      layout: 'solid',
      colors: ['<script/>bad'],
      emblem: 'none',
      emblemColor: 'not-a-color'
    });
    expect(svg).not.toContain('<script');
    expect(svg).toContain('#888888');
  });
});

describe('formatCompact', () => {
  it('formats large numbers compactly', () => {
    expect(formatCompact(7_400_000)).toBe('7.4 میلیون');
    expect(formatCompact(960_000)).toBe('960 هزار');
    expect(formatCompact(2_100_000_000)).toBe('2.1 میلیارد');
    expect(formatCompact(850)).toBe('850');
  });
});

describe('MapUI country info panel (Part 2)', () => {
  let game: Game;
  let context: SystemContext;
  let adapter: InMemoryDomAdapter;
  let mapUI: MapUI;

  function findElement(root: InMemoryUIElement, className: string): InMemoryUIElement | undefined {
    if (root.className === className) return root;
    for (const child of root.children) {
      const found = findElement(child, className);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  function findAll(root: InMemoryUIElement, className: string): InMemoryUIElement[] {
    const out: InMemoryUIElement[] = [];
    if (root.className === className) out.push(root);
    for (const child of root.children) out.push(...findAll(child, className));
    return out;
  }

  function textOf(root: InMemoryUIElement): string {
    return root.text + root.children.map((child) => textOf(child)).join(' ');
  }

  beforeAll(() => {
    game = createTestGame({ seed: 4242 });
    context = game.gameContext;
    adapter = new InMemoryDomAdapter();
    const screens = new ScreenManager(adapter, game.gameEvents);
    mapUI = new MapUI(screens, game.commandBus, (tag, className) => adapter.create(tag, className));
    mapUI.register(context, adapter.root());
  });

  afterAll(() => {
    game.dispose();
  });

  it('without selection: basic rows visible, detail hidden', () => {
    const detail = findElement(adapter.rootElement, 'map-country-detail');
    const basic = findElement(adapter.rootElement, 'map-country-basic');
    expect(detail?.visible ?? true).toBe(false);
    expect(basic?.visible ?? true).toBe(true);
  });

  it('selecting a country shows flag + full data, read from state (not owned by UI)', () => {
    const countryId = context.map.countryOrder[0];
    const state = context.state.countries.countries[countryId];
    game.commandBus.send({ type: 'map.select', countryId });
    game.commandBus.flush();
    mapUI.refreshInfo();

    const root = adapter.rootElement;
    const flagImgs = findAll(root, 'map-info-flag');
    expect(flagImgs.length).toBe(1);
    expect(flagImgs[0].attributes.get('src') ?? '').toContain('data:image/svg+xml');

    const detail = findElement(root, 'map-country-detail');
    expect(detail?.visible ?? false).toBe(true);
    const detailText = detail !== undefined ? textOf(detail) : '';
    expect(detailText).toContain(state.name);
    expect(detailText).toContain(context.map.cities[state.capitalId as string].name);

    // Economy / military values are rendered from the slice.
    expect(detailText).toContain(`${state.economy.gdp} میلیارد دلار`);
    expect(detailText).toContain(formatCompact(state.population));
    expect(detailText).toContain(`${state.military.aircraft}`);

    // Relations rows exist for countries with relations.
    const relationRows = findAll(root, 'map-relation-row');
    expect(relationRows.length).toBe(Object.keys(state.foreignRelations).length);
  });

  it('relation rows carry the band label (hostile…friendly)', () => {
    // Find a country with a negative relation for band assertions.
    const countryId = context.map.countryOrder.find((id) => {
      const state = context.state.countries.countries[id];
      return Object.values(state.foreignRelations).some((value) => value < 0);
    });
    if (countryId === undefined) return;
    game.commandBus.send({ type: 'map.select', countryId });
    game.commandBus.flush();
    mapUI.refreshInfo();
    const rows = findAll(adapter.rootElement, 'map-relation-row');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const band = row.children[row.children.length - 1];
      expect(band.className).toMatch(/band-(hostile|wary|neutral|cordial|friendly)/);
    }
  });

  it('clearing the selection returns to the basic view', () => {
    game.commandBus.send({ type: 'map.clearSelection' });
    game.commandBus.flush();
    mapUI.refreshInfo();
    const detail = findElement(adapter.rootElement, 'map-country-detail');
    expect(detail?.visible ?? true).toBe(false);
  });

  it('the country list screen renders a flag per row (renderer displays assets only)', () => {
    const adapter2 = new InMemoryDomAdapter();
    const screens = new ScreenManager(adapter2, game.gameEvents);
    const ui = new MapUI(screens, game.commandBus, (tag, className) => adapter2.create(tag, className));
    ui.register(context, adapter2.root());
    screens.open('map');
    const flags = findAll(adapter2.rootElement, 'map-row-flag');
    expect(flags.length).toBe(context.map.stats.countries);
    for (const flag of flags) {
      expect(flag.attributes.get('src') ?? '').toContain('data:image/svg+xml');
    }
  });
});
