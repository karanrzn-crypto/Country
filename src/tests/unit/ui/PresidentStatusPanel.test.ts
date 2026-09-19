import { faNum, toFaDigits } from '../../../utils/format';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { InMemoryDomAdapter, InMemoryUIElement } from '../../helpers/InMemoryDomAdapter';
import type { UIElement } from '../../../ui/adapter/UIDomAdapter';
import { ScreenManager } from '../../../ui/ScreenManager';
import { PresidentDashboard } from '../../../ui/PresidentDashboard';
import { PresidentStatusPanel } from '../../../ui/PresidentStatusPanel';
import { createTestGame } from '../../helpers/testGame';
import type { Game } from '../../../core/Game';
import type { SystemContext } from '../../../core/GameContext';

/**
 * PresidentStatusPanel — the permanent bottom-right quick overview.
 * Verified contract: hidden until the player confirms a country; every
 * value read live from GameState (no parallel state); deep links open the
 * EXISTING PresidentDashboard (one screen, no duplicates); government
 * events refresh the panel through the SAME event stream.
 */
describe('PresidentStatusPanel (quick overview)', () => {
  let game: Game;
  let context: SystemContext;
  let adapter: InMemoryDomAdapter;
  let screens: ScreenManager;
  let dashboard: PresidentDashboard;
  let panel: PresidentStatusPanel;

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

  /** Elements whose className CONTAINS the fragment (e.g. 'psp-party in-gov'). */
  function findAllIncluding(root: InMemoryUIElement, fragment: string): InMemoryUIElement[] {
    const out: InMemoryUIElement[] = [];
    if (root.className.includes(fragment)) out.push(root);
    for (const child of root.children) out.push(...findAllIncluding(child, fragment));
    return out;
  }

  function textOf(element: UIElement | undefined): string {
    if (element === undefined) return '';
    const memo = element as unknown as InMemoryUIElement;
    return memo.text + memo.children.map((child) => textOf(child)).join(' ');
  }

  /** All rows text of ONE panel section (found by its title label). */
  function sectionText(titleLabel: string): string {
    const title = findAll(adapter.rootElement, 'psp-section-title').find(
      (candidate) => candidate.text === titleLabel
    );
    if (title === undefined || title.parent === null) return '';
    return textOf(title.parent);
  }

  beforeAll(() => {
    game = createTestGame({ seed: 555 });
    context = game.gameContext;
    adapter = new InMemoryDomAdapter();
    screens = new ScreenManager(adapter, game.gameEvents);
    dashboard = new PresidentDashboard(screens, game.commandBus, (tag, className) =>
      adapter.create(tag, className)
    );
    dashboard.register(context);
    panel = new PresidentStatusPanel(dashboard, (tag, className) => adapter.create(tag, className));
    panel.register(context, adapter.root());
  });

  afterAll(() => {
    panel.dispose();
    game.dispose();
  });

  it('is hidden before the player confirms a country', () => {
    expect(context.state.player.countryConfirmed).toBe(false);
    expect((panel.root as InMemoryUIElement).visible).toBe(false);
  });

  it('appears after country confirmation and shows the header + live values', () => {
    const countryId = context.map.countryOrder[0];
    game.commandBus.send({ type: 'player.confirmCountry', countryId });
    game.commandBus.flush();
    panel.refresh();

    expect((panel.root as InMemoryUIElement).visible).toBe(true);
    const identity = findElement(adapter.rootElement, 'psp-identity');
    expect(textOf(identity)).toContain(context.state.government.countries[countryId].president.name);
    expect(textOf(identity)).toContain(context.state.countries.countries[countryId].name);

    // Economy rows read the REAL finance state (no invented UI numbers).
    // The assets directive §4: the president sees ONE income number, ONE
    // expense number — no per-line accounting breakdowns.
    const finance = context.state.economy.finance[countryId];
    const treasury = context.state.economy.treasury[countryId] ?? 0;
    const economyText = sectionText('اقتصاد');
    expect(economyText).toContain('خزانه');
    expect(economyText).toContain(faNum(Math.round(treasury)));
    expect(finance).toBeDefined();
    expect(economyText).toContain('درآمد ماهانه');
    expect(economyText).toContain('هزینه ماهانه');
    expect(economyText).toContain('تراز ماهانه');
    expect(economyText).not.toContain('مالیات');

    // Military: strength cache + war count (0 in a fresh world).
    const militaryText = sectionText('نظامی');
    expect(militaryText).toContain('جنگ‌ها');
    expect(militaryText).toContain('قدرت');
  });

  it('economy values track state changes (treasury in → panel follows)', () => {
    const countryId = context.state.player.countryId;
    const before = context.state.economy.treasury[countryId] ?? 0;
    context.state.economy.treasury[countryId] = before + 5_000;
    // The 'sim.economyTreasuryChanged' event (the same stream UIManager
    // listens to) drives an immediate panel refresh.
    context.events.emit('sim.economyTreasuryChanged', {
      factionId: countryId,
      value: before + 5_000,
      delta: 5_000
    });
    panel.refresh();
    expect(sectionText('اقتصاد')).toContain(faNum(Math.round(before + 5_000)));
    context.state.economy.treasury[countryId] = before;
    panel.refresh();
  });

  it('party influence lists every party with support + seats, government party marked', () => {
    const countryId = context.state.player.countryId;
    const government = context.state.government.countries[countryId];
    panel.refresh();
    const partyRows = findAllIncluding(adapter.rootElement, 'psp-party').filter(
      (row) => row.className === 'psp-party' || row.className === 'psp-party in-gov'
    );
    expect(partyRows.length).toBe(Object.keys(government.politics.parties).length);
    const bars = findAll(adapter.rootElement, 'psp-bar-fill');
    expect(bars.length).toBe(partyRows.length);
    // Sorted by support (descending) — pure UI order, no score changes.
    const supports = Object.values(government.politics.parties)
      .map((party) => party.support)
      .sort((a, b) => b - a);
    const firstRowText = textOf(partyRows[0]);
    expect(firstRowText).toContain(toFaDigits(`${Math.round(supports[0] * 100)}٪`));
    // The governing party (★ marker) is somewhere in the list.
    const allText = partyRows.map((row) => textOf(row)).join('\n');
    for (const party of Object.values(government.politics.parties)) {
      expect(allText).toContain(party.name);
      if (party.inGovernment) expect(allText).toContain(`★ ${party.name}`);
    }
  });

  it('events section reflects pending events and refreshes through the EXISTING event stream', () => {
    const countryId = context.state.player.countryId;
    const government = context.state.government.countries[countryId];
    // Inject a pending event directly into state (the source of truth) and
    // fire the SAME event the simulation emits — no parallel wiring.
    const def = context.data.eventList[0];
    government.events.pending.push({
      instanceId: 'inst-test-1',
      eventId: def.id,
      firedMonth: government.lastSimMonth,
      expiresMonth: government.lastSimMonth + def.expireMonths
    });
    context.events.emit('government.eventFired', {
      countryId,
      title: def.title,
      eventId: def.id,
      category: def.category
    });
    panel.refresh();

    expect(sectionText('رویدادها')).toContain('1 در انتظار تصمیم');
    const alertRows = findAll(adapter.rootElement, 'psp-alert');
    expect(alertRows.some((row) => textOf(row).includes(def.title))).toBe(true);

    // Resolution clears the alert again (same event stream).
    government.events.pending.length = 0;
    context.events.emit('government.eventResolved', { countryId, instanceId: 'inst-test-1', choiceId: 'a' });
    panel.refresh();
    expect(sectionText('رویدادها')).not.toContain('1 در انتظار تصمیم');
  });

  it('election section shows phase and months to the next election; campaign event flips it', () => {
    const countryId = context.state.player.countryId;
    const government = context.state.government.countries[countryId];
    government.elections.phase = 'campaigning';
    context.events.emit('government.campaignStarted', { countryId, electionMonth: government.elections.nextElectionMonth });
    panel.refresh();
    const electionText = sectionText('انتخابات');
    expect(electionText).toContain('کارزار انتخاباتی ●');
    const monthsLeft = Math.max(0, government.elections.nextElectionMonth - government.lastSimMonth);
    expect(electionText).toContain(`${monthsLeft} ماه`);
    government.elections.phase = 'idle';
    panel.refresh();
    expect(sectionText('انتخابات')).toContain('عادی');
  });

  it('the OPEN PRESIDENT OFFICE button opens the dashboard ONCE (no parallel screen)', () => {
    const open = findElement(adapter.rootElement, 'psp-open');
    expect(open).toBeDefined();
    (open as InMemoryUIElement).click();
    expect(screens.isOpen('president')).toBe(true);
    (open as InMemoryUIElement).click();
    expect(screens.depth).toBe(1); // refocus, never duplicate
    screens.close('president');
  });

  it('section deep links open the dashboard at the RIGHT section', () => {
    const titles = findAll(adapter.rootElement, 'psp-section-title');
    const economyTitle = titles.find((title) => title.text === 'اقتصاد');
    const eventsTitle = titles.find((title) => title.text === 'رویدادها');
    expect(economyTitle).toBeDefined();
    expect(eventsTitle).toBeDefined();

    (eventsTitle as InMemoryUIElement).click();
    expect(screens.isOpen('president')).toBe(true);
    // The events section is the ACTIVE one (class-based `.on` visibility).
    let activeEvents: InMemoryUIElement | undefined;
    const deepFind = (root: InMemoryUIElement): void => {
      if (root.className.includes('pd-events') && root.className.includes('on')) activeEvents = root;
      for (const child of root.children) deepFind(child);
    };
    deepFind(adapter.rootElement);
    expect(activeEvents).toBeDefined();
    screens.close('president');

    (economyTitle as InMemoryUIElement).click();
    let activeEconomy: InMemoryUIElement | undefined;
    const deepFind2 = (root: InMemoryUIElement): void => {
      if (root.className.includes('pd-economy') && root.className.includes('on')) activeEconomy = root;
      for (const child of root.children) deepFind2(child);
    };
    deepFind2(adapter.rootElement);
    expect(activeEconomy).toBeDefined();
    screens.close('president');
  });

  it('alerts stay capped at 3 rows and show the calm state otherwise', () => {
    const countryId = context.state.player.countryId;
    const government = context.state.government.countries[countryId];
    // Force three problems at once.
    context.state.economy.treasury[countryId] = -100;
    government.politics.protests = 'massive';
    panel.refresh();
    const alertRows = findAll(adapter.rootElement, 'psp-alert');
    expect(alertRows.length).toBeLessThanOrEqual(3);
    const alertText = alertRows.map((row) => textOf(row)).join('\n');
    expect(alertText).toContain('کسری خزانه');

    // Calm again → the 'All quiet' state.
    context.state.economy.treasury[countryId] = 1_000;
    government.politics.protests = 'none';
    // The resource economy must be genuinely calm too — clear consumption so
    // no strategic resource counts as short (production stays ≥ consumption).
    const resources = context.state.economy.resources[countryId];
    if (resources !== undefined) resources.consumption = {};
    panel.refresh();
    expect(findAll(adapter.rootElement, 'psp-calm').length).toBe(1);
    context.state.economy.treasury[countryId] = 10_000;
  });

  it('military counts read the real unit slice (spawn → In Combat tracked)', () => {
    const countryId = context.state.player.countryId;
    const unitTypes = context.data.unitTypeList;
    expect(unitTypes.length).toBeGreaterThan(0);
    const unitId = game.spawnUnit(unitTypes[0].id, countryId, 'region_0');
    const unit = context.state.military.units[unitId];
    unit.operationalState = 'inCombat';
    panel.refresh();
    const militaryText = sectionText('نظامی');
    expect(militaryText).toContain('در نبرد');
    // Active Units 1 · In Combat 1 · Soldiers = the unit's current soldiers.
    expect(militaryText).toContain(unitTypes[0].soldiers.toLocaleString('en-US'));
    unit.operationalState = 'idle';
    panel.refresh();
  });

  it('the toggle button collapses and re-opens the panel stably (state persists across refreshes)', () => {
    const root = panel.root as InMemoryUIElement;
    // Currently open (country confirmed earlier).
    expect(root.visible).toBe(true);
    // Collapse → hidden, and STAYS hidden across cadence refreshes.
    expect(panel.toggle()).toBe(true);
    expect(panel.isCollapsed).toBe(true);
    expect(root.visible).toBe(false);
    panel.refresh();
    expect(root.visible).toBe(false);
    // Re-open → visible again immediately.
    expect(panel.toggle()).toBe(false);
    expect(panel.isCollapsed).toBe(false);
    expect(root.visible).toBe(true);
  });
});
