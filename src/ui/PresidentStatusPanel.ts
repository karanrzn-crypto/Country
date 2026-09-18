import type { SystemContext } from '../core/GameContext';
import type { UIElement } from './adapter/UIDomAdapter';
import type { EventBus } from '../events/EventBus';
import type { PresidentDashboard, SectionId } from './PresidentDashboard';
import { activeWarsInvolving } from '../state/slices/warSlice';
import type { GovernmentCountryState } from '../government/types';
import { resourceStatusOf } from '../economy/resources';

/**
 * PresidentStatusPanel — the permanent QUICK OVERVIEW of the head of state.
 *
 * A small, always-on command center at the BOTTOM-RIGHT of the map: the
 * live vital signs (economy, military, politics, parties, government,
 * events, election, alerts) in one glance, with one-click deep links into
 * the matching PresidentDashboard section.
 *
 * Architecture contract (spec 13):
 *  - owns NO simulation state: every value is read from GameState at
 *    refresh time (the ONLY UI-session flag is `collapsed`, driven by the
 *    dedicated toggle button — open/closed stays stable across refreshes);
 *  - sends NO simulation-affecting commands: navigation goes through the
 *    existing PresidentDashboard (UI → CommandBus → Game/Core → GameState
 *    contract is untouched — the dashboard owns the actions);
 *  - connected to the EXISTING government event stream (no parallel
 *    EventBus) plus a bounded refresh cadence for non-event mutations
 *    (treasury accrual, unit movement, war changes);
 *  - NOT a Screen: registered as a plain child of the UI root, so it never
 *    covers the map and never participates in the screen stack.
 *
 * Military data source (spec 14): state.military.units / strengthCache and
 * state.war — destroyed units excluded, soldiers summed from
 * soldiersCurrent, inCombat counted separately, wars filtered to the
 * player's country. Nothing here is fabricated.
 */

/** Which dashboard section each panel section deep-links to. Data, not code:
 *  a future independent Military screen only edits this mapping. */
const SECTION_DEEPLINKS: Readonly<Record<string, SectionId>> = {
  economy: 'economy',
  // No standalone military screen exists yet — land on Overview (the
  // architecture-ready mapping makes that a one-line change later).
  military: 'overview',
  politics: 'politics',
  parties: 'politics',
  events: 'events',
  election: 'elections'
};

/** Max simultaneous alert rows (spec 8). */
const MAX_ALERTS = 3;

/** Panel refresh cadence in frames (≈2 Hz at 30 Hz — never per-frame work). */
const REFRESH_EVERY_FRAMES = 15;

/** Pre-refresh dynamic-list signature — no real signature can contain NUL,
 *  so the FIRST refresh always builds (the calm/empty state is '' too). */
const INITIAL_SIGNATURE = '\u0000';

interface PanelSection {
  body: UIElement;
  rows: Map<string, UIElement>;
}

export class PresidentStatusPanel {
  private context: SystemContext | null = null;
  private readonly sections = new Map<string, PanelSection>();
  private readonly dynamic = new Map<string, UIElement[]>();
  private readonly dynamicSignatures = new Map<string, string>();
  /**
   * UI-session visibility flag for the TOGGLE BUTTON (not simulation
   * state): the player can collapse the panel; the choice persists across
   * refreshes until they toggle it back.
   */
  private collapsed = false;
  /** The panel element (UIManager appends it to the UI root). */
  readonly root: UIElement;
  private readonly identity: UIElement;
  private readonly unsubscribes: (() => void)[] = [];
  private readonly create: (tag: string, className?: string) => UIElement;
  private lastRefreshFrame = -1_000_000;

