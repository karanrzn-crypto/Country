import type { CommandBus } from '../core/CommandBus';
import type { SystemContext } from '../core/GameContext';
import type { UIElement } from './adapter/UIDomAdapter';
import type { ScreenManager } from './ScreenManager';
import type { GameCommand } from '../core/CommandTypes';
import type { EffectDef, GovernmentCountryState, OpinionTopic, SpendingCategory, TaxCategory } from '../government/types';
import { OPINION_TOPICS, SPENDING_CATEGORIES, TAX_CATEGORIES } from '../government/types';
import { decisionBlockReason } from '../government/DecisionEngine';
import { networkSummary } from '../world/cityareas/CityAreaPathfinding';

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

const SECTOR_ORDER: readonly string[] = [
  'agriculture',
  'industry',
  'energy',
  'mining',
  'technology',
  'construction',
  'services',
  'trade'
];

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
    this.addRows(section, ['تولید ناخالص (سالانه)', 'رشد', 'تورم', 'بیکاری', 'بدهی', 'خزانه', 'درآمد ماهانه', 'هزینهٔ ماهانه', 'تراز ماهانه', 'تراز تجاری', 'جمعیت', 'نیروی کار'], 'economy.');
    const sectorTitle = this.create('div', 'pd-subtitle');
    sectorTitle.setText('بخش‌ها — تولید · شغل · بهره‌وری');
    section.appendChild(sectorTitle);
    for (const sectorId of SECTOR_ORDER) {
      this.addRow(section, `sector.${sectorId}`, SECTOR_LABELS[sectorId] ?? sectorId);
    }
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
    const macro = this.context?.state.economy.macro[countryId];
    if (macro === undefined) return;
    const treasury = this.context?.state.economy.treasury[countryId] ?? 0;
    this.rows.get('economy.تولید ناخالص (سالانه)')?.setText(money(macro.gdp));
    this.rows.get('economy.رشد')?.setText(percentSigned(macro.gdpGrowth));
    this.rows.get('economy.تورم')?.setText(percentSigned(macro.inflation));
    this.rows.get('economy.بیکاری')?.setText(percent(macro.unemployment));
    this.rows.get('economy.بدهی')?.setText(money(macro.debt));
    this.rows.get('economy.خزانه')?.setText(money(treasury));
    this.rows.get('economy.درآمد ماهانه')?.setText(money(macro.lastRevenue));
    this.rows.get('economy.هزینهٔ ماهانه')?.setText(money(macro.lastSpending));
    this.rows.get('economy.تراز ماهانه')?.setText(moneySigned(macro.lastBalance));
    this.rows.get('economy.تراز تجاری')?.setText(moneySigned(macro.trade.balance));
    this.rows.get('economy.جمعیت')?.setText(number(this.context?.state.countries.countries[countryId]?.population ?? 0));
    this.rows.get('economy.نیروی کار')?.setText(number(Math.round((this.context?.state.countries.countries[countryId]?.population ?? 0) * 0.52)));
    for (const [sectorId, sector] of Object.entries(macro.sectors)) {
      this.rows.get(`sector.${sectorId}`)?.setText(
        `${money(sector.output)} · ${number(Math.round(sector.jobs))} شغل · ${number(Math.round(sector.productivity))} دلار/سال`
      );
    }
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

function moneySigned(value: number): string {
  return `${value >= 0 ? '+' : '−'}${money(Math.abs(value))}`;
}

function sentiment(value: number): string {
  const label = value > 0.15 ? 'راضی' : value < -0.15 ? 'خشمگین' : 'میانه‌رو';
  return `${label} (${value >= 0 ? '+' : ''}${Math.round(value * 100)})`;
}

function number(value: number): string {
  return value.toLocaleString('en-US');
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
