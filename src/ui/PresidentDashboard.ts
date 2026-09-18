import type { CommandBus } from '../core/CommandBus';
import type { SystemContext } from '../core/GameContext';
import type { UIElement } from './adapter/UIDomAdapter';
import type { ScreenManager } from './ScreenManager';
import type { GameCommand } from '../core/CommandTypes';
import type { BudgetPool, EffectDef, GovernmentCountryState, OpinionTopic, TaxLevel } from '../government/types';
import { OPINION_TOPICS, TAX_LEVEL_IDS } from '../government/types';
import { decisionBlockReason } from '../government/DecisionEngine';
import { politicalPowerDistribution } from '../state/slices/governmentSlice';
import { networkSummary } from '../world/cityareas/CityAreaPathfinding';
import { resourceRawBalanceOf, realShortageOf } from '../economy/resources';
import { marketPriceTierOf, type TradeTier } from '../economy/market';
import { projectShortageOf } from '../economy/construction';
import { sellersOf, dealPriceOf } from '../economy/purchase';
import { unlockedMineLevelOf, researchCostOf } from '../economy/research';

/**
 * President Dashboard (Phase 2) — the head-of-state command center.
 * All player-facing text is PERSIAN; ids stay technical.
 *
 * Sections (final UI structure — spec §7): نمای کلی · اقتصاد · بودجه ·
 * سیاست · تصمیم‌ها · رویدادها · افکار عمومی · انتخابات.
 * (No independent Government panel — spec §6: it repeated other sections;
 * the ministry/budget systems keep running in the simulation.)
 *
 * The UI owns NO simulation state: every value is read from GameState at
 * refresh time, every action goes out as a command (tax/spending/decision/
 * event). The skeleton is built once per open; dynamic lists (decisions,
 * events, results) are rebuilt by removing stale elements. Each section
 * keeps its OWN dynamic list so the monthly refresh pass never removes
 * another section's fresh rows.
 */

export type SectionId =
  | 'overview'
  | 'economy'
  | 'research'
  | 'budget'
  | 'politics'
  | 'decisions'
  | 'events'
  | 'opinion'
  | 'elections';

const SECTION_LABELS: Readonly<Record<SectionId, string>> = {
  overview: 'نمای کلی',
  economy: 'اقتصاد',
  research: 'تحقیقات',
  budget: 'بودجه',
  politics: 'سیاست',
  decisions: 'تصمیم‌ها',
  events: 'رویدادها',
  opinion: 'افکار عمومی',
  elections: 'انتخابات'
};

