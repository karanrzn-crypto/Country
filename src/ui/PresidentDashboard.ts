import type { CommandBus } from '../core/CommandBus';
import type { SystemContext } from '../core/GameContext';
import type { UIElement } from './adapter/UIDomAdapter';
import type { ScreenManager } from './ScreenManager';
import type { GameCommand } from '../core/CommandTypes';
import type { EffectDef, GovernmentCountryState, OpinionTopic, SpendingCategory, TaxCategory } from '../government/types';
import { OPINION_TOPICS, SPENDING_CATEGORIES, TAX_CATEGORIES } from '../government/types';
import { decisionBlockReason } from '../government/DecisionEngine';
import { networkSummary } from '../world/cityareas/CityAreaPathfinding';
import { resourceDisplayStatusOf, resourceRawBalanceOf, type ResourceDisplayStatus } from '../economy/resources';
import { buyerDemandTiersOf, sellerPriceTiersOf, spareSurplusOf, type TradeTier } from '../economy/market';

/**
 * President Dashboard (Phase 2) — the head-of-state command center.
 * All player-facing text is PERSIAN; ids stay technical.
 *
 * Sections (per spec 2.10): نمای کلی · اقتصاد · بودجه · سیاست ·
 * دولت (وزارتخانه‌ها) · تصمیم‌ها · رویدادها · افکار عمومی · انتخابات.
 *
 * The UI owns NO simulation state: every value is read from GameState at
 * refresh time, every action goes out as a command (tax/spending/decision/
 * event/ministry). The skeleton is built once per open; dynamic lists
 * (decisions, events, ministries, results) are rebuilt by removing stale
 * elements. Each section keeps its OWN dynamic list so the monthly refresh
 * pass never removes another section's fresh rows.
 */

export type SectionId =
  | 'overview'
  | 'economy'
  | 'budget'
  | 'politics'
  | 'government'
  | 'decisions'
  | 'events'
  | 'opinion'
  | 'elections';

const SECTION_LABELS: Readonly<Record<SectionId, string>> = {
  overview: 'نمای کلی',
  economy: 'اقتصاد',
  budget: 'بودجه',
  politics: 'سیاست',
  government: 'دولت',
  decisions: 'تصمیم‌ها',
  events: 'رویدادها',
  opinion: 'افکار عمومی',
  elections: 'انتخابات'
};

const TAB_ORDER: readonly SectionId[] = [
  'overview',
  'economy',
  'budget',
  'politics',
  'government',
  'decisions',
  'events',
  'opinion',
  'elections'
];

const TOPIC_LABELS: Readonly<Record<OpinionTopic, string>> = {
  economy: 'اقتصاد',
  taxes: 'مالیات‌ها',
  services: 'خدمات عمومی',
  corruption: 'فساد',
  security: 'امنیت'
};

const SECTOR_LABELS: Readonly<Record<string, string>> = {
  agriculture: 'کشاورزی',
  industry: 'صنعت',
  energy: 'انرژی',
  mining: 'معدن',
  technology: 'فناوری',
  construction: 'ساخت‌وساز',
  services: 'خدمات',
  trade: 'بازرگانی'
};

/** Budget stepper rows: technical category ids → Persian display labels. */
const TAX_LABELS: Readonly<Record<TaxCategory, string>> = {
  income: 'مالیات بر درآمد',
  corporate: 'مالیات شرکتی',
  trade: 'عوارض تجاری'
};

const SPENDING_LABELS: Readonly<Record<SpendingCategory, string>> = {
  military: 'نظامی',
  healthcare: 'بهداشت',
  education: 'آموزش',
  infrastructure: 'زیرساخت',
  welfare: 'رفاه',
  government: 'ادارهٔ کشور',
  other: 'سایر'
};

/** Effect-target metric ids → Persian labels (unknown ids pass through). */
const TARGET_LABELS: Readonly<Record<string, string>> = {
  approval: 'محبوبیت',
  corruption: 'فساد',
  executiveAuthority: 'اقتدار اجرایی',
  gdpGrowth: 'رشد اقتصادی',
  inflation: 'تورم',
  militaryPower: 'قدرت نظامی',
  politicalSupport: 'حمایت سیاسی',
  protestPressure: 'فشار اعتراض',
  publicTrust: 'اعتماد عمومی',
  stability: 'ثبات',
  strikePressure: 'فشار اعتصاب',
  treasury: 'خزانه',
  unemployment: 'بیکاری'
};

/** Decision block-reason ids → Persian labels. */
const BLOCK_REASON_LABELS: Readonly<Record<string, string>> = {
  'no-country': 'کشوری انتخاب نشده است',
  cooldown: 'در دورهٔ انتظار تصمیم قبلی',
  preconditions: 'پیش‌شرط‌ها برقرار نیست',
  treasury: 'خزانه به اندازهٔ کافی پر نیست'
};

const PROTEST_LABELS: Readonly<Record<string, string>> = {
  none: 'هیچ',
  minor: 'جزئی',
  significant: 'قابل توجه',
  massive: 'گسترده'
};

