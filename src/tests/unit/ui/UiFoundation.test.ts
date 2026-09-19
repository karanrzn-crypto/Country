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

  it('the ضربدر (X) close button removes the notification instantly (§7)', () => {
    const { container, notifications } = make();
    notifications.push('warn', 'درخواست صادرات', 'کشور X درخواست خرید دارد.', 0);
    expect(notifications.size).toBe(1);
    // The close button is the .nt-close child of the .nt-header row.
    const note = container.children[0]!;
    const header = note.children.find((child) => child.className === 'nt-header')!;
    const close = header.children.find((child) => child.className === 'nt-close')! as InMemoryUIElement;
    close.click();
    expect(notifications.size).toBe(0);
    expect(container.childCount).toBe(0);
  });

  it('action buttons fire their callback and remove the notification', () => {
    const { container, notifications } = make();
    let approved: string | null = null;
    notifications.push('warn', 'درخواست صادرات', 'کشور X درخواست خرید ۵۰ واحد غذا در ماه را دارد.', 0, {
      actions: [
        { label: 'موافقت', onClick: () => { approved = 'yes'; } },
        { label: 'مخالفت', onClick: () => { approved = 'no'; } }
      ]
    });
    const note = container.children[0]!;
    const actionsRow = note.children.find((child) => child.className === 'nt-actions')!;
    const approveButton = actionsRow.children[0]! as InMemoryUIElement;
    expect(approveButton.text).toBe('موافقت');
    approveButton.click();
    expect(approved).toBe('yes');
    expect(notifications.size).toBe(0);
    expect(container.childCount).toBe(0);
  });
});

describe('HUD model (pure)', () => {
  it('builds mode, treasury, population and chunk counters from state', () => {
    const game = createTestGame();
    game.runTicks(30);
    const state = game.gameState;
    const model = buildHudModel(state, 'رئیس‌جمهور', game.gameWorld.counts());
    expect(model.mode).toBe('رئیس‌جمهور');
    expect(model.treasury).not.toBe('');
    expect(model.chunks).toMatch(/^A:\d+ S:\d+ U:\d+$/);
    game.dispose();
  });
});
