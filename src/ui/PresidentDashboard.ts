import type { CommandBus } from '../core/CommandBus';
import type { SystemContext } from '../core/GameContext';
import type { UIElement } from './adapter/UIDomAdapter';
import type { ScreenManager } from './ScreenManager';
import type { GameCommand } from '../core/CommandTypes';
import type { EffectDef, GovernmentCountryState, OpinionTopic, TaxCategory } from '../government/types';
import { OPINION_TOPICS, TAX_CATEGORIES } from '../government/types';
import { decisionBlockReason } from '../government/DecisionEngine';
import { politicalPowerDistribution } from '../state/slices/governmentSlice';
import { networkSummary } from '../world/cityareas/CityAreaPathfinding';
import { resourceRawBalanceOf } from '../economy/resources';
import { buyerDemandTiersOf, sellerPriceTiersOf, spareSurplusOf, type TradeTier } from '../economy/market';

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

/** Budget stepper rows (spec §4 — EXACTLY three parts): Tax keeps its three
 *  rate categories; spending collapses to ONE economic + ONE military lever. */
const TAX_LABELS: Readonly<Record<TaxCategory, string>> = {
  income: 'مالیات بر درآمد',
  corporate: 'مالیات شرکتی',
  trade: 'عوارض تجاری'
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
    // EXACTLY three parts (spec §4): Tax · Economic Budget · Military
    // Budget. No debt, no treasury breakdown, no category spending list —
    // the economic lever distributes over the existing internal categories
    // so the simulation keeps working unchanged.
    const taxTitle = this.create('div', 'pd-subtitle');
    taxTitle.setText('مالیات');
    section.appendChild(taxTitle);
    for (const category of TAX_CATEGORIES) {
      section.appendChild(this.buildStepperRow(TAX_LABELS[category], 'tax', category, 0.01));
    }

    const economicTitle = this.create('div', 'pd-subtitle');
    economicTitle.setText('بودجهٔ اقتصادی — سهم سالانه از تولید ناخالص');
    section.appendChild(economicTitle);
    section.appendChild(this.buildEconomicStepperRow());

    const militaryTitle = this.create('div', 'pd-subtitle');
    militaryTitle.setText('بودجهٔ نظامی — سهم سالانه از تولید ناخالص');
    section.appendChild(militaryTitle);
    section.appendChild(this.buildMilitaryStepperRow());
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

  /** A labeled row with −/+ steppers wired to a budget command. `category`
   *  is a tax id for 'tax' rows; 'spending' rows are the Military lever. */
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

  /** The ONE Economic Budget lever (spec §4) — sends setEconomicBudget. */
  private buildEconomicStepperRow(): UIElement {
    const row = this.create('div', 'pd-stepper');
    const rowLabel = this.create('span', 'pd-stepper-label');
    rowLabel.setText('بودجهٔ اقتصادی');
    const value = this.create('span', 'pd-stepper-value');
    row.appendChild(rowLabel);
    row.appendChild(value);
    const minus = this.create('button', 'pd-step-btn');
    minus.setText('−');
    const plus = this.create('button', 'pd-step-btn');
    plus.setText('+');
    row.appendChild(minus);
    row.appendChild(plus);
    this.rows.set('budget.economic', value);
    const countryId = this.context?.state.player.countryId ?? '';
    minus.onClick(() => this.stepEconomicBudget(countryId, -0.005));
    plus.onClick(() => this.stepEconomicBudget(countryId, +0.005));
    return row;
  }

  /** The Military Budget lever (spec §4) — the military spending share. */
  private buildMilitaryStepperRow(): UIElement {
    const row = this.create('div', 'pd-stepper');
    const rowLabel = this.create('span', 'pd-stepper-label');
    rowLabel.setText('بودجهٔ نظامی');
    const value = this.create('span', 'pd-stepper-value');
    row.appendChild(rowLabel);
    row.appendChild(value);
    const minus = this.create('button', 'pd-step-btn');
    minus.setText('−');
    const plus = this.create('button', 'pd-step-btn');
    plus.setText('+');
    row.appendChild(minus);
    row.appendChild(plus);
    this.rows.set('budget.military', value);
    const countryId = this.context?.state.player.countryId ?? '';
    minus.onClick(() => this.stepMilitaryBudget(countryId, -0.005));
    plus.onClick(() => this.stepMilitaryBudget(countryId, +0.005));
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
   * Initial = Production − Consumption. When the market has sellers the
   * import fills the WHOLE deficit, so the final balance reads 0 (متعادل).
   * The trade action follows the POLICY (not the derived status) so an
   * active import/export can always be switched off again.
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
        const initial = resourceRawBalanceOf(record, resourceId); // = P − C (raw)
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
        // The resource's own trade action (spec §9's [Import]/[Export]).
        // Governed by POLICY + possibility: a deficit can start/stop an
        // import; a surplus can start/stop an export; an active policy is
        // ALWAYS stoppable (even when imports made the status balanced).
        const canImport = initial < -1e-4 || record.importPolicy[resourceId] === true;
        const canExport = initial > 1e-4 || record.exportPolicy[resourceId] === true;
        if (canImport || canExport) {
          const doingImport = canImport && !canExport;
          const active = doingImport
            ? record.importPolicy[resourceId] === true
            : record.exportPolicy[resourceId] === true;
          const button = this.create('button', active ? 'pd-resource-btn on' : 'pd-resource-btn');
          button.setText(
            doingImport
              ? (active ? 'توقف واردات' : 'واردات')
              : (active ? 'توقف صادرات' : 'صادرات')
          );
          button.onClick(() =>
            this.send({
              type: doingImport ? 'economy.setImportPolicy' : 'economy.setExportPolicy',
              countryId,
              resourceId,
              active: !active
            })
          );
          head.appendChild(button);
        }
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
        // up): 0 → متعادل، otherwise the remaining ± amount.
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
              const activeSuppliers = record.suppliers[resourceId] ?? [];
              const pinned = record.preferredSuppliers?.[resourceId] ?? null;
              for (const seller of sellers) {
                const isActive = activeSuppliers.includes(seller.sellerId);
                const row = this.create('div', isActive ? 'pd-seller on' : 'pd-seller');
                row.setText(
                  `${countryName(seller.sellerId)} — موجود ${units(seller.spare)} · قیمت ${PRICE_TIER_LABELS[seller.tier]}` +
                    (isActive ? (pinned === seller.sellerId ? ' · انتخاب شما' : ' · تأمین‌کنندهٔ بازار') : '')
                );
                // Click a seller → buy from THERE first (pin). Click the
                // pinned one again → back to automatic market choice. The
                // market still fills the FULL deficit (other sellers follow
                // when the pinned one runs out of spare).
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
    // Tax — the three rates.
    for (const category of TAX_CATEGORIES) {
      this.rows.get(`budget.tax.${category}`)?.setText(percent(government.budget.taxRates[category]));
    }
    // The economic lever = the SUM of the non-military shares (the value
    // the setEconomicBudget command distributes over them).
    const economic = (Object.keys(government.budget.spendingShares) as (keyof typeof government.budget.spendingShares)[])
      .filter((category) => category !== 'military')
      .reduce((sum, category) => sum + government.budget.spendingShares[category], 0);
    this.rows.get('budget.economic')?.setText(percent(economic));
    this.rows.get('budget.military')?.setText(percent(government.budget.spendingShares.military));
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

  /** Tax rate stepper — the Tax part of the Budget page (spec §4). */
  private stepBudget(countryId: string, kind: 'tax' | 'spending', category: string, delta: number): void {
    const government = this.context?.state.government.countries[countryId];
    if (government === undefined) return;
    if (kind === 'tax') {
      const key = category as TaxCategory;
      this.send({ type: 'government.setTaxRate', countryId, category: key, value: government.budget.taxRates[key] + delta });
    } else {
      this.send({ type: 'government.setSpending', countryId, category: 'military', value: government.budget.spendingShares.military + delta });
    }
  }

  /** The ONE economic lever (spec §4) — core distributes it proportionally. */
  private stepEconomicBudget(countryId: string, delta: number): void {
    const government = this.context?.state.government.countries[countryId];
    if (government === undefined) return;
    const current = Object.entries(government.budget.spendingShares)
      .filter(([category]) => category !== 'military')
      .reduce((sum, [, share]) => sum + share, 0);
    this.send({ type: 'government.setEconomicBudget', countryId, value: current + delta });
  }

  /** The military lever (spec §4) — the military spending share. */
  private stepMilitaryBudget(countryId: string, delta: number): void {
    const government = this.context?.state.government.countries[countryId];
    if (government === undefined) return;
    this.send({
      type: 'government.setSpending',
      countryId,
      category: 'military',
      value: government.budget.spendingShares.military + delta
    });
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