/** Resource display status → Persian label + CSS status class (color-coded).
 *  Exactly THREE user-facing statuses (spec): مازاد / متعادل / کمبود —
 *  derived from the real production/consumption/imports, never hand-set. */
const RESOURCE_STATUS: Readonly<Record<ResourceDisplayStatus, { label: string; css: string }>> = {
  surplus: { label: 'مازاد', css: 'st-surplus' },
  balanced: { label: 'متعادل', css: 'st-balanced' },
  shortage: { label: 'کمبود', css: 'st-shortage' }
};

/** Seller price tier → Persian label (spec §8: Low/Medium/High, no dollars). */
const PRICE_TIER_LABELS: Readonly<Record<TradeTier, string>> = {
  low: 'ارزان',
  medium: 'متوسط',
  high: 'گران'
};

/** Buyer demand tier → Persian label (spec §6: eager buyers pay more). */
const DEMAND_TIER_LABELS: Readonly<Record<TradeTier, string>> = {
  low: 'کم',
  medium: 'متوسط',
  high: 'زیاد'
};

export class PresidentDashboard {
  private context: SystemContext | null = null;
  private readonly tabButtons = new Map<SectionId, UIElement>();
  private readonly sections = new Map<SectionId, UIElement>();
  private readonly dynamic = new Map<string, UIElement[]>();
  private readonly rows = new Map<string, UIElement>();
  /** Section the NEXT build should show (set by openAt before screens.open). */
  private requestedSection: SectionId | null = null;

  constructor(
    private readonly screens: ScreenManager,
    private readonly commands: CommandBus,
    private readonly create: (tag: string, className?: string) => UIElement
  ) {}

  register(context: SystemContext): void {
    this.context = context;
    this.screens.registerScreen('president', (container) => this.build(container));
  }

  /**
   * Opens the dashboard DIRECTLY at one section (deep link for the status
   * panel and future entries). When the screen is already open it just
   * switches the section — the ScreenManager refocuses the stack instead of
   * duplicating anything (one screen, no parallel state).
   */
  openAt(section: SectionId): void {
    if (this.screens.isOpen('president')) {
      this.showSection(section);
      this.refresh();
      return;
    }
    this.requestedSection = section;
    this.screens.open('president');
  }

  /** Refresh when open (called on a cadence + after government events). */
  refresh(): void {
    if (this.context === null || !this.screens.isOpen('president')) return;
    const countryId = this.context.state.player.countryId;
    const government = this.context.state.government.countries[countryId];
    if (government === undefined) return;
    const month = government.lastSimMonth;

    this.refreshOverview(countryId, month);
    this.refreshEconomy(countryId);
    this.refreshBudget(countryId);
    this.refreshPolitics(countryId);
    this.refreshGovernment(countryId);
    this.refreshDecisions(countryId, month);
    this.refreshEvents(countryId);
    this.refreshOpinion(countryId);
    this.refreshElections(countryId);
  }

  // ———————————————————————————————————————————————————————————— skeleton ——

  private build(container: UIElement): void {
    container.setClass('screen president-dashboard');

    const header = this.create('div', 'pd-header');
    const title = this.create('h2');
    title.setText('دفتر رئیس‌جمهور');
    header.appendChild(title);
    const closeButton = this.create('button', 'pd-close');
    closeButton.setText('بستن');
    closeButton.onClick(() => this.send({ type: 'ui.closeScreen', screenId: 'president' }));
    header.appendChild(closeButton);
    container.appendChild(header);

    const tabs = this.create('div', 'pd-tabs');
    for (const section of TAB_ORDER) {
      const button = this.create('button', 'pd-tab');
      button.setText(SECTION_LABELS[section]);
      const target = section;
      button.onClick(() => this.showSection(target));
      tabs.appendChild(button);
      this.tabButtons.set(section, button);
    }
    container.appendChild(tabs);

    const body = this.create('div', 'pd-body');
    container.appendChild(body);

    this.sections.set('overview', this.buildOverview(body));
    this.sections.set('economy', this.buildEconomy(body));
    this.sections.set('budget', this.buildBudget(body));
    this.sections.set('politics', this.buildPolitics(body));
    this.sections.set('government', this.buildGovernment(body));
    this.sections.set('decisions', this.buildDecisions(body));
    this.sections.set('events', this.buildEvents(body));
    this.sections.set('opinion', this.buildOpinion(body));
    this.sections.set('elections', this.buildElections(body));

    // Consume the deep-link request (openAt), default to Overview.
    const initial = this.requestedSection ?? 'overview';
    this.requestedSection = null;
    this.showSection(initial);
    this.refresh();
  }

  private section(container: UIElement, className: string): UIElement {
    const element = this.create('div', `pd-section ${className}`);
    container.appendChild(element);
    return element;
  }

  private buildOverview(container: UIElement): UIElement {
    const section = this.section(container, 'pd-overview');
    this.addRows(section, ['رئیس‌جمهور', 'حزب', 'دورهٔ ریاست', 'محبوبیت', 'حمایت سیاسی', 'اقتدار اجرایی', 'اعتماد عمومی', 'فساد', 'اعتراض‌ها', 'شبکهٔ شهری'], 'overview.');
    return section;
  }