  constructor(
    private readonly dashboard: PresidentDashboard,
    create: (tag: string, className?: string) => UIElement
  ) {
    this.create = create;
    this.root = create('div', 'psp');
    this.root.setVisible(false);

    // —— header: title + the full-office button ——
    const header = create('div', 'psp-header');
    const title = create('span', 'psp-title');
    title.setText('رئیس‌جمهور');
    header.appendChild(title);
    const open = create('button', 'psp-open');
    open.setText('دفتر رئیس‌جمهور');
    open.onClick(() => this.dashboard.openAt('overview'));
    header.appendChild(open);
    this.root.appendChild(header);

    // —— identity line: name · country · party ——
    this.identity = create('div', 'psp-identity');
    this.root.appendChild(this.identity);

    // —— fixed sections (top → bottom) ——
    // Light money (spec §10): treasury + the THREE revenue lines + the
    // budget spending + the resource summary. No GDP/inflation/unemployment.
    this.addSection('economy', 'اقتصاد', ['خزانه', 'مالیات', 'گمرک', 'صادرات', 'هزینه‌های دولت', 'تراز ماهانه', 'منابع']);
    this.addSection('military', 'نظامی', ['قدرت', 'یگان‌های فعال', 'سربازان', 'در نبرد', 'در حال حرکت', 'جنگ‌ها']);
    this.addSection('politics', 'سیاست', [
      'محبوبیت',
      'حمایت سیاسی',
      'اعتماد عمومی',
      'اقتدار اجرایی',
      'اعتراض‌ها',
      'اعتصاب‌ها',
      'دولت'
    ]);
    this.addSection('parties', 'نفوذ احزاب', [], /* dynamicList */ true);
    // No 'government' section (spec §6): the ministries keep simulating, but
    // they no longer get a dedicated panel of their own.
    this.addSection('events', 'رویدادها', ['رویدادها'], true);
    this.addSection('election', 'انتخابات', ['وضعیت', 'انتخابات بعدی', 'حمایت از حزب']);
    this.addSection('alerts', 'هشدارها', [], true);
  }

  // ———————————————————————————————————————————————————————————— wiring ——

  /** Registers into the UI root + subscribes to the EXISTING event streams. */
  register(context: SystemContext, container: UIElement): void {
    this.context = context;
    container.appendChild(this.root);
    const events: EventBus = context.events;
    this.unsubscribes.push(
      // —— Phase 2 government flow (the SAME events the dashboard uses) ——
      events.on('government.eventFired', () => this.refresh()),
      events.on('government.eventResolved', () => this.refresh()),
      events.on('government.decisionEnacted', () => this.refresh()),
      events.on('government.budgetChanged', () => this.refresh()),
      events.on('government.ministryFundingChanged', () => this.refresh()),
      events.on('government.electionHeld', () => this.refresh()),
      events.on('government.campaignStarted', () => this.refresh()),
      events.on('government.monthProcessed', ({ countryId }) => {
        if (countryId === context.state.player.countryId) this.refresh();
      }),
      // —— player / military mutations that have no monthly event ——
      events.on('player.countryConfirmed', () => this.refresh()),
      events.on('sim.economyTreasuryChanged', ({ factionId }) => {
        if (factionId === context.state.player.countryId) this.refresh();
      }),
      events.on('combat.engagementStarted', () => this.refresh())
    );
    this.refresh();
  }

  /** Bounded cadence (called from UIManager's frame update). */
  update(_context: SystemContext, frameIndex: number): void {
    if (frameIndex - this.lastRefreshFrame < REFRESH_EVERY_FRAMES) return;
    this.lastRefreshFrame = frameIndex;
    this.refresh();
  }

  /**
   * Toggle button behavior (open ⇄ close). Returns the NEW collapsed flag
   * so the button label/state can mirror it. Applies immediately — never
   * waiting for the refresh cadence — so the panel state is always
   * predictable after a click.
   */
  toggle(): boolean {
    this.collapsed = !this.collapsed;
    this.refresh();
    return this.collapsed;
  }

  /** Whether the panel is currently collapsed (button state mirror). */
  get isCollapsed(): boolean {
    return this.collapsed;
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes.length = 0;
    this.root.remove();
  }

  // ————————————————————————————————————————————————————————————— build ——

  private addSection(id: string, label: string, rows: readonly string[], hasDynamicList = false): void {
    const section = this.create('div', 'psp-section');
    const title = this.create('div', 'psp-section-title');
    title.setText(label);
    const body = this.create('div', 'psp-rows');
    section.appendChild(title);
    section.appendChild(body);
    this.root.appendChild(section);

    // Deep link into the President Office (the section title is the button).
    const deeplink = SECTION_DEEPLINKS[id];
    if (deeplink !== undefined) {
      title.setAttribute('title', 'نمایش در دفتر رئیس‌جمهور');
      const target: SectionId = deeplink;
      title.onClick(() => this.dashboard.openAt(target));
    }

    const rowMap = new Map<string, UIElement>();
    for (const rowLabel of rows) {
      const row = this.create('div', 'psp-row');
      const key = this.create('span', 'psp-key');
      key.setText(rowLabel);
      const value = this.create('span', 'psp-value');
      row.appendChild(key);
      row.appendChild(value);
      body.appendChild(row);
      rowMap.set(rowLabel, value);
    }
    if (hasDynamicList) {
      this.dynamic.set(id, []);
      this.dynamicSignatures.set(id, INITIAL_SIGNATURE);
    }
    this.sections.set(id, { body, rows: rowMap });
  }

