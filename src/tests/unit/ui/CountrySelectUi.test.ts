import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { InMemoryDomAdapter, InMemoryUIElement } from '../../helpers/InMemoryDomAdapter';
import { ScreenManager } from '../../../ui/ScreenManager';
import { MapUI } from '../../../ui/MapUI';
import { createTestGame } from '../../helpers/testGame';
import type { Game } from '../../../core/Game';
import type { SystemContext } from '../../../core/GameContext';

/**
 * Country-select screen (Part 3): rows are data-driven from the map model +
 * country slice; the confirm button reflects the CURRENT map selection and
 * sends the player.confirmCountry command (UI sends commands, never mutates).
 */
describe('MapUI country-select screen', () => {
  let game: Game;
  let context: SystemContext;
  let adapter: InMemoryDomAdapter;
  let mapUI: MapUI;
  let screens: ScreenManager;

  function findElement(root: InMemoryUIElement, className: string): InMemoryUIElement | undefined {
    // Multi-class matching: className may be "screen-confirm disabled" etc.
    if (has(root, className)) return root;
    for (const child of root.children) {
      const found = findElement(child, className);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  function has(element: InMemoryUIElement, className: string): boolean {
    return element.className.split(/\s+/).includes(className);
  }

  function findAll(root: InMemoryUIElement, className: string): InMemoryUIElement[] {
    const out: InMemoryUIElement[] = [];
    if (has(root, className)) out.push(root);
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
    screens = new ScreenManager(adapter, game.gameEvents);
    mapUI = new MapUI(screens, game.commandBus, (tag, className) => adapter.create(tag, className));
    mapUI.register(context, adapter.root());
    screens.open('countrySelect');
  });

  afterAll(() => {
    game.dispose();
  });

  it('lists every country from the model with flags (data-driven, none hardcoded)', () => {
    const rows = findAll(adapter.rootElement, 'map-country-row');
    expect(rows.length).toBe(context.map.countryOrder.length);
    expect(textOf(adapter.rootElement)).toContain('Choose Your Country');
    const flags = findAll(adapter.rootElement, 'map-row-flag');
    expect(flags.length).toBe(rows.length);
    for (const flag of flags) {
      expect(flag.attributes.get('src') ?? '').toContain('data:image/svg+xml');
    }
  });

  it('confirm starts disabled without a selection', () => {
    game.commandBus.send({ type: 'map.clearSelection' });
    game.commandBus.flush();
    mapUI.refreshCountrySelect();
    const confirm = findElement(adapter.rootElement, 'screen-confirm');
    expect(confirm?.className).toContain('disabled');
  });

  it('clicking a row selects that country and enables confirm', () => {
    const countryId = context.map.countryOrder[1];
    const rows = findAll(adapter.rootElement, 'map-country-row');
    // Rows are built in model order — click the second row.
    rows[1].click();
    game.commandBus.flush();
    expect(context.state.map.selectedCountryId).toBe(countryId);
    mapUI.refreshCountrySelect();
    const confirm = findElement(adapter.rootElement, 'screen-confirm');
    expect(confirm?.className).not.toContain('disabled');
  });

  it('confirm sends player.confirmCountry with the CURRENT selection', () => {
    const countryId = context.state.map.selectedCountryId as string;
    const confirm = findElement(adapter.rootElement, 'screen-confirm');
    confirm?.click();
    game.commandBus.flush();
    expect(game.gameState.player.countryId).toBe(countryId);
    expect(game.gameState.player.countryConfirmed).toBe(true);
  });

  it('layer toggles exist for every registered layer with labels', () => {
    const toggles = findAll(adapter.rootElement, 'map-layer-toggle');
    // Registry order — all 27 layers have a button.
    expect(toggles.length).toBe(27);
    const texts = toggles.map((button) => button.text);
    expect(texts).toContain('Biomes');
    expect(texts).toContain('Terrain');
    expect(texts).toContain('Roads');
    expect(texts).toContain('Rivers');
    expect(texts).toContain('Lakes / Water');
    expect(texts).toContain('Geographic Grid');
    expect(texts).toContain('Airports');
    expect(texts).toContain('Buildings');
    expect(texts).toContain('Strategic Value');
    expect(texts).toContain('Industry');
    expect(texts).toContain('Resources');
    expect(texts).toContain('Ports');
    expect(texts).toContain('Railways');
    expect(texts).toContain('Military');
    expect(texts).toContain('Provinces');
    expect(texts).toContain('Population');
    expect(texts).toContain('Economy');
    expect(texts).toContain('Weather');
    expect(texts).toContain('Intelligence');
  });
});