  private buildEconomy(container: UIElement): UIElement {
    const section = this.section(container, 'pd-economy');
    // Financial summary — EXACTLY four rows (spec): خزانه · درآمد · هزینه ·
    // رشد اقتصاد. GDP/inflation/unemployment/debt/trade stay in the
    // GameState (never deleted) — they are just not shown on THIS page.
    this.addRows(section, ['💰 خزانه', '📈 درآمد', '💸 هزینه', '📊 رشد اقتصاد'], 'economy.');
    // Resources — the RESOURCE-CENTRIC core of the page (spec §2/§9):
    // production · consumption · surplus/shortage per resource + its
    // import/export action. NO sectors, NO jobs, NO productivity, NO money
    // per resource — the sector data stays in the simulation, the page
    // answers only: چه دارم؟ چه کم دارم؟ چه اضافه دارم؟
    const resourcesTitle = this.create('div', 'pd-subtitle');
    resourcesTitle.setText('منابع');
    section.appendChild(resourcesTitle);
    const resourcesList = this.create('div', 'pd-resources');
    section.appendChild(resourcesList);
    this.track(resourcesList, 'resources');
    // Imports — ONLY the resources the country is short of; when importing,
    // the SELLER market (country · available · price tier — pick a seller).
    const importsTitle = this.create('div', 'pd-subtitle');
    importsTitle.setText('واردات');
    section.appendChild(importsTitle);
    const importsList = this.create('div', 'pd-trades');
    section.appendChild(importsList);
    this.track(importsList, 'imports');
    // Exports — ONLY the resources with a surplus; the BUYER market
    // (country · need · demand tier) for every surplus resource.
    const exportsTitle = this.create('div', 'pd-subtitle');
    exportsTitle.setText('صادرات');
    section.appendChild(exportsTitle);
    const exportsList = this.create('div', 'pd-trades');
    section.appendChild(exportsList);
    this.track(exportsList, 'exports');
    return section;
  }

  private buildBudget(container: UIElement): UIElement {
    const section = this.section(container, 'pd-budget');

    const taxTitle = this.create('div', 'pd-subtitle');
    taxTitle.setText('نرخ مالیات‌ها');
    section.appendChild(taxTitle);
    for (const category of TAX_CATEGORIES) {
      section.appendChild(this.buildStepperRow(TAX_LABELS[category], 'tax', category, 0.01));
    }

    const spendTitle = this.create('div', 'pd-subtitle');
    spendTitle.setText('هزینه‌ها — سهم سالانه از تولید ناخالص');
    section.appendChild(spendTitle);
    for (const category of SPENDING_CATEGORIES) {
      section.appendChild(this.buildStepperRow(SPENDING_LABELS[category], 'spending', category, 0.005));
    }
    return section;
  }

  private buildPolitics(container: UIElement): UIElement {
    const section = this.section(container, 'pd-politics');
    this.addRows(section, ['دولت', 'کرسی‌های پارلمان', 'اعتراض‌ها', 'اعتصاب‌ها'], 'politics.');
    const partiesTitle = this.create('div', 'pd-subtitle');
    partiesTitle.setText('احزاب — حمایت · کرسی · نقش');
    section.appendChild(partiesTitle);
    const parties = this.create('div', 'pd-parties');
    section.appendChild(parties);
    this.track(parties, 'parties');
    return section;
  }

  private buildGovernment(container: UIElement): UIElement {
    const section = this.section(container, 'pd-government');
    const title = this.create('div', 'pd-subtitle');
    title.setText('وزارتخانه‌ها — بودجه، کارایی می‌سازد');
    section.appendChild(title);
    const list = this.create('div', 'pd-ministries');
    section.appendChild(list);
    this.track(list, 'ministries');
    return section;
  }

  private buildDecisions(container: UIElement): UIElement {
    const section = this.section(container, 'pd-decisions');
    const title = this.create('div', 'pd-subtitle');
    title.setText('تصمیم‌های ریاست‌جمهوری — فهرست داده‌محور');
    section.appendChild(title);
    const list = this.create('div', 'pd-decision-list');
    section.appendChild(list);
    this.track(list, 'decisions');
    return section;
  }

  private buildEvents(container: UIElement): UIElement {
    const section = this.section(container, 'pd-events');
    const title = this.create('div', 'pd-subtitle');
    title.setText('رویدادهای در انتظار — انتخاب شما سرنوشت را می‌سازد');
    section.appendChild(title);
    const list = this.create('div', 'pd-event-list');
    section.appendChild(list);
    this.track(list, 'events');
    return section;
  }

  private buildOpinion(container: UIElement): UIElement {
    const section = this.section(container, 'pd-opinion');
    const title = this.create('div', 'pd-subtitle');
    title.setText('افکار عمومی — نظر کشور دربارهٔ چه می‌گذرد');
    section.appendChild(title);
    this.addRows(section, OPINION_TOPICS.map((topic) => TOPIC_LABELS[topic]), 'opinion.');
    return section;
  }