  // ——————————————————————————————————————————————————————————— refresh ——

  refresh(): void {
    const context = this.context;
    if (context === null) return;
    const state = context.state;
    const countryId = state.player.countryId;
    const government: GovernmentCountryState | undefined =
      countryId !== '' ? state.government.countries[countryId] : undefined;
    const visible = state.player.countryConfirmed && government !== undefined && !this.collapsed;
    this.root.setVisible(visible);
    if (!visible || government === undefined) return;

    this.refreshIdentity(context, government);
    this.refreshEconomy(context, countryId);
    this.refreshMilitary(context, countryId);
    this.refreshPolitics(government);
    this.refreshParties(government);
    this.refreshEvents(context, government);
    this.refreshElection(government);
    this.refreshAlerts(context, government, countryId);
  }

  private refreshIdentity(context: SystemContext, government: GovernmentCountryState): void {
    const countryName = context.state.countries.countries[context.state.player.countryId]?.name ?? '—';
    const party = government.politics.parties[government.president.partyId]?.name ?? government.president.partyId;
    this.identity.setText(`${government.president.name} — ${countryName} · ${party}`);
  }

  private refreshEconomy(context: SystemContext, countryId: string): void {
    const economy = this.section('economy');
    if (economy === null) return;
    const finance = context.state.economy.finance[countryId];
    const treasury = context.state.economy.treasury[countryId] ?? 0;
    economy.rows.get('خزانه')?.setText(moneyM(treasury));
    if (finance !== undefined) {
      economy.rows.get('مالیات')?.setText(moneyM(finance.lastTax));
      economy.rows.get('گمرک')?.setText(moneyM(finance.lastCustoms));
      economy.rows.get('صادرات')?.setText(moneyM(finance.lastExports));
      economy.rows.get('هزینه‌های دولت')?.setText(moneyM(finance.lastSpending));
      economy.rows.get('تراز ماهانه')?.setText(`${signed(moneyM(Math.abs(finance.lastBalance)), finance.lastBalance >= 0)} ماهانه`);
    } else {
      economy.rows.get('مالیات')?.setText('—');
      economy.rows.get('گمرک')?.setText('—');
      economy.rows.get('صادرات')?.setText('—');
      economy.rows.get('هزینه‌های دولت')?.setText('—');
      economy.rows.get('تراز ماهانه')?.setText('—');
    }
    economy.rows.get('منابع')?.setText(this.resourceSummary(context, countryId));
  }

  /** Compact shortage/surplus summary of the strategic resources. */
  private resourceSummary(context: SystemContext, countryId: string): string {
    const record = context.state.economy.resources[countryId];
    if (record === undefined) return '—';
    const config = context.data.economyData.strategicResources;
    const shortages: string[] = [];
    const surpluses: string[] = [];
    for (const resource of config.resources) {
      const status = resourceStatusOf(record, resource.id);
      if (status === 'shortage') shortages.push(resource.name);
      else if (status === 'surplus' || status === 'exported') surpluses.push(resource.name);
    }
    const parts: string[] = [];
    if (shortages.length > 0) parts.push(`کمبود: ${shortages.join('، ')}`);
    if (surpluses.length > 0) parts.push(`مازاد: ${surpluses.join('، ')}`);
    return parts.length > 0 ? parts.join(' · ') : 'همه متعادل';
  }

  private refreshMilitary(context: SystemContext, countryId: string): void {
    const military = this.section('military');
    if (military === null) return;
    let active = 0;
    let soldiers = 0;
    let inCombat = 0;
    let moving = 0;
    for (const unit of Object.values(context.state.military.units)) {
      if (unit.countryId !== countryId || unit.operationalState === 'destroyed') continue;
      active += 1;
      soldiers += unit.soldiersCurrent;
      if (unit.operationalState === 'inCombat') inCombat += 1;
      if (unit.operationalState === 'moving') moving += 1;
    }
    const strength = context.state.military.strengthCache[countryId] ?? 0;
    const wars = activeWarsInvolving(context.state.war, countryId).length;
    military.rows.get('قدرت')?.setText(strength.toLocaleString('en-US'));
    military.rows.get('یگان‌های فعال')?.setText(String(active));
    military.rows.get('سربازان')?.setText(soldiers.toLocaleString('en-US'));
    military.rows.get('در نبرد')?.setText(String(inCombat));
    military.rows.get('در حال حرکت')?.setText(String(moving));
    military.rows.get('جنگ‌ها')?.setText(String(wars));
  }

