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
import { resourceRawBalanceOf } from '../economy/resources';
import { marketPriceTierOf, type TradeTier } from '../economy/market';

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
  | 'budget'
  | 'politics'
  | 'decisions'
  | 'events'
  | 'opinion'
  | 'elections';

const SECTION_LABELS: Readonly<Record<SectionId, string>> = {
  overview: 'نمای کلی',
  economy: 'اقتصاد',
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

/** The THREE resource status visuals (spec §8): مازاد / متعادل / کمبود —
 *  keyed by the SIGN of the balance a line describes (final balance for the
 *  card, raw balance for the initial line). Never hand-set. */
const STATUS_VISUALS = {
  surplus: { label: 'مازاد', css: 'st-surplus' },
  balanced: { label: 'متعادل', css: 'st-balanced' },
  shortage: { label: 'کمبود', css: 'st-shortage' }
} as const;

/** Status visual of a SIGNED balance: positive → surplus, negative → shortage. */
function statusVisualOf(balance: number): { label: string; css: string } {
  if (balance > 1e-4) return STATUS_VISUALS.surplus;
  if (balance < -1e-4) return STATUS_VISUALS.shortage;
  return STATUS_VISUALS.balanced;
}

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
    // The RESOURCE page (final structure — spec §7): ONLY Resources / Imports
    // / Exports. No financial summary rows, no sector data — money stays in
    // the simulation and the Budget page.
    // Resources — the resource-centric core (spec §2/§3): production ·
    // consumption · INITIAL shortage/surplus · active import/export · FINAL
    // balance + the resource's own import/export action.
    const resourcesTitle = this.create('div', 'pd-subtitle');
    resourcesTitle.setText('منابع');
    section.appendChild(resourcesTitle);
    const resourcesList = this.create('div', 'pd-resources');
    section.appendChild(resourcesList);
    this.track(resourcesList, 'resources');
    // Imports — ONLY the resources the country is short of: the world market
    // buys the shortage automatically (real trade partners + amounts + the
    // GLOBAL market price tier).
    const importsTitle = this.create('div', 'pd-subtitle');
    importsTitle.setText('واردات');
    section.appendChild(importsTitle);
    const importsList = this.create('div', 'pd-trades');
    section.appendChild(importsList);
    this.track(importsList, 'imports');
    // Exports — ONLY the resources with a surplus: what the world actually
    // bought this month, from whom, and the remaining export potential.
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
    // The resource page reads ONLY the live resource record (spec §7 — no
    // money rows here; treasury/GDP live in the Budget page and the status
    // panel).
    this.rebuildResources(countryId);
    this.rebuildTrades(countryId);
  }

  /**
   * The resource cards (spec §2/§3 — the understandable math):
   *   تولید · مصرف · INITIAL shortage/surplus · واردات/صادرات · FINAL balance
   * Initial = Production − Consumption. The GLOBAL trade network resolves
   * every month on its own: a real shortage is bought automatically (when
   * the world can cover it) and a real surplus sells automatically — the
   * final balance reads 0 (متعادل) unless the WORLD supply ran out.
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
        const importing = record.imports[resourceId] ?? 0;
        const exporting = record.exports[resourceId] ?? 0;
        // DISPLAY math: deltas are computed from the SAME rounded numbers the
        // lines show, so what the player reads always adds up exactly
        // (تولید 12 − مصرف 30 → کمبود 18 — never an off-by-one puzzle).
        const shownProduction = Math.round(production);
        const shownConsumption = Math.round(consumption);
        const shownImports = Math.round(importing);
        const shownExports = Math.round(exporting);
        const shownInitial = shownProduction - shownConsumption;
        const shownFinal = shownProduction + shownImports - shownConsumption - shownExports;

        const finalVisual = statusVisualOf(shownFinal);
        const card = this.create('div', `pd-resource ${finalVisual.css}`);
        const head = this.create('div', 'pd-resource-head');
        const name = this.create('span', 'pd-resource-name');
        name.setText(resource.name);
        head.appendChild(name);
        card.appendChild(head);

        // — the understandable math lines (spec §3) —
        const lines: string[] = [
          `تولید: ${units(shownProduction)}`,
          `مصرف: ${units(shownConsumption)}`
        ];
        if (shownInitial !== 0) {
          lines.push(
            shownInitial < 0
              ? `کمبود اولیه: ${units(-shownInitial)}`
              : `مازاد اولیه: ${units(shownInitial)}`
          );
        }
        if (importing > 1e-4) lines.push(`واردات: ${units(shownImports)}`);
        if (exporting > 1e-4) lines.push(`صادرات: ${units(shownExports)}`);
        for (const line of lines) {
          const detail = this.create('div', 'pd-resource-detail');
          detail.setText(line);
          card.appendChild(detail);
        }
        // The FINAL line (spec §3: Final Balance — the number that must add
        // up): 0 → متعادل، otherwise the remaining ± amount (a negative
        // remainder is the UNFILLED shortage — the world supply ran out).
        const statusElement = this.create('div', `pd-resource-statusline ${finalVisual.css}`);
        statusElement.setText(
          shownFinal !== 0
            ? `${finalVisual.label}: ${units(Math.abs(shownFinal))}`
            : 'تراز نهایی: متعادل'
        );
        card.appendChild(statusElement);
        rows.push(card);
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