  private buildElections(container: UIElement): UIElement {
    const section = this.section(container, 'pd-elections');
    this.addRows(section, ['وضعیت', 'انتخابات بعدی', 'انتخابات گذشته', 'برنده', 'حمایت از حزب شما'], 'elections.');
    const results = this.create('div', 'pd-election-results');
    section.appendChild(results);
    this.track(results, 'results');
    return section;
  }

  /** A labeled row with −/+ steppers wired to a budget command. */
  private buildStepperRow(label: string, kind: 'tax' | 'spending', category: string, step: number): UIElement {
    const row = this.create('div', 'pd-stepper');
    const rowLabel = this.create('span', 'pd-stepper-label');
    rowLabel.setText(label);
    const value = this.create('span', 'pd-stepper-value');
    row.appendChild(rowLabel);
    row.appendChild(value);
    const minus = this.create('button', 'pd-step-btn');
    minus.setText('−');
    const plus = this.create('button', 'pd-step-btn');
    plus.setText('+');
    row.appendChild(minus);
    row.appendChild(plus);
    this.rows.set(`budget.${kind}.${category}`, value);

    const countryId = this.context?.state.player.countryId ?? '';
    minus.onClick(() => this.stepBudget(countryId, kind, category, -step));
    plus.onClick(() => this.stepBudget(countryId, kind, category, +step));
    return row;
  }

  // ——————————————————————————————————————————————————————————— refreshes ——

  private refreshOverview(countryId: string, month: number): void {
    const government = this.context?.state.government.countries[countryId];
    if (government === undefined) return;
    const summary = networkSummary(this.context?.state.cityAreas.network ?? { areas: {}, links: {} }, countryId);
    const termMonthsLeft = Math.max(0, government.president.termEndMonth - month);

    this.rows.get('overview.رئیس‌جمهور')?.setText(government.president.name);
    this.rows.get('overview.حزب')?.setText(partyName(government, government.president.partyId));
    this.rows.get('overview.دورهٔ ریاست')?.setText(`${Math.floor(termMonthsLeft / 12)} سال و ${termMonthsLeft % 12} ماه مانده · دورهٔ ${government.president.termsServed}`);
    this.rows.get('overview.محبوبیت')?.setText(percent(government.president.approval));
    this.rows.get('overview.حمایت سیاسی')?.setText(percent(government.president.politicalSupport));
    this.rows.get('overview.اقتدار اجرایی')?.setText(percent(government.president.executiveAuthority));
    this.rows.get('overview.اعتماد عمومی')?.setText(percent(government.politics.publicTrust));
    this.rows.get('overview.فساد')?.setText(percent(government.politics.corruption));
    this.rows.get('overview.اعتراض‌ها')?.setText(`${PROTEST_LABELS[government.politics.protests] ?? government.politics.protests} (فشار ${percent(government.politics.protestPressure)})`);
    this.rows.get('overview.شبکهٔ شهری')?.setText(`${summary.areas} ناحیه · ${summary.links} پیوند · اتصال ${percent(summary.connectivity)}`);
  }

  private refreshEconomy(countryId: string): void {
    const context = this.context;
    const macro = context?.state.economy.macro[countryId];
    if (context === undefined || context === null || macro === undefined) return;
    const treasury = context.state.economy.treasury[countryId] ?? 0;
    // Exactly the four financial rows (macro GDP/inflation/debt/… remain in
    // state — a future Statistics section can show them).
    this.rows.get('economy.💰 خزانه')?.setText(money(treasury));
    this.rows.get('economy.📈 درآمد')?.setText(`${money(macro.lastRevenue)} / ماه`);
    this.rows.get('economy.💸 هزینه')?.setText(`${money(macro.lastSpending)} / ماه`);
    this.rows.get('economy.📊 رشد اقتصاد')?.setText(percentSigned(macro.gdpGrowth));
    this.rebuildResources(countryId);
    this.rebuildTrades(countryId);
  }