  private refreshPolitics(government: GovernmentCountryState): void {
    const politics = this.section('politics');
    if (politics === null) return;
    politics.rows.get('محبوبیت')?.setText(percent(government.president.approval));
    politics.rows.get('حمایت سیاسی')?.setText(percent(government.president.politicalSupport));
    politics.rows.get('اعتماد عمومی')?.setText(percent(government.politics.publicTrust));
    politics.rows.get('اقتدار اجرایی')?.setText(percent(government.president.executiveAuthority));
    politics.rows.get('اعتراض‌ها')?.setText(protestLabel(government.politics.protests));
    politics.rows.get('اعتصاب‌ها')?.setText(
      government.politics.generalStrikeUntilMonth !== null
        ? 'اعتصاب سراسری'
        : percent(government.politics.strikePressure)
    );
    const coalition = government.politics.coalition
      .map((partyId) => government.politics.parties[partyId]?.name ?? partyId)
      .join(' + ');
    politics.rows.get('دولت')?.setText(coalition !== '' ? coalition : 'دولت موقت');
  }

  private refreshParties(government: GovernmentCountryState): void {
    const container = this.dynamic.get('parties');
    const parent = this.sectionBody('parties');
    if (container === undefined || parent === null) return;
    const parties = Object.values(government.politics.parties).sort((a, b) => b.support - a.support);
    // Rebuild ONLY on real change (support is drifted monthly, not per frame).
    const signature = parties
      .map((party) => `${party.id}:${party.support.toFixed(3)}:${party.inGovernment ? 1 : 0}`)
      .join('|');
    if (signature === this.dynamicSignatures.get('parties')) return;
    this.dynamicSignatures.set('parties', signature);
    for (const row of this.dynamic.get('parties') ?? []) row.remove();

    const fresh: UIElement[] = [];
    const seatsTotal = Math.max(1, government.politics.parliament.seatsTotal);
    for (const party of parties) {
      const row = this.create('div', party.inGovernment ? 'psp-party in-gov' : 'psp-party');
      const name = this.create('span', 'psp-party-name');
      name.setText(`${party.inGovernment ? '★ ' : ''}${party.name}`);
      const meta = this.create('span', 'psp-party-meta');
      meta.setText(`${percent(party.support)} · ${Math.round(party.seatShare * seatsTotal)} کرسی`);
      const bar = this.create('div', 'psp-bar');
      const fill = this.create('div', 'psp-bar-fill');
      fill.setAttribute('style', `width:${Math.round(party.support * 100)}%`);
      bar.appendChild(fill);
      row.appendChild(name);
      row.appendChild(meta);
      row.appendChild(bar);
      parent.appendChild(row);
      fresh.push(row);
    }
    this.dynamic.set('parties', fresh);
  }

  private refreshEvents(context: SystemContext, government: GovernmentCountryState): void {
    const section = this.section('events');
    if (section === null) return;
    const pending = government.events.pending;
    section.rows.get('رویدادها')?.setText(pending.length > 0 ? `${pending.length} در انتظار تصمیم` : 'هیچ');
    const titles = pending
      .map((instance) => context.data.eventList.find((def) => def.id === instance.eventId)?.title ?? instance.eventId)
      .slice(0, 3);
    const parent = this.sectionBody('events');
    const container = this.dynamic.get('events');
    if (parent === null || container === undefined) return;
    const signature = titles.join('|');
    if (signature === this.dynamicSignatures.get('events')) return;
    this.dynamicSignatures.set('events', signature);
    for (const row of this.dynamic.get('events') ?? []) row.remove();
    const fresh: UIElement[] = [];
    for (const title of titles) {
      const row = this.create('div', 'psp-alert');
      row.setText(`⚠ ${title}`);
      parent.appendChild(row);
      fresh.push(row);
    }
    this.dynamic.set('events', fresh);
  }

