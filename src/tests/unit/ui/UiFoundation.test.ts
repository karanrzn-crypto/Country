import { describe, it, expect } from 'vitest';
import { EventBus } from '../../../events/EventBus';
import { ScreenManager } from '../../../ui/ScreenManager';
import { NotificationSystem } from '../../../ui/NotificationSystem';
import { buildHudModel } from '../../../ui/HUDModel';
import { InMemoryDomAdapter, InMemoryUIElement } from '../../helpers/InMemoryDomAdapter';
import { createTestGame } from '../../helpers/testGame';

describe('ScreenManager (stack discipline)', () => {
  function make(): { screens: ScreenManager; adapter: InMemoryDomAdapter; events: EventBus } {
    const adapter = new InMemoryDomAdapter();
    const events = new EventBus();
    const screens = new ScreenManager(adapter, events);
    screens.registerScreen('main', (container) => {
      const el = adapter.create('h1');
      el.setText('MAIN');
      container.appendChild(el);
    });
    screens.registerScreen('map', () => undefined);
    return { screens, adapter, events };
  }

  it('opens screens and tracks the current one', () => {
    const { screens } = make();
    screens.open('main');
    expect(screens.current).toBe('main');
    expect(screens.isOpen('main')).toBe(true);
  });

  it('builds screen content through the adapter', () => {
    const { screens, adapter } = make();
    screens.open('main');
    const root = adapter.rootElement;
    expect(root.childCount).toBe(1);
  });

  it('close removes the screen and emits the event', () => {
    const { screens, events } = make();
    const changes: string[] = [];
    events.on('ui.screenChanged', ({ opened, closed }) => changes.push(`${closed}→${opened}`));
    screens.open('main');
    screens.close('main');
    expect(screens.current).toBeNull();
    expect(changes).toContain('main→null');
  });

  it('duplicate open refocuses instead of duplicating', () => {
    const { screens } = make();
    screens.open('main');
    screens.open('main');
    expect(screens.depth).toBe(1);
  });

  it('stack: opening the map over the menu returns to the menu after closeTop', () => {
    const { screens } = make();
    screens.open('main');
    screens.open('map');
    expect(screens.current).toBe('map');
    screens.closeTop();
    expect(screens.current).toBe('main');
  });

  it('throws for unknown screens', () => {
    const { screens } = make();
    expect(() => screens.open('ghost')).toThrowError();
  });
});

describe('NotificationSystem', () => {
  function make() {
    const container = new InMemoryUIElement();
    const notifications = new NotificationSystem(container, (tag, className) => {
      const element = new InMemoryUIElement();
      element.className = className ?? tag;
      return element;
    }, 100, 3);
    return { container, notifications };
  }

  it('pushes notifications with elements', () => {
    const { container, notifications } = make();
    notifications.push('info', 'Title', 'Message', 0);
    expect(notifications.size).toBe(1);
    expect(container.childCount).toBe(1);
  });

  it('expires notifications after TTL frames', () => {
    const { container, notifications } = make();
    notifications.push('info', 'Title', 'Message', 0);
    notifications.update(99);
    expect(notifications.size).toBe(1);
    notifications.update(100);
    expect(notifications.size).toBe(0);
    expect(container.childCount).toBe(0);
  });

  it('caps the number of visible notifications', () => {
    const { container, notifications } = make();
    for (let index = 0; index < 6; index++) {
      notifications.push('info', `t${index}`, 'm', index);
    }
    expect(notifications.size).toBe(3);
    expect(container.childCount).toBe(3);
  });
});

describe('HUD model (pure)', () => {
  it('formats date, treasury, population and chunk counters', () => {
    const game = createTestGame();
    game.runTicks(30);
    const state = game.gameState;
    const model = buildHudModel(
      state,
      game.gameTime.date,
      false,
      2,
      'President',
      game.gameWorld.counts()
    );
    expect(model.date).toMatch(/^2030-01-0[23] \d{2}:00$/);
    expect(model.speed).toBe('×2');
    expect(model.mode).toBe('President');
    expect(model.treasury).not.toBe('');
    expect(model.chunks).toMatch(/^A:\d+ S:\d+ U:\d+$/);
    game.dispose();
  });
});