  /**
   * The resource cards (spec §9 — resource-centric, no money):
   *   name · تولید · مصرف · مازاد: N | کمبود: N | متعادل + the resource's
   *   own [واردات]/[صادرات] action. Balance = Production − Consumption
   *   (raw — trade never distorts it); the STATUS is derived (a shortage
   *   fully covered by imports reads متعادل).
   */
  private rebuildResources(countryId: string): void {
    const context = this.context;
    if (context === undefined || context === null) return;
    const config = context.data.economyData.strategicResources;
    const record = context.state.economy.resources[countryId];
    this.rebuild('resources', this.parents.get('resources'), () => {
      const rows: UIElement[] = [];
      if (record === undefined) return rows;
      for (const resource of config.resources) {
        const resourceId = resource.id;
        const production = record.production[resourceId] ?? 0;
        const consumption = record.consumption[resourceId] ?? 0;
        const status = resourceDisplayStatusOf(record, resourceId);
        const balance = resourceRawBalanceOf(record, resourceId);
        const statusInfo = RESOURCE_STATUS[status];

        // The status line: مازاد: N / کمبود: N / متعادل (no number).
        const statusLine =
          status === 'surplus'
            ? `مازاد: ${units(balance)}`
            : status === 'shortage'
              ? `کمبود: ${units(Math.abs(balance))}`
              : 'متعادل';

        const card = this.create('div', `pd-resource ${statusInfo.css}`);
        const head = this.create('div', 'pd-resource-head');
        const name = this.create('span', 'pd-resource-name');
        name.setText(resource.name);
        head.appendChild(name);
        // The resource's own trade action (surplus → export, shortage →
        // import) — the SAME policy commands as before, just moved onto
        // the card (spec §9's [Import]/[Export]).
        if (status === 'surplus' || status === 'shortage') {
          const exporting = status === 'surplus';
          const active = exporting
            ? record.exportPolicy[resourceId] === true
            : record.importPolicy[resourceId] === true;
          const button = this.create('button', active ? 'pd-resource-btn on' : 'pd-resource-btn');
          button.setText(
            exporting
              ? (active ? 'توقف صادرات' : 'صادرات')
              : (active ? 'توقف واردات' : 'واردات')
          );
          button.onClick(() =>
            this.send({ type: exporting ? 'economy.setExportPolicy' : 'economy.setImportPolicy', countryId, resourceId, active: !active })
          );
          head.appendChild(button);
        }
        card.appendChild(head);

        for (const line of [
          `تولید: ${units(production)}`,
          `مصرف: ${units(consumption)}`
        ]) {
          const detail = this.create('div', 'pd-resource-detail');
          detail.setText(line);
          card.appendChild(detail);
        }
        const statusElement = this.create('div', `pd-resource-statusline ${statusInfo.css}`);
        statusElement.setText(statusLine);
        card.appendChild(statusElement);
        rows.push(card);
      }
      return rows;
    });
  }

  /**
   * The two trade sections (spec §5/§6/§8 — resource-centric, NO dollars):
   *  - Imports lists ONLY short resources. While importing, each shows the
   *    SELLER market — country · available · price tier (cheap sellers hold
   *    more surplus) — and the player can PICK the seller (click pins, click
   *    again → automatic). Without import the row reads «واردات خاموش».
   *  - Exports lists ONLY surplus resources with the BUYER market —
   *    country · need · demand tier (eager buyers pay more).
   *  No shortage → «نیاز به واردات نیست»; no surplus → «مازادی برای
   *  صادرات نیست».
   */
  private rebuildTrades(countryId: string): void {
    const context = this.context;
    if (context === undefined || context === null) return;
    const config = context.data.economyData.strategicResources;
    const state = context.state;
    const record = state.economy.resources[countryId];
    const countryName = (id: string): string => state.countries.countries[id]?.name ?? id;
    const otherCountryIds = Object.keys(state.economy.resources).filter((id) => id !== countryId);

    this.rebuild('imports', this.parents.get('imports'), () => {
      const rows: UIElement[] = [];
      if (record !== undefined) {
        for (const resource of config.resources) {
          const resourceId = resource.id;
          if (resourceRawBalanceOf(record, resourceId) >= 0) continue; // not short
          const importing = record.importPolicy[resourceId] === true;
          const block = this.create('div', 'pd-trade');
          const head = this.create('div', 'pd-trade-head');
          const nameElement = this.create('span', 'pd-trade-name');
          nameElement.setText(resource.name);
          head.appendChild(nameElement);
          const hint = this.create('span', 'pd-trade-hint');
          hint.setText(importing ? `${units(record.imports[resourceId] ?? 0)} / ماه` : 'واردات خاموش');
          head.appendChild(hint);
          block.appendChild(head);

          if (importing) {
            // The seller market: every other country with spare surplus.
            const tiers = sellerPriceTiersOf(state.economy.resources, otherCountryIds, resourceId);
            const sellers = Object.entries(tiers)
              .map(([sellerId, tier]) => ({
                sellerId,
                tier,
                spare: spareSurplusOf(state.economy.resources[sellerId]!, resourceId)
              }))
              .sort((a, b) => b.spare - a.spare || countryName(a.sellerId).localeCompare(countryName(b.sellerId)));
            if (sellers.length === 0) {
              const empty = this.create('div', 'pd-trade-empty');
              empty.setText('فروشنده‌ای در بازار نیست');
              block.appendChild(empty);
            } else {
              const activeSupplier = record.suppliers[resourceId] ?? null;
              const pinned = record.preferredSuppliers?.[resourceId] ?? null;
              for (const seller of sellers) {
                const isActive = seller.sellerId === activeSupplier;
                const row = this.create('div', isActive ? 'pd-seller on' : 'pd-seller');
                row.setText(
                  `${countryName(seller.sellerId)} — موجود ${units(seller.spare)} · قیمت ${PRICE_TIER_LABELS[seller.tier]}` +
                    (isActive ? (pinned === seller.sellerId ? ' · انتخاب شما' : ' · انتخاب بازار') : '')
                );
                // Click a seller → buy from THERE (pin). Click the pinned
                // one again → back to automatic market choice.
                const target = pinned === seller.sellerId ? null : seller.sellerId;
                row.onClick(() => this.send({ type: 'economy.setSupplier', countryId, resourceId, supplierId: target }));
                block.appendChild(row);
              }
            }
          }
          rows.push(block);
        }
      }
      if (rows.length === 0) {
        const empty = this.create('div', 'pd-trade-empty');
        empty.setText('نیاز به واردات نیست');
        rows.push(empty);
      }
      return rows;
    });

    this.rebuild('exports', this.parents.get('exports'), () => {
      const rows: UIElement[] = [];
      if (record !== undefined) {
        for (const resource of config.resources) {
          const resourceId = resource.id;
          if (resourceRawBalanceOf(record, resourceId) <= 0) continue; // no surplus
          const exporting = record.exportPolicy[resourceId] === true;
          const block = this.create('div', 'pd-trade');
          const head = this.create('div', 'pd-trade-head');
          const nameElement = this.create('span', 'pd-trade-name');
          nameElement.setText(resource.name);
          head.appendChild(nameElement);
          const hint = this.create('span', 'pd-trade-hint');
          hint.setText(exporting ? `${units(record.exports[resourceId] ?? 0)} / ماه` : 'صادرات خاموش');
          head.appendChild(hint);
          block.appendChild(head);

          // The buyer market: every other country short of this resource.
          const demands = buyerDemandTiersOf(state.economy.resources, otherCountryIds, resourceId);
          const buyers = Object.entries(demands)
            .map(([buyerId, demand]) => ({ buyerId, ...demand }))
            .sort((a, b) => b.need - a.need || countryName(a.buyerId).localeCompare(countryName(b.buyerId)));
          if (buyers.length === 0) {
            const empty = this.create('div', 'pd-trade-empty');
            empty.setText('خریداری در بازار نیست');
            block.appendChild(empty);
          } else {
            for (const buyer of buyers) {
              const row = this.create('div', 'pd-buyer');
              row.setText(`${countryName(buyer.buyerId)} — نیاز ${units(buyer.need)} · تقاضا ${DEMAND_TIER_LABELS[buyer.tier]}`);
              block.appendChild(row);
            }
          }
          rows.push(block);
        }
      }
      if (rows.length === 0) {
        const empty = this.create('div', 'pd-trade-empty');
        empty.setText('مازادی برای صادرات نیست');
        rows.push(empty);
      }
      return rows;
    });
  }