const TAB_ORDER: readonly SectionId[] = [
  'overview',
  'economy',
  'research',
  'budget',
  'politics',
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

/** Effect-target metric ids → Persian labels (unknown ids pass through). */
const TARGET_LABELS: Readonly<Record<string, string>> = {
  approval: 'محبوبیت',
  corruption: 'فساد',
  executiveAuthority: 'اقتدار اجرایی',
  foodStock: 'انبار غذا',
  militaryPower: 'قدرت نظامی',
  politicalSupport: 'حمایت سیاسی',
  protestPressure: 'فشار اعتراض',
  publicTrust: 'اعتماد عمومی',
  stability: 'ثبات',
  strikePressure: 'فشار اعتصاب',
  treasury: 'خزانه'
};

/** Budget pool labels (spec §1/§6 — the TWO halves of the ONE 100% pool). */
const BUDGET_POOL_LABELS: Readonly<Record<BudgetPool, string>> = {
  economic: 'بودجهٔ اقتصادی',
  military: 'بودجهٔ نظامی'
};

/** The FOUR tax levels (spec §4/§7) — Persian names + the short effect text. */
const TAX_LEVEL_LABELS: Readonly<Record<TaxLevel, string>> = {
  low: 'کم',
  medium: 'متوسط',
  high: 'زیاد',
  max: 'حداکثر'
};

const TAX_LEVEL_EFFECTS: Readonly<Record<TaxLevel, string>> = {
  low: 'اثر مثبت — رضایت مردم و رونق اقتصادی',
  medium: 'متعادل',
  high: 'اثر منفی — نارضایتی و فشار اقتصادی',
  max: 'اثر منفی قوی — فشار سنگین بر مردم و اقتصاد'
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

/** The THREE resource status visuals (spec §8): مازاد / متعادل / کمبود —
 *  keyed by the SIGN of the balance a line describes (final balance for the
 *  card, raw balance for the initial line). Never hand-set. */
const STATUS_VISUALS = {
  surplus: { label: 'مازاد', css: 'st-surplus' },
  balanced: { label: 'متعادل', css: 'st-balanced' },
  shortage: { label: 'کمبود', css: 'st-shortage' }
} as const;

/** Fixed, deterministic party colors for the power pie ( Politics, spec §5). */
const POWER_PIE_COLORS = [
  '#4f8ef7', '#f5a623', '#3ecf8e', '#ef5b6b',
  '#a06bf5', '#2bc0c4', '#f97316', '#94a3b8'
] as const;

/** Market price tier → Persian label (spec §10: Low/Normal/High, no dollars). */
const PRICE_TIER_LABELS: Readonly<Record<TradeTier, string>> = {
  low: 'ارزان',
  medium: 'متوسط',
  high: 'گران'
};

export class PresidentDashboard {
  private context: SystemContext | null = null;
  private readonly tabButtons = new Map<SectionId, UIElement>();
  private readonly sections = new Map<SectionId, UIElement>();
  private readonly dynamic = new Map<string, UIElement[]>();
  /** Last-built signatures of signature-guarded lists (e.g. the power pie). */
  private readonly dynamicSignatures = new Map<string, string>();
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
    this.refreshResearch(countryId);
    this.refreshBudget(countryId);
    this.refreshPolitics(countryId);
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
    this.sections.set('research', this.buildResearch(body));
    this.sections.set('budget', this.buildBudget(body));
    this.sections.set('politics', this.buildPolitics(body));
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
    // The RESOURCE page (spec §18): stockpiles + production, construction
    // with its Required/Owned/Missing triad, explicit purchases from real
    // sellers, and the live import/export flows. No GDP, no inflation,
    // no unemployment, no accounting — the loop is:
    //   تولید → ذخیره → مصرف → کمبود → خرید → ساخت (spec §17).
    // Resources — the REAL stockpile + the monthly production/consumption.
    const resourcesTitle = this.create('div', 'pd-subtitle');
    resourcesTitle.setText('منابع — موجودی و تولید');
    section.appendChild(resourcesTitle);
    const resourcesList = this.create('div', 'pd-resources');
    section.appendChild(resourcesList);
    this.track(resourcesList, 'resources');
    // Construction — the buildable factories + the active projects with
    // their per-resource missing numbers (spec §4).
    const constructionTitle = this.create('div', 'pd-subtitle');
    constructionTitle.setText('ساخت‌وساز');
    section.appendChild(constructionTitle);
    const constructionList = this.create('div', 'pd-construction');
    section.appendChild(constructionList);
    this.track(constructionList, 'construction');
    // Purchases — the EXPLICIT deals (spec §5): for every short resource,
    // the countries that actually hold stock, one click per deal. Price
    // shows on the seller row; there is no "buy cheapest" system (spec §6).
    const purchaseTitle = this.create('div', 'pd-subtitle');
    purchaseTitle.setText('خرید منابع — فروشندگان موجود');
    section.appendChild(purchaseTitle);
    const purchaseList = this.create('div', 'pd-purchases');
    section.appendChild(purchaseList);
    this.track(purchaseList, 'purchases');
    // Imports — what the world market bought for the country this month.
    const importsTitle = this.create('div', 'pd-subtitle');
    importsTitle.setText('واردات');
    section.appendChild(importsTitle);
    const importsList = this.create('div', 'pd-trades');
    section.appendChild(importsList);
    this.track(importsList, 'imports');
    // Exports — what the world bought FROM the country this month.
    const exportsTitle = this.create('div', 'pd-subtitle');
    exportsTitle.setText('صادرات');
    section.appendChild(exportsTitle);
    const exportsList = this.create('div', 'pd-trades');
    section.appendChild(exportsList);
    this.track(exportsList, 'exports');
    return section;
  }

  /** The RESOURCE RESEARCH page (spec §11): one row per mine branch — the
   *  unlocked level, the next level's cost, and the unlock action. */
  private buildResearch(container: UIElement): UIElement {
    const section = this.section(container, 'pd-research');
    const title = this.create('div', 'pd-subtitle');
    title.setText('تحقیقات منابع — معادن');
    section.appendChild(title);
    const hint = this.create('div', 'pd-research-hint');
    hint.setText('با باز کردن هر سطح، ارتقای معادن آن منبع در نقشه باز می‌شود و تولید واقعاً افزایش می‌یابد.');
    section.appendChild(hint);
    const list = this.create('div', 'pd-research-list');
    section.appendChild(list);
    this.track(list, 'research');
    return section;
  }

  private buildBudget(container: UIElement): UIElement {
    const section = this.section(container, 'pd-budget');
    // BUDGET (spec §1/§6): the ONE 100% pool — two rows, −/+ steppers, the
    // two shares ALWAYS sum to 100% (the mutator moves the remainder to the
    // other pool). No GDP wording, no money, no other budget categories.
    const budgetTitle = this.create('div', 'pd-subtitle');
    budgetTitle.setText('بودجه — تقسیم ۱۰۰٪ بین اقتصاد و ارتش');
    section.appendChild(budgetTitle);
    section.appendChild(this.buildShareRow('economic'));
    section.appendChild(this.buildShareRow('military'));

    // TAX (spec §4/§7): FOUR levels only. The selected level is marked and
    // each option carries its one-line effect — no formulas, no categories.
    const taxTitle = this.create('div', 'pd-subtitle');
    taxTitle.setText('مالیات — سطح مالیات');
    section.appendChild(taxTitle);
    const taxLevels = this.create('div', 'pd-tax-levels');
    section.appendChild(taxLevels);
    this.track(taxLevels, 'taxLevels');
    return section;
  }

  private buildPolitics(container: UIElement): UIElement {
    const section = this.section(container, 'pd-politics');
    this.addRows(section, ['دولت', 'کرسی‌های پارلمان', 'اعتراض‌ها', 'اعتصاب‌ها'], 'politics.');
    // The POWER DISTRIBUTION PIE (spec §5): which group/party holds how much
    // political power — REAL data (parliament seats, or normalized support
    // before the first election) through politicalPowerDistribution.
    const pieTitle = this.create('div', 'pd-subtitle');
    pieTitle.setText('توزیع قدرت سیاسی');
    section.appendChild(pieTitle);
    const pie = this.create('div', 'pd-power');
    section.appendChild(pie);
    this.track(pie, 'power');
    const partiesTitle = this.create('div', 'pd-subtitle');
    partiesTitle.setText('احزاب — حمایت · کرسی · نقش');
    section.appendChild(partiesTitle);
    const parties = this.create('div', 'pd-parties');
    section.appendChild(parties);
    this.track(parties, 'parties');
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

  /** One budget-pool row (spec §6): label · live % · −/+ steppers. The
   *  command sets THIS pool's share; the core moves the other pool so the
   *  two always sum to exactly 100%. */
  private buildShareRow(pool: BudgetPool): UIElement {
    const row = this.create('div', 'pd-stepper');
    const rowLabel = this.create('span', 'pd-stepper-label');
    rowLabel.setText(BUDGET_POOL_LABELS[pool]);
    const value = this.create('span', 'pd-stepper-value');
    row.appendChild(rowLabel);
    row.appendChild(value);
    const minus = this.create('button', 'pd-step-btn');
    minus.setText('−');
    const plus = this.create('button', 'pd-step-btn');
    plus.setText('+');
    row.appendChild(minus);
    row.appendChild(plus);
    this.rows.set(`budget.${pool}`, value);
    const countryId = this.context?.state.player.countryId ?? '';
    minus.onClick(() => this.stepBudgetShare(countryId, pool, -0.05));
    plus.onClick(() => this.stepBudgetShare(countryId, pool, +0.05));
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
    if (context === undefined || context === null) return;
    // The resource page reads ONLY the live resource record (spec §18 — no
    // money rows, no GDP/inflation/unemployment).
    this.rebuildResources(countryId);
    this.rebuildConstruction(countryId);
    this.rebuildPurchases(countryId);
    this.rebuildTrades(countryId);
  }

  /**
   * The resource cards (spec §18/§19): numeric UNITS only.
   *   موجودی  (the REAL stockpile) · تولید  · مصرف  · status chip
   * The status is the REAL situation after trade (surplus / balanced /
   * shortage); a shortage the stockpile can no longer cover shows its size.
   */
  private rebuildResources(countryId: string): void {
    const context = this.context;
    if (context === undefined || context === null) return;
    const config = context.data.economyData.strategicResources;
    const record = context.state.economy.resources[countryId];
    // Signature guard: only rebuild the cards when a number actually moved
    // (keeps the DOM stable for clicks between the 15-frame refreshes).
    const signature = record === undefined ? 'none' : config.resources.map((resource) => {
      const id = resource.id;
      return [
        Math.round(record.stock[id] ?? 0),
        Math.round(record.production[id] ?? 0),
        Math.round(record.consumption[id] ?? 0),
        Math.round(record.imports[id] ?? 0),
        Math.round(record.exports[id] ?? 0),
        Math.round(record.emergencyImports[id] ?? 0)
      ].join(',');
    }).join('|') + `#${countryId}`;
    if (signature === this.dynamicSignatures.get('resources')) return;
    this.dynamicSignatures.set('resources', signature);
    this.rebuild('resources', this.parents.get('resources'), () => {
      const rows: UIElement[] = [];
      if (record === undefined) return rows;
      for (const resource of config.resources) {
        const resourceId = resource.id;
        const stock = Math.round(record.stock[resourceId] ?? 0);
        const production = Math.round(record.production[resourceId] ?? 0);
        const consumption = Math.round(record.consumption[resourceId] ?? 0);
        const importing = Math.round((record.imports[resourceId] ?? 0) + (record.emergencyImports[resourceId] ?? 0));
        const exporting = Math.round(record.exports[resourceId] ?? 0);
        const shortage = realShortageOf(record, resourceId);

        const visual = shortage > 0
          ? STATUS_VISUALS.shortage
          : production - consumption + importing - exporting < 0
            ? STATUS_VISUALS.balanced
            : production > consumption
              ? STATUS_VISUALS.surplus
              : STATUS_VISUALS.balanced;
        const card = this.create('div', `pd-resource ${visual.css}`);
        const head = this.create('div', 'pd-resource-head');
        const name = this.create('span', 'pd-resource-name');
        name.setText(resource.name);
        head.appendChild(name);
        const chip = this.create('span', `pd-resource-chip ${visual.css}`);
        chip.setText(visual.label);
        head.appendChild(chip);
        card.appendChild(head);

        // — the spec §18 lists: stock FIRST, then the monthly flows —
        const lines: string[] = [
          `موجودی: ${units(stock)}`,
          `تولید: +${units(production)} / ماه`,
          `مصرف: ${units(consumption)} / ماه`
        ];
        if (importing > 0) lines.push(`واردات: +${units(importing)} / ماه`);
        if (exporting > 0) lines.push(`صادرات: −${units(exporting)} / ماه`);
        if (shortage > 0) lines.push(`کمبود برطرف‌نشده: ${units(shortage)}`);
        for (const line of lines) {
          const detail = this.create('div', 'pd-resource-detail');
          detail.setText(line);
          card.appendChild(detail);
        }
        rows.push(card);
      }
      return rows;
    });
  }

  /**
   * The CONSTRUCTION section (spec §4/§17): every buildable factory with its
   * resource cost, and every active project with progress + the
   * Required/Owned/Missing triad. A stalled project says so plainly.
   */
  private rebuildConstruction(countryId: string): void {
    const context = this.context;
    if (context === undefined || context === null) return;
    const config = context.data.economyData.strategicResources;
    const state = context.state;
    const construction = state.economy.construction[countryId];
    const projects = construction?.projects ?? [];
    // The signature includes the LIVE stockpiles of the cost resources —
    // buying the missing units must visibly update دارا/کمبود immediately.
    const stockKey = config.productionFactories
      .flatMap((def) => Object.keys(def.cost))
      .filter((resourceId, index, all) => all.indexOf(resourceId) === index)
      .map((resourceId) => Math.round(state.economy.resources[countryId]?.stock[resourceId] ?? 0))
      .join(',');
    const signature =
      JSON.stringify(projects.map((project) => [project.id, project.typeId, project.progress, project.paid])) +
      `#${projects.length}#${stockKey}`;
    if (signature === this.dynamicSignatures.get('construction')) return;
    this.dynamicSignatures.set('construction', signature);
    this.rebuild('construction', this.parents.get('construction'), () => {
      const rows: UIElement[] = [];
      // — active projects (top) —
      for (const project of projects) {
        const def = config.productionFactories.find((candidate) => candidate.id === project.typeId);
        if (def === undefined) continue;
        const card = this.create('div', 'pd-project');
        const head = this.create('div', 'pd-project-head');
        const name = this.create('span', 'pd-project-name');
        name.setText(def.name);
        head.appendChild(name);
        const progress = this.create('span', 'pd-project-progress');
        progress.setText(`${Math.round(project.progress * 100)}٪`);
        head.appendChild(progress);
        card.appendChild(head);
        const shortages = projectShortageOf(state, countryId, config, project);
        const stalled = shortages.some((row) => row.missing > 0);
        for (const row of shortages) {
          const line = this.create('div', 'pd-project-line');
          const resName = config.resources.find((resource) => resource.id === row.resourceId)?.name ?? row.resourceId;
          line.setText(
            `${resName} — لازم ${units(row.required)} · دارا ${units(row.owned)} · ` +
            (row.missing > 0 ? `کمبود ${units(row.missing)}` : 'کافی')
          );
          card.appendChild(line);
        }
        const status = this.create('div', `pd-project-status ${stalled ? 'stalled' : 'running'}`);
        status.setText(stalled ? 'متوقف — منابع کافی نیست (خرید کنید)' : 'در حال ساخت');
        card.appendChild(status);
        rows.push(card);
      }
      // — the buildable types (bottom) —
      for (const def of config.productionFactories) {
        const row = this.create('div', 'pd-buildable');
        const info = this.create('div', 'pd-buildable-info');
        const name = this.create('span', 'pd-buildable-name');
        name.setText(def.name);
        info.appendChild(name);
        const resName = (resourceId: string): string =>
          config.resources.find((resource) => resource.id === resourceId)?.name ?? resourceId;
        const cost = Object.entries(def.cost)
          .map(([resourceId, amount]) => `${resName(resourceId)} ${units(amount)}`)
          .join(' · ');
        const boostName = resName(def.boosts);
        const detail = this.create('div', 'pd-buildable-detail');
        detail.setText(`هزینهٔ ساخت: ${cost} → تولید +${units(def.output)} ${boostName} / ماه`);
        info.appendChild(detail);
        row.appendChild(info);
        const build = this.create('button', 'pd-build');
        const atCap = projects.length >= config.construction.maxProjects;
        build.setText(atCap ? 'ظرفیت ساخت پُر است' : 'ساخت');
        build.onClick(() => this.send({ type: 'economy.startConstruction', countryId, typeId: def.id }));
        if (atCap) build.setAttribute('disabled', 'true');
        row.appendChild(build);
        rows.push(row);
      }
      return rows;
    });
  }

  /**
   * The PURCHASE panel (spec §5): for every resource the country is short
   * of, the sellers that actually hold stock. One click = one real deal;
   * the button buys what the country still needs (capped by the seller's
   * stock and the treasury). The per-unit price shows on the row — there is
   * no "Buy Cheapest" system (spec §6): the player picks the seller.
   */
  private rebuildPurchases(countryId: string): void {
    const context = this.context;
    if (context === undefined || context === null) return;
    const config = context.data.economyData.strategicResources;
    const state = context.state;
    const record = state.economy.resources[countryId];
    if (record === undefined) return;
    const countryName = (id: string): string => state.countries.countries[id]?.name ?? id;
    // The NEED is both the consumption shortfall AND the construction gaps
    // (spec §5's example: the player is short iron FOR A FACTORY and buys
    // the missing units — construction need is a first-class trigger).
    const constructionNeed: Record<string, number> = {};
    for (const project of state.economy.construction[countryId]?.projects ?? []) {
      for (const row of projectShortageOf(state, countryId, config, project)) {
        constructionNeed[row.resourceId] = (constructionNeed[row.resourceId] ?? 0) + row.missing;
      }
    }

    this.rebuild('purchases', this.parents.get('purchases'), () => {
      const rows: UIElement[] = [];
      for (const resource of config.resources) {
        const resourceId = resource.id;
        const shortage = realShortageOf(record, resourceId) + (constructionNeed[resourceId] ?? 0);
        const sellers = sellersOf(state, countryId, resourceId);
        if (shortage <= 0 || sellers.length === 0) continue;
        const price = dealPriceOf(state, countryId, resourceId, config);
        const block = this.create('div', 'pd-purchase');
        const head = this.create('div', 'pd-purchase-head');
        const name = this.create('span', 'pd-purchase-name');
        name.setText(`${resource.name} — کمبود ${units(shortage)}`);
        head.appendChild(name);
        const hint = this.create('span', 'pd-purchase-hint');
        hint.setText(`قیمت هر واحد ${money(price.buyPerUnit)}`);
        head.appendChild(hint);
        block.appendChild(head);
        for (const seller of sellers) {
          const row = this.create('div', 'pd-purchase-row');
          const label = this.create('span', 'pd-purchase-seller');
          label.setText(`${countryName(seller.countryId)} — ${units(seller.amount)} موجود`);
          row.appendChild(label);
          const buy = this.create('button', 'pd-buy');
          buy.setText(`خرید ${units(Math.min(seller.amount, shortage))}`);
          buy.onClick(() =>
            this.send({
              type: 'economy.buyResource',
              countryId,
              sellerId: seller.countryId,
              resourceId,
              amount: Math.min(seller.amount, shortage)
            })
          );
          row.appendChild(buy);
          block.appendChild(row);
        }
        rows.push(block);
      }
      if (rows.length === 0) {
        const empty = this.create('div', 'pd-trade-empty');
        empty.setText('کمبودی برای خرید نیست — یا فروشنده‌ای موجودی ندارد');
        rows.push(empty);
      }
      return rows;
    });
  }

  /** The RESOURCE RESEARCH rows (spec §11/§12): unlocked level per mine
   *  branch, the next level's cost, and the unlock action. */
  private refreshResearch(countryId: string): void {
    const context = this.context;
    if (context === undefined || context === null) return;
    const config = context.data.economyData.strategicResources;
    const state = context.state;
    const signature = config.resources.map((resource) => {
      const unlocked = unlockedMineLevelOf(state, countryId, resource.id);
      const cost = researchCostOf(config, resource.id, countryId, state);
      return `${resource.id}:${unlocked}:${cost ?? 'max'}`;
    }).join('|') + `#${countryId}`;
    if (signature === this.dynamicSignatures.get('research')) return;
    this.dynamicSignatures.set('research', signature);
    this.rebuild('research', this.parents.get('research'), () => {
      const rows: UIElement[] = [];
      for (const resource of config.resources) {
        const unlocked = unlockedMineLevelOf(state, countryId, resource.id);
        const cost = researchCostOf(config, resource.id, countryId, state);
        const row = this.create('div', 'pd-research-row');
        const name = this.create('span', 'pd-research-name');
        name.setText(resource.name);
        row.appendChild(name);
        const level = this.create('span', 'pd-research-level');
        level.setText(`سطح باز‌شده: ${unlocked}`);
        row.appendChild(level);
        if (cost === undefined) {
          const maxed = this.create('span', 'pd-research-max');
          maxed.setText('بیشینه');
          row.appendChild(maxed);
        } else {
          const action = this.create('button', 'pd-research-btn');
          action.setText(`باز کردن سطح ${unlocked + 1} — ${money(cost)}`);
          action.onClick(() => this.send({ type: 'economy.researchMine', countryId, resourceId: resource.id }));
          row.appendChild(action);
        }
        rows.push(row);
      }
      return rows;
    });
  }

  /**
   * The two trade sections (spec §2/§3/§10 — read-only views of the REAL
   * global trade network; no seller picking, no choice menus):
   *  - Imports lists ONLY short resources. Each shows what the world market
   *    actually bought this month (per partner country) + the GLOBAL market
   *    price tier + any UNFILLED shortage (the world supply ran out).
   *  - Exports lists ONLY surplus resources. Each shows what was actually
   *    sold this month (per buyer country), the market price tier, and the
   *    remaining export potential when the world bought less than offered.
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
    const allCountryIds = Object.keys(state.economy.resources);

    this.rebuild('imports', this.parents.get('imports'), () => {
      const rows: UIElement[] = [];
      if (record !== undefined) {
        for (const resource of config.resources) {
          const resourceId = resource.id;
          if (resourceRawBalanceOf(record, resourceId) >= 0) continue; // not short
          const bought = record.imports[resourceId] ?? 0;
          const unfilled = record.unfilledShortage[resourceId] ?? 0;
          const partners = Object.entries(record.suppliers[resourceId] ?? {}).filter(
            ([, amount]) => amount > 0
          );
          const block = this.create('div', 'pd-trade');
          const head = this.create('div', 'pd-trade-head');
          const nameElement = this.create('span', 'pd-trade-name');
          nameElement.setText(resource.name);
          head.appendChild(nameElement);
          const hint = this.create('span', 'pd-trade-hint');
          hint.setText(
            bought > 0
              ? `${units(bought)} / ماه · قیمت ${PRICE_TIER_LABELS[marketPriceTierOf(state.economy.resources, allCountryIds, resourceId)]}`
              : 'فروشنده‌ای در بازار نیست'
          );
          head.appendChild(hint);
          block.appendChild(head);

          for (const [sellerId, amount] of partners) {
            const row = this.create('div', 'pd-flow');
            row.setText(`از ${countryName(sellerId)} — ${units(amount)} / ماه`);
            block.appendChild(row);
          }
          if (unfilled > 0) {
            const row = this.create('div', 'pd-flow gap');
            row.setText(`کمبود برطرف‌نشده — ${units(unfilled)} / ماه (عرضهٔ جهانی کافی نیست)`);
            block.appendChild(row);
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
          const initial = resourceRawBalanceOf(record, resourceId);
          if (initial <= 0) continue; // no surplus
          const sold = record.exports[resourceId] ?? 0;
          const potential = Math.round(initial) - Math.round(sold); // unsold surplus
          // The buyers of THIS month: the world market's flows read from the
          // buyers' records (every unit bought names its seller).
          const buyers: { buyerId: string; amount: number }[] = [];
          for (const otherId of allCountryIds) {
            if (otherId === countryId) continue;
            const amount = state.economy.resources[otherId]?.suppliers[resourceId]?.[countryId] ?? 0;
            if (amount > 0) buyers.push({ buyerId: otherId, amount });
          }
          buyers.sort((a, b) => b.amount - a.amount || countryName(a.buyerId).localeCompare(countryName(b.buyerId)));

          const block = this.create('div', 'pd-trade');
          const head = this.create('div', 'pd-trade-head');
          const nameElement = this.create('span', 'pd-trade-name');
          nameElement.setText(resource.name);
          head.appendChild(nameElement);
          const hint = this.create('span', 'pd-trade-hint');
          hint.setText(
            sold > 0
              ? `${units(sold)} / ماه · قیمت ${PRICE_TIER_LABELS[marketPriceTierOf(state.economy.resources, allCountryIds, resourceId)]}`
              : 'خریداری در بازار نیست'
          );
          head.appendChild(hint);
          block.appendChild(head);

          for (const buyer of buyers) {
            const row = this.create('div', 'pd-flow');
            row.setText(`به ${countryName(buyer.buyerId)} — ${units(buyer.amount)} / ماه`);
            block.appendChild(row);
          }
          if (potential > 0) {
            const row = this.create('div', 'pd-flow gap');
            row.setText(`ظرفیت صادرات باقی‌مانده — ${units(potential)} / ماه`);
            block.appendChild(row);
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
    // The TWO halves of the ONE 100% pool (spec §6) — live from state.
    this.rows.get('budget.economic')?.setText(percent(government.budget.shares.economic));
    this.rows.get('budget.military')?.setText(percent(government.budget.shares.military));
    // The FOUR tax levels with the selected one marked (spec §7).
    this.rebuildTaxLevels(countryId, government.budget.tax);
  }

  /** The tax-level chooser (spec §4/§7): one marked option per level, each
   *  with its short one-line effect. Rebuilt when the level changes. */
  private rebuildTaxLevels(countryId: string, current: TaxLevel): void {
    const signature = `tax:${current}:${countryId}`;
    if (signature === this.dynamicSignatures.get('taxLevels')) return;
    this.rebuild('taxLevels', this.parents.get('taxLevels'), () => {
      const rows: UIElement[] = [];
      for (const level of TAX_LEVEL_IDS) {
        const row = this.create('button', level === current ? 'pd-tax-level on' : 'pd-tax-level');
        const name = this.create('span', 'pd-tax-name');
        name.setText(TAX_LEVEL_LABELS[level]);
        const effect = this.create('span', 'pd-tax-effect');
        effect.setText(TAX_LEVEL_EFFECTS[level]);
        row.appendChild(name);
        row.appendChild(effect);
        row.onClick(() => this.send({ type: 'government.setTaxLevel', countryId, level }));
        rows.push(row);
      }
      return rows;
    });
    this.dynamicSignatures.set('taxLevels', signature);
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
    this.rebuildPowerPie(government);
    this.rebuildParties(government);
  }

  /**
   * The POWER DISTRIBUTION PIE (spec §5): a conic-gradient disc over the
   * REAL power data (politicalPowerDistribution — parliament seats once
   * assigned, normalized support before) + a legend with the exact shares.
   * The strongest party is called out as «در رأس قدرت». Rebuilt only when
   * the distribution actually changes (support drifts monthly).
   */
  private rebuildPowerPie(government: GovernmentCountryState): void {
    const container = this.parents.get('power');
    if (container === undefined) return;
    const distribution = politicalPowerDistribution(government);
    const signature = distribution.map((entry) => `${entry.partyId}:${entry.share.toFixed(4)}`).join('|');
    if (signature === this.dynamicSignatures.get('power')) return;
    this.dynamicSignatures.set('power', signature);
    for (const element of this.dynamic.get('power') ?? []) element.remove();

    const fresh: UIElement[] = [];
    if (distribution.length === 0) {
      const empty = this.create('div', 'pd-trade-empty');
      empty.setText('حزبی وجود ندارد');
      container.appendChild(empty);
      fresh.push(empty);
      this.dynamic.set('power', fresh);
      return;
    }

    // — the pie: one conic-gradient covering every party slice —
    const pie = this.create('div', 'pd-power-pie');
    const stops: string[] = [];
    let cursor = 0;
    distribution.forEach((entry, index) => {
      const color = POWER_PIE_COLORS[index % POWER_PIE_COLORS.length];
      const from = cursor * 360;
      cursor += entry.share;
      const to = cursor * 360;
      stops.push(`${color} ${from.toFixed(2)}deg ${to.toFixed(2)}deg`);
    });
    pie.setAttribute('style', `background: conic-gradient(${stops.join(', ')});`);
    container.appendChild(pie);
    fresh.push(pie);

    // — the legend: exact share + the strongest-party callout —
    const legend = this.create('div', 'pd-power-legend');
    distribution.forEach((entry, index) => {
      const row = this.create('div', entry.inGovernment ? 'pd-power-row in-gov' : 'pd-power-row');
      const dot = this.create('span', 'pd-power-dot');
      dot.setAttribute('style', `background: ${POWER_PIE_COLORS[index % POWER_PIE_COLORS.length]};`);
      const label = this.create('span', 'pd-power-name');
      label.setText(
        `${entry.partyName}${index === 0 ? ' — در رأس قدرت' : ''}`
      );
      const share = this.create('span', 'pd-power-share');
      share.setText(percent(entry.share));
      row.appendChild(dot);
      row.appendChild(label);
      row.appendChild(share);
      legend.appendChild(row);
      fresh.push(row);
    });
    container.appendChild(legend);
    this.dynamic.set('power', fresh);
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
    // A fresh container invalidates any signature left from a PREVIOUS
    // build of this screen — otherwise a signature-guarded list (tax
    // levels, power pie) would skip its first rebuild after reopening.
    this.dynamicSignatures.delete(id);
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

  /** Budget-pool stepper (spec §6) — ±5 percentage points of the 100% pool.
   *  The core moves the OTHER pool by the same amount (zero-sum). */
  private stepBudgetShare(countryId: string, pool: BudgetPool, delta: number): void {
    const government = this.context?.state.government.countries[countryId];
    if (government === undefined) return;
    this.send({ type: 'government.setBudgetShare', countryId, pool, value: government.budget.shares[pool] + delta });
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

function money(value: number): string {
  // The light money scale prices small trades below 1 M$/unit — keep one
  // decimal so a per-unit price never rounds into a meaningless 0.
  if (Math.abs(value) < 10 && Math.abs(value) > 0) return `${value.toFixed(1)} میلیون دلار`;
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
      // 'mul' is always a percentage modifier; 'add' is M$ for money/food
      // targets and percentage points for rates (approval, trust, …).
      const targetLabel = TARGET_LABELS[effect.target] ?? effect.target;
      if (effect.mode === 'mul') {
        return `${targetLabel} ${sign}${(magnitude * 100).toFixed(0)}٪${duration}`;
      }
      const moneyTargets = ['treasury', 'foodStock'];
      const isMoney = moneyTargets.includes(effect.target);
      const amount = isMoney ? `${sign}${money(magnitude)}` : `${sign}${(magnitude * 100).toFixed(1)}٪`;
      return `${targetLabel} ${amount}${duration}`;
    })
    .join(', ');
}