  private refreshElection(government: GovernmentCountryState): void {
    const section = this.section('election');
    if (section === null) return;
    const elections = government.elections;
    const monthsLeft = Math.max(0, elections.nextElectionMonth - government.lastSimMonth);
    section.rows.get('وضعیت')?.setText(
      elections.phase === 'campaigning' ? 'کارزار انتخاباتی ●' : 'عادی'
    );
    section.rows.get('انتخابات بعدی')?.setText(`${monthsLeft} ماه دیگر`);
    section.rows
      .get('حمایت از حزب')
      ?.setText(percent(government.politics.parties[government.president.partyId]?.support ?? 0));
  }

  private refreshAlerts(context: SystemContext, government: GovernmentCountryState, countryId: string): void {
    const parent = this.sectionBody('alerts');
    const container = this.dynamic.get('alerts');
    if (parent === null || container === undefined) return;
    const alerts: string[] = [];
    // 1. Unanswered events — the most urgent items (titles, not ids).
    for (const instance of government.events.pending) {
      if (alerts.length >= MAX_ALERTS) break;
      const def = context.data.eventList.find((candidate) => candidate.id === instance.eventId);
      alerts.push(`⚠ ${def?.title ?? instance.eventId}`);
    }
    const treasury = context.state.economy.treasury[countryId] ?? 0;
    // 2. Hard fiscal alarm.
    if (treasury < 0 && alerts.length < MAX_ALERTS) alerts.push('⚠ کسری خزانه');
    // 3. Active war involving the player's country.
    const wars = activeWarsInvolving(context.state.war, countryId).length;
    if (wars > 0 && alerts.length < MAX_ALERTS) alerts.push(`⚠ ${wars === 1 ? 'جنگ جاری' : `${wars} جنگ جاری`}`);
    // 4. Civil unrest.
    if (government.politics.generalStrikeUntilMonth !== null && alerts.length < MAX_ALERTS) {
      alerts.push('⚠ اعتصاب سراسری');
    }
    if (government.politics.protests === 'massive' && alerts.length < MAX_ALERTS) {
      alerts.push('⚠ اعتراض‌های گسترده');
    }
    // 5. Resource shortage — the first uncovered strategic resource.
    const resources = context.state.economy.resources[countryId];
    if (resources !== undefined && alerts.length < MAX_ALERTS) {
      const shortage = context.data.economyData.strategicResources.resources.find(
        (resource) => resourceStatusOf(resources, resource.id) === 'shortage'
      );
      if (shortage !== undefined) alerts.push(`⚠ کمبود ${shortage.name}`);
    }

    const signature = alerts.join('|');
    if (signature === this.dynamicSignatures.get('alerts')) return;
    this.dynamicSignatures.set('alerts', signature);
    for (const row of this.dynamic.get('alerts') ?? []) row.remove();
    const fresh: UIElement[] = [];
    if (alerts.length === 0) {
      const calm = this.create('div', 'psp-calm');
      calm.setText('آرامش کامل');
      parent.appendChild(calm);
      fresh.push(calm);
    } else {
      for (const alert of alerts) {
        const row = this.create('div', 'psp-alert');
        row.setText(alert);
        parent.appendChild(row);
        fresh.push(row);
      }
    }
    this.dynamic.set('alerts', fresh);
  }

  // ————————————————————————————————————————————————————————————— helpers ——

  private section(id: string): PanelSection | null {
    return this.sections.get(id) ?? null;
  }

  private sectionBody(id: string): UIElement | null {
    return this.sections.get(id)?.body ?? null;
  }
}

// ————————————————————————————————————————————————————————————— formatting ——

/** Money in $M (the state unit): `$24,520M`. */
function moneyM(value: number): string {
  const rounded = Math.round(value);
  return `${rounded < 0 ? '−' : ''}$${Math.abs(rounded).toLocaleString('en-US')}M`;
}

/** Prefixes a magnitude with +/− (positive strips the minus moneyM may add). */
function signed(text: string, positive: boolean): string {
  return `${positive ? '+' : '−'}${text.replace('−', '')}`;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}٪`;
}

function protestLabel(level: GovernmentCountryState['politics']['protests']): string {
  switch (level) {
    case 'none':
      return 'هیچ';
    case 'minor':
      return 'جزئی';
    case 'significant':
      return 'قابل توجه';
    case 'massive':
      return 'گسترده';
  }
}