  private refreshBudget(countryId: string): void {
    const government = this.context?.state.government.countries[countryId];
    if (government === undefined) return;
    for (const category of TAX_CATEGORIES) {
      this.rows.get(`budget.tax.${category}`)?.setText(percent(government.budget.taxRates[category]));
    }
    for (const category of SPENDING_CATEGORIES) {
      this.rows.get(`budget.spending.${category}`)?.setText(percent(government.budget.spendingShares[category]));
    }
  }

  private refreshPolitics(countryId: string): void {
    const government = this.context?.state.government.countries[countryId];
    if (government === undefined) return;
    const coalitionNames = government.politics.coalition.map((partyId) => partyName(government, partyId)).join(' + ');
    this.rows.get('politics.دولت')?.setText(coalitionNames || 'دولت موقت');
    const seats = government.politics.parliament.seats;
    const seatSummary = Object.keys(seats).length
      ? Object.entries(seats).map(([partyId, count]) => `${partyName(government, partyId)}: ${count}`).join(' · ')
      : 'هنوز انتخاباتی برگزار نشده است';
    this.rows.get('politics.کرسی‌های پارلمان')?.setText(seatSummary);
    this.rows.get('politics.اعتراض‌ها')?.setText(PROTEST_LABELS[government.politics.protests] ?? government.politics.protests);
    this.rows.get('politics.اعتصاب‌ها')?.setText(
      government.politics.generalStrikeUntilMonth !== null ? `اعتصاب سراسری تا ماه ${government.politics.generalStrikeUntilMonth}` : `فشار ${percent(government.politics.strikePressure)}`
    );
    this.rebuildParties(government);
  }

  private rebuildParties(government: GovernmentCountryState): void {
    const container = this.parents.get('parties');
    if (container === undefined) return;
    this.rebuild('parties', container, () => {
      const rows: UIElement[] = [];
      const parties = Object.values(government.politics.parties).sort((a, b) => b.support - a.support);
      for (const party of parties) {
        const row = this.create('div', party.inGovernment ? 'pd-party in-gov' : 'pd-party');
        row.setText(
          `${party.name} — ${percent(party.support)} حمایت · ${Math.round(party.seatShare * government.politics.parliament.seatsTotal)} کرسی${party.inGovernment ? ' · در دولت' : ''}`
        );
        rows.push(row);
      }
      return rows;
    });
  }

  private refreshGovernment(countryId: string): void {
    const context = this.context;
    const government = context?.state.government.countries[countryId];
    if (context === undefined || context === null || government === undefined) return;
    this.rebuild('ministries', this.parents.get('ministries'), () => {
      const rows: UIElement[] = [];
      for (const ministryId of Object.keys(government.ministries)) {
        const ministry = government.ministries[ministryId];
        const def = context.data.ministryTemplateList.find((candidate) => candidate.id === ministryId);
        const row = this.create('div', 'pd-ministry-row');
        const label = this.create('span', 'pd-ministry-name');
        label.setText(`${def?.name ?? ministryId} — کارایی ${percent(ministry.efficiency)}`);
        const minus = this.create('button', 'pd-step-btn');
        minus.setText('−');
        const plus = this.create('button', 'pd-step-btn');
        plus.setText('+');
        const value = this.create('span', 'pd-ministry-value');
        value.setText(percent(ministry.funding));
        row.appendChild(label);
        row.appendChild(value);
        row.appendChild(minus);
        row.appendChild(plus);
        minus.onClick(() => this.send({ type: 'government.setMinistryFunding', countryId, ministryId, value: ministry.funding - 0.1 }));
        plus.onClick(() => this.send({ type: 'government.setMinistryFunding', countryId, ministryId, value: ministry.funding + 0.1 }));
        rows.push(row);
      }
      return rows;
    });
  }

  private refreshDecisions(countryId: string, month: number): void {
    const context = this.context;
    if (context === undefined || context === null) return;
    this.rebuild('decisions', this.parents.get('decisions'), () => {
      const rows: UIElement[] = [];
      for (const decision of context.data.decisionList) {
        const reason = decisionBlockReason(context.state, countryId, decision, month);
        const row = this.create('div', reason === null ? 'pd-decision ok' : 'pd-decision blocked');
        const name = this.create('div', 'pd-decision-name');
        const cost = decision.cost.treasury ?? 0;
        name.setText(`${decision.name} — هزینه ${money(cost)}${decision.durationMonths > 0 ? ` · ${decision.durationMonths} ماه` : ''}`);
        const description = this.create('div', 'pd-decision-desc');
        description.setText(`${decision.description}  اثرها: ${describeEffects(decision.effects)}`);
        row.appendChild(name);
        row.appendChild(description);
        if (reason === null) {
          const enact = this.create('button', 'pd-enact');
          enact.setText('اجرا');
          enact.onClick(() => this.send({ type: 'government.enactDecision', countryId, decisionId: decision.id }));
          row.appendChild(enact);
        } else {
          const reasonText = this.create('div', 'pd-decision-reason');
          reasonText.setText(`مسدود: ${BLOCK_REASON_LABELS[reason] ?? reason}`);
          row.appendChild(reasonText);
        }
        rows.push(row);
      }
      return rows;
    });
  }

  private refreshEvents(countryId: string): void {
    const context = this.context;
    const government = context?.state.government.countries[countryId];
    if (context === undefined || context === null || government === undefined) return;
    this.rebuild('events', this.parents.get('events'), () => {
      const rows: UIElement[] = [];
      if (government.events.pending.length === 0) {
        const empty = this.create('div', 'pd-empty');
        empty.setText('رویداد در انتظاری وجود ندارد — کشور در آرامش است.');
        rows.push(empty);
        return rows;
      }
      for (const pending of government.events.pending) {
        const def = context.data.eventList.find((candidate) => candidate.id === pending.eventId);
        if (def === undefined) continue;
        const block = this.create('div', 'pd-event');
        const title = this.create('div', 'pd-event-title');
        title.setText(`${def.title} — مهلت تا ماه ${pending.expiresMonth}`);
        const description = this.create('div', 'pd-event-desc');
        description.setText(def.description);
        block.appendChild(title);
        block.appendChild(description);
        for (const choice of def.choices) {
          const button = this.create('button', 'pd-choice');
          button.setText(`${choice.text}  [${describeEffects(choice.effects)}]`);
          const choiceId = choice.id;
          const instanceId = pending.instanceId;
          button.onClick(() => this.send({ type: 'government.resolveEvent', countryId, instanceId, choiceId }));
          block.appendChild(button);
        }
        rows.push(block);
      }
      return rows;
    });
  }

  private refreshOpinion(countryId: string): void {
    const government = this.context?.state.government.countries[countryId];
    if (government === undefined) return;
    for (const topic of OPINION_TOPICS) {
      this.rows.get('opinion.' + TOPIC_LABELS[topic])?.setText(sentiment(government.opinion.topics[topic]));
    }
  }

  private refreshElections(countryId: string): void {
    const government = this.context?.state.government.countries[countryId];
    if (government === undefined) return;
    const elections = government.elections;
    this.rows.get('elections.وضعیت')?.setText(elections.phase === 'campaigning' ? 'در حال کارزار' : 'عادی');
    this.rows.get('elections.انتخابات بعدی')?.setText(`ماه ${elections.nextElectionMonth}`);
    this.rows.get('elections.انتخابات گذشته')?.setText(elections.lastElectionMonth >= 0 ? `ماه ${elections.lastElectionMonth}` : '—');
    this.rows.get('elections.برنده')?.setText(elections.lastWinnerId !== null ? partyName(government, elections.lastWinnerId) : '—');
    this.rows.get('elections.حمایت از حزب شما')?.setText(percent(government.politics.parties[government.president.partyId]?.support ?? 0));

    this.rebuild('results', this.parents.get('results'), () => {
      const rows: UIElement[] = [];
      if (elections.lastResults !== null) {
        for (const [partyId, share] of Object.entries(elections.lastResults)) {
          const row = this.create('div', 'pd-result-row');
          const party = government.politics.parties[partyId];
          const seats = Math.round((party?.seatShare ?? 0) * government.politics.parliament.seatsTotal);
          row.setText(`${partyName(government, partyId)}: ${percent(share)} · ${seats} کرسی`);
          rows.push(row);
        }
      }
      return rows;
    });
  }

  // ————————————————————————————————————————————————————————————— helpers ——

  /** Parents of dynamic lists (row containers), keyed by list id. */
  private readonly parents = new Map<string, UIElement>();

  private track(container: UIElement, id: string): void {
    this.parents.set(id, container);
    this.dynamic.set(id, []);
  }

  /** Removes stale rows of one list, builds fresh ones via `buildRows`. */
  private rebuild(id: string, container: UIElement | undefined, buildRows: () => UIElement[]): void {
    if (container === undefined) return;
    const stale = this.dynamic.get(id) ?? [];
    for (const element of stale) element.remove();
    const fresh = buildRows();
    for (const element of fresh) container.appendChild(element);
    this.dynamic.set(id, fresh);
  }

  private showSection(section: SectionId): void {
    // Class-based visibility (NOT inline display): the stylesheet keeps
    // `.pd-section { display: none }`, so an inline `display: ''` would
    // still compute to none. `.on` wins and restores the flex column.
    for (const [id, element] of this.sections) {
      element.setClass(id === section ? `pd-section on pd-${id}` : `pd-section pd-${id}`);
    }
    for (const [id, button] of this.tabButtons) button.setClass(id === section ? 'pd-tab on' : 'pd-tab');
  }

  private send(command: GameCommand): void {
    this.commands.send(command);
  }

  private stepBudget(countryId: string, kind: 'tax' | 'spending', category: string, delta: number): void {
    const government = this.context?.state.government.countries[countryId];
    if (government === undefined) return;
    if (kind === 'tax') {
      const key = category as TaxCategory;
      this.send({ type: 'government.setTaxRate', countryId, category: key, value: government.budget.taxRates[key] + delta });
    } else {
      const key = category as SpendingCategory;
      this.send({ type: 'government.setSpending', countryId, category: key, value: government.budget.spendingShares[key] + delta });
    }
  }

  private addRow(container: UIElement, key: string, label: string): void {
    const row = this.create('div', 'pd-row');
    const keyElement = this.create('span', 'pd-key');
    keyElement.setText(label);
    const valueElement = this.create('span', 'pd-value');
    row.appendChild(keyElement);
    row.appendChild(valueElement);
    container.appendChild(row);
    this.rows.set(key, valueElement);
  }

  private addRows(container: UIElement, labels: readonly string[], keyPrefix: string): void {
    for (const label of labels) this.addRow(container, keyPrefix + label, label);
  }
}

// ——————————————————————————————————————————————————————————— formatting ——

function partyName(government: GovernmentCountryState, partyId: string): string {
  return government.politics.parties[partyId]?.name ?? partyId;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}٪`;
}

function percentSigned(value: number): string {
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}٪`;
}

function money(value: number): string {
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(2)} میلیارد دلار`;
  return `${Math.round(value)} میلیون دلار`;
}

/** Resource units (whole numbers, thousands-separated). */
function units(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function sentiment(value: number): string {
  const label = value > 0.15 ? 'راضی' : value < -0.15 ? 'خشمگین' : 'میانه‌رو';
  return `${label} (${value >= 0 ? '+' : ''}${Math.round(value * 100)})`;
}

/** Effect summary: 'mul' always reads as %, money targets in Persian units,
 *  rates in %. Known metric ids get Persian labels; unknown pass through. */
function describeEffects(effects: readonly EffectDef[]): string {
  return effects
    .map((effect) => {
      const sign = effect.value >= 0 ? '+' : '−';
      const magnitude = Math.abs(effect.value);
      const duration = effect.durationMonths !== undefined && effect.durationMonths > 0 ? ` (${effect.durationMonths} ماه)` : '';
      // 'mul' is always a percentage modifier; 'add' is M$ for money/sector
      // targets and percentage points for rates (approval, growth, …).
      const targetLabel = effect.target.startsWith('sector.')
        ? (SECTOR_LABELS[effect.target.slice('sector.'.length)] ?? effect.target)
        : (TARGET_LABELS[effect.target] ?? effect.target);
      if (effect.mode === 'mul') {
        return `${targetLabel} ${sign}${(magnitude * 100).toFixed(0)}٪${duration}`;
      }
      const moneyTargets = ['treasury', 'debt'];
      const isMoney = moneyTargets.includes(effect.target) || effect.target.startsWith('sector.');
      const amount = isMoney ? `${sign}${money(magnitude)}` : `${sign}${(magnitude * 100).toFixed(1)}٪`;
      return `${targetLabel} ${amount}${duration}`;
    })
    .join(', ');
}
