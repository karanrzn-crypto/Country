import type { CommandBus } from '../core/CommandBus';
import type { SystemContext } from '../core/GameContext';
import type { GameState } from '../state/GameState';
import type { UIElement } from './adapter/UIDomAdapter';
import type { ScreenManager } from './ScreenManager';
import type { GameCommand } from '../core/CommandTypes';
import type { BudgetPool, EffectDef, GovernmentCountryState, OpinionTopic, TaxLevel } from '../government/types';
import { OPINION_TOPICS, TAX_LEVEL_IDS, TAX_LEVEL_SPECS } from '../government/types';
import { decisionBlockReason } from '../government/DecisionEngine';
import { politicalPowerDistribution } from '../state/slices/governmentSlice';
import { networkSummary } from '../world/cityareas/CityAreaPathfinding';
import { resourceDisplayStatusOf } from '../economy/resources';
import {
  projectMonthsRemaining,
  constructionSpeedFactorOf,
  workforceCapacityOf,
  workforceUsedBy
} from '../economy/construction';
import {
  marketOffersOf,
  unitPriceOf,
  activeContractsOf,
  remainingSaleOfferOf
} from '../economy/contracts';
import type { TradeContract } from '../economy/resourceTypes';
import type { StrategicResourcesConfig } from '../economy/types';
import { faNum, faSigned, faPopulation, toFaDigits } from '../utils/format';

/**
 * President Dashboard (Phase 2) — the head-of-state command center.
 * All player-facing text is PERSIAN; ids stay technical.
 *
 * Sections (final UI structure — spec §12/§16/§17/§18): نمای کلی · اقتصاد ·
 * بودجه · سیاست · تصمیم‌ها · رویدادها · افکار عمومی · انتخابات.
 * (No independent Government panel — it repeated other sections;
 * the ministry/budget systems keep running in the simulation.)
 *
 * The UI owns NO simulation state: every value is read from GameState at
 * refresh time, every action goes out as a command. The skeleton is built
 * once per open; dynamic lists (decisions, events, results) are rebuilt by
 * removing stale elements. Each section keeps its OWN dynamic list so the
 * monthly refresh pass never removes another section's fresh rows.
 */

export type SectionId =
  | 'overview'
  | 'economy'
  | 'contracts'
  | 'budget'
  | 'military'
  | 'politics'
  | 'decisions'
  | 'events'
  | 'opinion'
  | 'elections';

const SECTION_LABELS: Readonly<Record<SectionId, string>> = {
  overview: 'نمای کلی',
  economy: 'اقتصاد',
  contracts: 'قراردادها',
  budget: 'بودجه',
  military: 'نظامی',
  politics: 'سیاست',
  decisions: 'تصمیم‌ها',
  events: 'رویدادها',
  opinion: 'افکار عمومی',
  elections: 'انتخابات'
};

const TAB_ORDER: readonly SectionId[] = [
  'overview',
  'economy',
  'contracts',
  'budget',
  'military',
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

/** The THREE tax levels (spec §9) — Persian names + the short effect text. */
const TAX_LEVEL_LABELS: Readonly<Record<TaxLevel, string>> = {
  low: 'کم',
  medium: 'متوسط',
  high: 'زیاد'
};

const TAX_LEVEL_EFFECTS: Readonly<Record<TaxLevel, string>> = {
  low: 'درآمد کمتر — ثبات و رضایت بیشتر',
  medium: 'درآمد و ثبات متعادل',
  high: 'درآمد بیشتر — ثبات کمتر'
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
  /**
   * The on-demand MARKET state (spec §18): closed until the player clicks a
   * buy entry point; when open, `marketFocus` narrows it to ONE resource
   * (null = the missing resources of the waiting construction projects).
   */
  private marketOpen = false;
  private marketFocus: string | null = null;
  /** The market's section title (hidden while the market is closed). */
  private marketTitle: UIElement | null = null;

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
    this.refreshContracts(countryId);
    this.refreshMilitary(countryId);
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
    this.sections.set('contracts', this.buildContracts(body));
    this.sections.set('budget', this.buildBudget(body));
    this.sections.set('military', this.buildMilitary(body));
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

  /** The strategic-economy config shortcut (null before registration). */
  private economyConfig(): StrategicResourcesConfig | null {
    return this.context?.data.economyData.strategicResources ?? null;
  }

  private buildEconomy(container: UIElement): UIElement {
    const section = this.section(container, 'pd-economy');
    // The ECONOMY page (spec §12) — the whole country's money story at
    // a glance: the §1 rows, the INCOME lines, the EXPENSE lines and the
    // treasury change — followed by the resource cards, construction and
    // the on-demand market. No GDP, no accounting tables.
    const ledgerTitle = this.create('div', 'pd-subtitle');
    ledgerTitle.setText('اقتصاد کشور');
    section.appendChild(ledgerTitle);
    // The §1 rows — the good rows are CONFIG-driven (the world may carry
    // any set of goods); the economy level and specialization ride along.
    const ledgerKeys = ['پول خزانه', 'جمعیت', 'وضعیت اقتصاد', 'تخصص'];
    for (const resource of this.economyConfig()?.resources ?? []) ledgerKeys.push(resource.name);
    ledgerKeys.push('نرخ مالیات');
    this.addRows(section, ledgerKeys, 'ledger.');
    const incomeTitle = this.create('div', 'pd-subtitle');
    incomeTitle.setText('درآمد (این ماه)');
    section.appendChild(incomeTitle);
    this.addRows(section, ['مالیات', 'تجارت'], 'income.');
    const expenseTitle = this.create('div', 'pd-subtitle');
    expenseTitle.setText('هزینه‌ها (این ماه)');
    section.appendChild(expenseTitle);
    this.addRows(section, ['ارتش', 'دولت', 'زیرساخت', 'تغییر خزانه'], 'expense.');

    // RESOURCES — the three stockpiles with production/consumption per month.
    const resourcesTitle = this.create('div', 'pd-subtitle');
    resourcesTitle.setText('منابع');
    section.appendChild(resourcesTitle);
    const resourcesList = this.create('div', 'pd-resources');
    section.appendChild(resourcesList);
    this.track(resourcesList, 'resources');
    // Construction — one project card per active project (MONTHS remaining —
    // the cost was paid once at start, spec §8) + the buildables.
    const constructionTitle = this.create('div', 'pd-subtitle');
    constructionTitle.setText('ساخت‌وساز');
    section.appendChild(constructionTitle);
    const constructionList = this.create('div', 'pd-construction');
    section.appendChild(constructionList);
    this.track(constructionList, 'construction');
    // The MARKET (spec §18) — hidden until the player asks for it; then it
    // shows ONLY the resources that are actually missing, with the real
    // sellers of each. No always-open seller tables, no Buy-Cheapest.
    const marketTitle = this.create('div', 'pd-subtitle pd-market-title');
    marketTitle.setText('بازار منابع');
    marketTitle.setAttribute('style', 'display:none;');
    section.appendChild(marketTitle);
    const marketList = this.create('div', 'pd-market');
    section.appendChild(marketList);
    this.track(marketList, 'market');
    this.marketTitle = marketTitle;
    return section;
  }

  /**
   * The CONTRACTS panel (spec §7/§8) — every trade contract of the
   * country, read straight from `state.economy.contracts` (no UI-side
   * shadow state): the partner country, the good, the monthly amount, the
   * price, the status, the permanence and the last REAL delivery — each
   * active contract carries its لغو button (spec §7).
   */
  private buildContracts(container: UIElement): UIElement {
    const section = this.section(container, 'pd-contracts');
    // THE EXPORT REQUESTS (the export-request directive §3) — pending
    // formal requests from other countries to BUY the player's goods, read
    // straight from `state.economy.exportRequests`; each pending request
    // carries the president's two choices: موافقت / مخالفت.
    const requestsTitle = this.create('div', 'pd-subtitle');
    requestsTitle.setText('درخواست‌های صادرات');
    section.appendChild(requestsTitle);
    const requestsList = this.create('div', 'pd-requests');
    section.appendChild(requestsList);
    this.track(requestsList, 'requests');
    const title = this.create('div', 'pd-subtitle');
    title.setText('قراردادهای تجاری');
    section.appendChild(title);
    const list = this.create('div', 'pd-contract-list');
    section.appendChild(list);
    this.track(list, 'contractList');
    return section;
  }

  /**
   * THE MILITARY PANEL (the military directive §4-§7) — the buildable
   * MILITARY infrastructure (training camp / tank plant / air plant), the
   * SAME construction pipeline the economy tab uses: ساخت activates the
   * ONE build mode, a map click previews the region, تأیید starts the
   * project (money + materials + workforce paid once, one facility per
   * region — the SAME core rules).
   */
  private buildMilitary(container: UIElement): UIElement {
    const section = this.section(container, 'pd-military');
    const title = this.create('div', 'pd-subtitle');
    title.setText('ساختمان‌های نظامی');
    section.appendChild(title);
    const note = this.create('div', 'pd-build-hint');
    note.setText(
      'تأسیسات نظامی با همان سیستم ساخت‌وساز اقتصادی ساخته می‌شوند؛ هر منطقه فقط یک تأسیسات اصلی (نظامی یا اقتصادی) می‌تواند داشته باشد.'
    );
    section.appendChild(note);
    const list = this.create('div', 'pd-construction');
    section.appendChild(list);
    this.track(list, 'militaryBuildables');
    return section;
  }

  /** Rebuilds the military tab: active military projects + the buildables. */
  private refreshMilitary(countryId: string): void {
    const context = this.context;
    if (context === undefined || context === null) return;
    const config = context.data.economyData.strategicResources;
    const state = context.state;
    const militaryDefs = config.buildings.filter((candidate) => candidate.kind === 'military');
    const construction = state.economy.construction[countryId];
    const projects = (construction?.projects ?? []).filter((project) =>
      militaryDefs.some((candidate) => candidate.id === project.typeId)
    );
    const treasury = Math.floor(state.economy.treasury[countryId] ?? 0);
    const record = state.economy.resources[countryId];
    const materialsStock = Math.round(record?.stock.industrial ?? 0);
    const heldWorkforce = workforceUsedBy(state, countryId, config);
    const workforceCapacity = workforceCapacityOf(state, countryId, config);
    const allProjects = construction?.projects ?? [];
    const gridIdOf = (cellKey: string): string => cellKey.slice(cellKey.indexOf('#') + 1);
    const speed = constructionSpeedFactorOf(state, countryId);
    const signature =
      JSON.stringify(projects.map((project) => [project.id, project.typeId, project.progress, project.cellKey])) +
      `#${treasury}#${materialsStock}#${heldWorkforce}#${workforceCapacity}#${allProjects.length}#${state.map.buildMode ?? ''}`;
    if (signature === this.dynamicSignatures.get('militaryBuildables')) return;
    this.dynamicSignatures.set('militaryBuildables', signature);
    this.rebuild('militaryBuildables', this.parents.get('militaryBuildables'), () => {
      const rows: UIElement[] = [];
      if (state.map.buildMode !== null && militaryDefs.some((candidate) => candidate.id === state.map.buildMode)) {
        const def = militaryDefs.find((candidate) => candidate.id === state.map.buildMode);
        const hint = this.create('div', 'pd-build-hint');
        hint.setText(
          `حالت ساخت فعال: ${def?.name ?? state.map.buildMode} — یک منطقهٔ خالی از کشور خود را روی نقشه انتخاب کنید`
        );
        const cancel = this.create('button', 'pd-build-cancel');
        cancel.setText('لغو ساخت');
        cancel.onClick(() => this.send({ type: 'economy.buildMode', typeId: null }));
        hint.appendChild(cancel);
        rows.push(hint);
      }
      for (const project of projects) {
        const def = militaryDefs.find((candidate) => candidate.id === project.typeId);
        if (def === undefined) continue;
        const card = this.create('div', 'pd-project');
        const head = this.create('div', 'pd-project-head');
        const name = this.create('span', 'pd-project-name');
        name.setText(`${def.name} — منطقه ${gridIdOf(project.cellKey)}`);
        head.appendChild(name);
        const progress = this.create('span', 'pd-project-progress');
        progress.setText(
          `باقی‌مانده: ${faNum(projectMonthsRemaining(project.progress, def.buildMonths, speed))} ماه`
        );
        head.appendChild(progress);
        card.appendChild(head);
        const status = this.create('div', 'pd-project-status running');
        status.setText('در حال ساخت');
        card.appendChild(status);
        rows.push(card);
      }
      for (const def of militaryDefs) {
        const row = this.create('div', 'pd-buildable');
        const info = this.create('div', 'pd-buildable-info');
        const name = this.create('span', 'pd-buildable-name');
        name.setText(def.name);
        info.appendChild(name);
        const detail = this.create('div', 'pd-buildable-detail');
        detail.setText(
          `هزینه: ${faNum(def.cost)} پول · ${faNum(def.materials)} مصالح · نیروی کار ${faNum(def.workforce)} · مدت ساخت ${faNum(def.buildMonths)} ماه`
        );
        info.appendChild(detail);
        row.appendChild(info);
        const build = this.create('button', 'pd-build');
        const atCap = allProjects.length >= config.construction.maxProjects;
        if (state.map.buildMode === def.id) {
          build.setText('در حال انتخاب منطقه…');
          build.setAttribute('disabled', 'true');
        } else if (atCap) {
          build.setText('ظرفیت ساخت پُر است');
          build.setAttribute('disabled', 'true');
        } else if (treasury < def.cost) {
          build.setText(`پول کافی نیست (${faNum(def.cost)})`);
          build.setAttribute('disabled', 'true');
        } else if (materialsStock < def.materials) {
          build.setText(`مصالح کافی نیست (${faNum(def.materials)})`);
          build.setAttribute('disabled', 'true');
        } else if (heldWorkforce + def.workforce > workforceCapacity) {
          build.setText(`نیروی کار کافی نیست (${faNum(def.workforce)})`);
          build.setAttribute('disabled', 'true');
        } else {
          build.setText('ساخت');
          build.onClick(() => {
            this.send({ type: 'economy.buildMode', typeId: def.id });
            this.send({ type: 'ui.closeScreen', screenId: 'president' });
          });
        }
        row.appendChild(build);
        rows.push(row);
      }
      return rows;
    });
  }

  /** Rebuilds the export-request list + the contract list on real change. */
  private refreshContracts(countryId: string): void {
    this.rebuildRequests(countryId);
    const context = this.context;
    if (context === undefined || context === null) return;
    const config = context.data.economyData.strategicResources;
    const state = context.state;
    const contracts = activeContractsOf(state, countryId);
    const signature = contracts
      .map((contract) =>
        [
          contract.id,
          contract.status,
          contract.amountPerMonth,
          contract.lastDelivery ?? 0
        ].join(':')
      )
      .join('|') + `#${countryId}`;
    if (signature === this.dynamicSignatures.get('contractList')) return;
    this.dynamicSignatures.set('contractList', signature);
    this.rebuild('contractList', this.parents.get('contractList'), () => {
      const rows: UIElement[] = [];
      if (contracts.length === 0) {
        const empty = this.create('div', 'pd-trade-empty');
        empty.setText('قرارداد فعالی وجود ندارد — از بازار منابع (برگهٔ اقتصاد) قرارداد ماهانه ببندید.');
        rows.push(empty);
      }
      for (const contract of contracts) {
        rows.push(this.contractRow(state, config, contract, countryId));
      }
      return rows;
    });
  }

  /**
   * THE EXPORT REQUESTS (the export-request directive §3) — pending
   * requests first: «کشور X می‌خواهد ماهانه N واحد [good] از کشور شما
   * خریداری کند.» + the president's موافقت / مخالفت; decided requests
   * follow as the decision history. Read straight from the real State —
   * approve/reject send the core commands (the guard lives in Game, not
   * the UI).
   */
  private rebuildRequests(countryId: string): void {
    const context = this.context;
    if (context === undefined || context === null) return;
    const config = context.data.economyData.strategicResources;
    const state = context.state;
    const requests = (state.economy.exportRequests ?? []).filter(
      (entry) => entry.sellerId === countryId
    );
    const resourceName = (id: string): string =>
      config.resources.find((resource) => resource.id === id)?.name ?? id;
    const signature =
      requests
        .map((entry) => [entry.id, entry.status, entry.amountPerMonth].join(':'))
        .join('|') + `#${countryId}`;
    if (signature === this.dynamicSignatures.get('requests')) return;
    this.dynamicSignatures.set('requests', signature);
    this.rebuild('requests', this.parents.get('requests'), () => {
      const rows: UIElement[] = [];
      if (requests.length === 0) {
        const empty = this.create('div', 'pd-trade-empty');
        empty.setText('هیچ درخواست صادراتی باز یا بسته‌ای وجود ندارد.');
        rows.push(empty);
        return rows;
      }
      const pending = requests.filter((entry) => entry.status === 'pending');
      const decided = requests.filter((entry) => entry.status !== 'pending');
      for (const request of pending) {
        // The request is sized against the seller's offer AT FILING TIME —
        // the CURRENT remaining offer decides whether approving can sign
        // (the same function the core re-checks on approval; shown honestly).
        const satisfiable =
          remainingSaleOfferOf(state, countryId, request.resourceId, config) >=
          request.amountPerMonth;
        const card = this.create('div', 'pd-request pending');
        const head = this.create('div', 'pd-request-head');
        const buyer = this.create('span', 'pd-request-name');
        buyer.setText(state.countries.countries[request.buyerId]?.name ?? request.buyerId);
        head.appendChild(buyer);
        const chip = this.create('span', 'pd-request-status pending');
        chip.setText('در انتظار پاسخ');
        head.appendChild(chip);
        card.appendChild(head);
        const body = this.create('div', 'pd-request-body');
        body.setText(
          `کشور ${state.countries.countries[request.buyerId]?.name ?? request.buyerId} می‌خواهد ماهانه ${faNum(request.amountPerMonth)} واحد ${resourceName(request.resourceId)} از کشور شما خریداری کند.`
        );
        card.appendChild(body);
        const price = this.create('div', 'pd-request-detail');
        price.setText(
          `قیمت هر واحد: ${faNum(request.price, request.price % 1 !== 0 ? 1 : 0)} · درآمد ماهانهٔ تقریبی: ${faNum(Math.round(request.amountPerMonth * request.price))}`
        );
        card.appendChild(price);
        const actions = this.create('div', 'pd-request-actions');
        const approve = this.create('button', 'pd-request-approve');
        if (!satisfiable) {
          // The offer shrank since the filing — approving would sign
          // nothing; say so INSTEAD of a silent dead button.
          approve.setText('عرضهٔ کافی نیست');
          approve.setAttribute('disabled', 'true');
        } else {
          approve.setText('موافقت');
          approve.onClick(() =>
            this.send({ type: 'economy.approveExportRequest', requestId: request.id })
          );
        }
        actions.appendChild(approve);
        const reject = this.create('button', 'pd-request-reject');
        reject.setText('مخالفت');
        reject.onClick(() =>
          this.send({ type: 'economy.rejectExportRequest', requestId: request.id })
        );
        actions.appendChild(reject);
        card.appendChild(actions);
        rows.push(card);
      }
      for (const request of decided) {
        const card = this.create('div', `pd-request ${request.status}`);
        const head = this.create('div', 'pd-request-head');
        const buyer = this.create('span', 'pd-request-name');
        buyer.setText(state.countries.countries[request.buyerId]?.name ?? request.buyerId);
        head.appendChild(buyer);
        const chip = this.create('span', `pd-request-status ${request.status}`);
        chip.setText(request.status === 'approved' ? 'موافقت شد' : 'مخالفت شد');
        head.appendChild(chip);
        card.appendChild(head);
        const body = this.create('div', 'pd-request-detail');
        body.setText(
          `${faNum(request.amountPerMonth)} واحد ${resourceName(request.resourceId)} / ماه`
        );
        card.appendChild(body);
        rows.push(card);
      }
      return rows;
    });
  }

  /** ONE contract's display row (spec §8's full information block). */
  private contractRow(
    state: GameState,
    config: StrategicResourcesConfig,
    contract: TradeContract,
    countryId: string
  ): UIElement {
    const countryName = (id: string): string => state.countries.countries[id]?.name ?? id;
    const resourceName = config.resources.find((resource) => resource.id === contract.resourceId)?.name ?? contract.resourceId;
    const importing = contract.buyerId === countryId;
    const partner = importing ? contract.sellerId : contract.buyerId;
    const card = this.create('div', 'pd-contract');
    const head = this.create('div', 'pd-contract-head');
    const name = this.create('span', 'pd-contract-name');
    name.setText(`${countryName(partner)}`);
    head.appendChild(name);
    const direction = this.create('span', `pd-contract-direction ${importing ? 'in' : 'out'}`);
    direction.setText(importing ? 'واردات' : 'صادرات');
    head.appendChild(direction);
    const status = this.create('span', 'pd-contract-status active');
    status.setText('فعال');
    head.appendChild(status);
    card.appendChild(head);
    const lines = [
      `کالا: ${resourceName}`,
      `مقدار: ${faNum(contract.amountPerMonth)} واحد / ماه`,
      `قیمت هر واحد: ${faNum(contract.price, contract.price % 1 !== 0 ? 1 : 0)}`,
      `نوع: دائمی — تا زمان لغو`,
      `آخرین تحویل واقعی: ${faNum(contract.lastDelivery ?? 0)} واحد`
    ];
    for (const line of lines) {
      const detail = this.create('div', 'pd-contract-detail');
      detail.setText(line);
      card.appendChild(detail);
    }
    const cancel = this.create('button', 'pd-contract-cancel');
    cancel.setText('لغو قرارداد');
    cancel.onClick(() =>
      this.send({ type: 'economy.cancelContract', countryId, contractId: contract.id })
    );
    card.appendChild(cancel);
    return card;
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
    minus.onClick(() => this.stepBudgetShare(countryId, pool, -0.1));
    plus.onClick(() => this.stepBudgetShare(countryId, pool, +0.1));
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
    // The §12 ledger — every number straight from the ONE finance record.
    const state = context.state;
    const config = context.data.economyData.strategicResources;
    const finance = state.economy.finance[countryId];
    const treasury = state.economy.treasury[countryId] ?? 0;
    const country = state.countries.countries[countryId];
    const government = state.government.countries[countryId];
    const taxRate = government !== undefined ? TAX_LEVEL_SPECS[government.budget.tax].rate : 0;
    const record = state.economy.resources[countryId];
    this.rows.get('ledger.پول خزانه')?.setText(faNum(Math.round(treasury)));
    this.rows.get('ledger.جمعیت')?.setText(faPopulation(country?.population ?? 0));
    // The 0-100 ECONOMY LEVEL (spec §3) + the country's strongest good
    // (spec §4) — both read straight from state/config, never stored twice.
    const level = Math.round(state.economy.economyLevel[countryId] ?? config.economyLevel.start);
    this.rows.get('ledger.وضعیت اقتصاد')?.setText(`${faNum(level)} از ۱۰۰`);
    const production = record?.production ?? {};
    const best = [...config.resources].sort(
      (a, b) => (production[b.id] ?? 0) - (production[a.id] ?? 0)
    )[0];
    const bestAmount = best !== undefined ? Math.round(production[best.id] ?? 0) : 0;
    this.rows.get('ledger.تخصص')?.setText(
      best !== undefined && bestAmount > 0 ? `${best.name} (+${faNum(bestAmount)} / ماه)` : '—'
    );
    for (const resource of config.resources) {
      const stock = Math.round(record?.stock[resource.id] ?? 0);
      this.rows.get(`ledger.${resource.name}`)?.setText(faNum(stock));
    }
    this.rows.get('ledger.نرخ مالیات')?.setText(percent(taxRate));
    if (finance !== undefined) {
      this.rows.get('income.مالیات')?.setText(faSigned(Math.round(finance.lastTaxIncome)));
      this.rows.get('income.تجارت')?.setText(faSigned(Math.round(finance.lastTradeIncome)));
      this.rows.get('expense.ارتش')?.setText(faSigned(-Math.round(finance.lastArmyExpense)));
      this.rows.get('expense.دولت')?.setText(faSigned(-Math.round(finance.lastGovernmentExpense)));
      this.rows.get('expense.زیرساخت')?.setText(faSigned(-Math.round(finance.lastInfrastructureExpense)));
      this.rows.get('expense.تغییر خزانه')?.setText(faSigned(Math.round(finance.lastBalance)));
    }
    this.rebuildResources(countryId);
    this.rebuildConstruction(countryId);
    this.rebuildMarket(countryId);
  }

  /**
   * The resource cards (spec §16): numeric UNITS only, one card per
   * resource — موجودی · تولید +X / ماه · مصرف Y / ماه. The small status
   * chip appears ONLY when it matters (کمبود / مازاد) — a quiet country
   * shows no badge at all, and a real shortage gets a buy button (the
   * §10 loop's خرید step).
   */
  private rebuildResources(countryId: string): void {
    const context = this.context;
    if (context === undefined || context === null) return;
    const config = context.data.economyData.strategicResources;
    const state = context.state;
    const record = state.economy.resources[countryId];
    // Signature guard: only rebuild the cards when a number actually moved
    // (keeps the DOM stable for clicks between the 15-frame refreshes).
    const signature = record === undefined ? 'none' : config.resources.map((resource) => {
      const id = resource.id;
      return [
        Math.round(record.stock[id] ?? 0),
        Math.round(record.production[id] ?? 0),
        Math.round(record.consumption[id] ?? 0),
        Math.round(record.shortage[id] ?? 0)
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
        const shortage = Math.round(record.shortage[resourceId] ?? 0);
        // The status is DERIVED from the real numbers (one source of truth):
        // an uncovered deficit is a shortage, a meaningful net flow + a real
        // stock buffer is a surplus — balanced shows NO chip: quiet = healthy.
        const status = resourceDisplayStatusOf(record, resourceId, config.displayStatus);

        const card = this.create('div', `pd-resource ${status === 'shortage' ? STATUS_VISUALS.shortage.css : status === 'surplus' ? STATUS_VISUALS.surplus.css : ''}`);
        const head = this.create('div', 'pd-resource-head');
        const name = this.create('span', 'pd-resource-name');
        name.setText(resource.name);
        head.appendChild(name);
        if (status !== 'balanced') {
          const chip = this.create('span', `pd-resource-chip ${STATUS_VISUALS[status].css}`);
          chip.setText(STATUS_VISUALS[status].label);
          head.appendChild(chip);
        }
        card.appendChild(head);

        // — the §16 card: stock, production, consumption + a shortage line —
        const lines: string[] = [
          `موجودی: ${faNum(stock)}`,
          `تولید: +${faNum(production)} / ماه`,
          `مصرف: ${faNum(consumption)} / ماه`
        ];
        if (shortage > 0) lines.push(`کمبود: ${faNum(shortage)}`);
        for (const line of lines) {
          const detail = this.create('div', 'pd-resource-detail');
          detail.setText(line);
          card.appendChild(detail);
        }
        if (shortage > 0) {
          const buy = this.create('button', 'pd-resource-buy');
          buy.setText('خرید منابع');
          buy.onClick(() => this.openMarket(resourceId));
          card.appendChild(buy);
        }
        rows.push(card);
      }
      return rows;
    });
  }

  /**
   * The CONSTRUCTION section (spec §1) — the build flow is EXACTLY the
   * directive's: click ساخت → the build mode activates (the dashboard
   * closes so the map is free) → the player clicks ONE grid cell of their
   * OWN country → the building is placed exactly there. Cost and effect
   * are shown BEFORE the click; one region holds one economic building.
   */
  private rebuildConstruction(countryId: string): void {
    const context = this.context;
    if (context === undefined || context === null) return;
    const config = context.data.economyData.strategicResources;
    const state = context.state;
    const construction = state.economy.construction[countryId];
    const projects = construction?.projects ?? [];
    const treasury = Math.floor(state.economy.treasury[countryId] ?? 0);
    const record = state.economy.resources[countryId];
    const materialsStock = Math.round(record?.stock.industrial ?? 0);
    const heldWorkforce = workforceUsedBy(state, countryId, config);
    const workforceCapacity = workforceCapacityOf(state, countryId, config);
    const gridIdOf = (cellKey: string): string => cellKey.slice(cellKey.indexOf('#') + 1);
    const signature =
      JSON.stringify(projects.map((project) => [project.id, project.typeId, project.progress, project.cellKey])) +
      `#${projects.length}#${treasury}#${materialsStock}#${heldWorkforce}#${workforceCapacity}#${state.map.buildMode ?? ''}#${state.map.buildPreview?.cellKey ?? ''}`;
    if (signature === this.dynamicSignatures.get('construction')) return;
    this.dynamicSignatures.set('construction', signature);
    this.rebuild('construction', this.parents.get('construction'), () => {
      const rows: UIElement[] = [];
      // — the ACTIVE BUILD MODE hint (spec §1.1/1.2) — the placement is
      //   done ON THE MAP; the hint names the building and the cost again.
      const buildModeType = state.map.buildMode;
      if (buildModeType !== null) {
        const def = config.buildings.find((candidate) => candidate.id === buildModeType);
        const hint = this.create('div', 'pd-build-hint');
        hint.setText(
          `حالت ساخت فعال: ${def?.name ?? buildModeType} — یک خانهٔ شبکه از کشور خود را روی نقشه انتخاب کنید` +
            (def !== undefined ? ` (هزینه ${faNum(def.cost)})` : '')
        );
        const cancel = this.create('button', 'pd-build-cancel');
        cancel.setText('لغو ساخت');
        cancel.onClick(() => this.send({ type: 'economy.buildMode', typeId: null }));
        hint.appendChild(cancel);
        rows.push(hint);
      }
      // — active projects (top): the MONTHS REMAINING (spec §1.9/§1.15 —
      //   construction time is shown ONLY in months, never a percentage)
      //   + the cell they are built on —
      for (const project of projects) {
        const def = config.buildings.find((candidate) => candidate.id === project.typeId);
        if (def === undefined) continue;
        const card = this.create('div', 'pd-project');
        const head = this.create('div', 'pd-project-head');
        const name = this.create('span', 'pd-project-name');
        name.setText(`${def.name} — منطقه ${gridIdOf(project.cellKey)}`);
        head.appendChild(name);
        const remaining = projectMonthsRemaining(
          project.progress,
          def.buildMonths,
          constructionSpeedFactorOf(state, countryId)
        );
        const progress = this.create('span', 'pd-project-progress');
        progress.setText(`باقی‌مانده: ${faNum(remaining)} ماه`);
        head.appendChild(progress);
        card.appendChild(head);
        const status = this.create('div', 'pd-project-status running');
        status.setText('در حال ساخت');
        card.appendChild(status);
        rows.push(card);
      }
      // — the buildable buildings (bottom) — the FULL cost block BEFORE
      //   building (spec §4): money + materials + workforce + months + the
      //   base output; ساخت starts the placement mode —
      const workHead = this.create('div', 'pd-buildable-detail');
      workHead.setText(`ظرفیت ساخت: ${faNum(projects.length)}/${faNum(config.construction.maxProjects)} · نیروی کار ساخت: ${faNum(heldWorkforce)} از ${faNum(workforceCapacity)} · مصالح (کالاهای صنعتی): ${faNum(materialsStock)}`);
      rows.push(workHead);
      for (const def of config.buildings) {
        // MILITARY buildings live in the نظامی tab (the military directive
        // §4) — the economy tab lists the production buildings only.
        if (def.kind === 'military' || def.resource === undefined) continue;
        const row = this.create('div', 'pd-buildable');
        const info = this.create('div', 'pd-buildable-info');
        const name = this.create('span', 'pd-buildable-name');
        name.setText(def.name);
        info.appendChild(name);
        const effect = `تولید پایه +${faNum(def.output)} ${this.resourceName(config, def.resource)} / ماه`;
        const detail = this.create('div', 'pd-buildable-detail');
        detail.setText(
          `هزینه: ${faNum(def.cost)} پول · ${faNum(def.materials)} مصالح · نیروی کار ${faNum(def.workforce)} · مدت ساخت ${faNum(def.buildMonths)} ماه → ${effect}`
        );
        info.appendChild(detail);
        row.appendChild(info);
        const build = this.create('button', 'pd-build');
        const atCap = projects.length >= config.construction.maxProjects;
        const tooExpensive = treasury < def.cost;
        const noMaterials = materialsStock < def.materials;
        const noWorkforce = heldWorkforce + def.workforce > workforceCapacity;
        if (state.map.buildMode === def.id) {
          build.setText('در حال انتخاب منطقه…');
          build.setAttribute('disabled', 'true');
        } else if (atCap) {
          build.setText('ظرفیت ساخت پُر است');
          build.setAttribute('disabled', 'true');
        } else if (tooExpensive) {
          build.setText(`پول کافی نیست (${faNum(def.cost)})`);
          build.setAttribute('disabled', 'true');
        } else if (noMaterials) {
          build.setText(`مصالح کافی نیست (${faNum(def.materials)})`);
          build.setAttribute('disabled', 'true');
        } else if (noWorkforce) {
          build.setText(`نیروی کار کافی نیست (${faNum(def.workforce)})`);
          build.setAttribute('disabled', 'true');
        } else {
          build.setText('ساخت');
          build.onClick(() => {
            // ACTIVATE THE BUILD MODE (core state): map clicks now PREVIEW
            // the region (quality + estimated output, then تأیید). The
            // dashboard closes so the map is reachable.
            this.send({ type: 'economy.buildMode', typeId: def.id });
            this.send({ type: 'ui.closeScreen', screenId: 'president' });
          });
        }
        row.appendChild(build);
        rows.push(row);
      }
      return rows;
    });
  }

  /** Persian display name of ONE resource id (config-driven). */
  private resourceName(config: { resources: readonly { id: string; name: string }[] }, resourceId: string): string {
    return config.resources.find((resource) => resource.id === resourceId)?.name ?? resourceId;
  }
  /**
   * The MARKET (spec §1-§5/§24) — opens ONLY on demand, shows ONLY the
   * resources that are actually needed (a focused shortage resource, or
   * the missing resources of the waiting construction projects). Each need
   * lists ONLY the sellers with a REAL available surplus (their own stock
   * above the safety reserve, minus the export capacity they have already
   * committed in active contracts — §2/§3/§16). The offers NEVER depend on
   * the buyer's shortage (§1) — the amount on each row is the seller's
   * own real surplus, and the button signs a MONTHLY CONTRACT (spec §6 —
   * buying is never a one-time purchase; it delivers every month until
   * cancelled, §18).
   */
  private openMarket(focus: string | null): void {
    this.marketOpen = true;
    this.marketFocus = focus;
    this.dynamicSignatures.delete('market');
    this.refresh();
  }

  private closeMarket(): void {
    this.marketOpen = false;
    this.marketFocus = null;
    this.dynamicSignatures.delete('market');
    this.refresh();
  }

  private rebuildMarket(countryId: string): void {
    const context = this.context;
    if (context === undefined || context === null) return;
    const config = context.data.economyData.strategicResources;
    const state = context.state;
    const record = state.economy.resources[countryId];
    if (this.marketTitle !== null) {
      this.marketTitle.setAttribute('style', this.marketOpen ? '' : 'display:none;');
    }
    if (!this.marketOpen || record === undefined) {
      if ((this.dynamic.get('market') ?? []).length > 0) {
        this.rebuild('market', this.parents.get('market'), () => []);
        this.dynamicSignatures.delete('market');
      }
      return;
    }
    const countryName = (id: string): string => state.countries.countries[id]?.name ?? id;
    // THE MARKET SHOWS THE SELLERS' FIXED SALE QUANTITIES (the sale-quantity
    // directive): EVERY tradable good is listed — each seller row carries
    // the amount THAT country has put up for sale (its real quota, derived
    // only from its own stock/reserve/commitments) — visible and computable
    // with NO reference to this country's needs. The buyer's recorded
    // shortage is shown as the BUYER's want («نیاز شما»), and the buy
    // button signs min(want, the seller's remaining offer) — demand above
    // the offer cannot inflate it; the remainder stays with the seller for
    // later deals.
    const entries = config.resources.map((resource) => ({
      resourceId: resource.id,
      need: Math.max(0, Math.round(record.shortage[resource.id] ?? 0))
    }));
    // The focused resource first, then the hungriest needs; Array.sort is
    // stable, so equal keys keep the config order (deterministic).
    entries.sort((a, b) => {
      const focusedA = a.resourceId === this.marketFocus ? 0 : 1;
      const focusedB = b.resourceId === this.marketFocus ? 0 : 1;
      return focusedA - focusedB || b.need - a.need;
    });

    const signature = `${this.marketFocus ?? 'all'}|${entries.map((entry) => {
      const offers = marketOffersOf(state, countryId, entry.resourceId, config);
      return `${entry.resourceId}:${Math.round(entry.need)}:[${offers.map((s) => `${s.countryId}=${s.amount}`).join(',')}]`;
    }).join('|')}#${countryId}`;
    if (signature === this.dynamicSignatures.get('market')) return;
    this.dynamicSignatures.set('market', signature);
    this.rebuild('market', this.parents.get('market'), () => {
      const rows: UIElement[] = [];
      const note = this.create('div', 'pd-purchase-hint');
      note.setText('مقدار فروش هر کشور ثابت و محدود است — مستقل از نیاز شما؛ خرید فقط تا همان سهمیه انجام می‌شود.');
      rows.push(note);
      for (const entry of entries) {
        const resource = config.resources.find((candidate) => candidate.id === entry.resourceId);
        if (resource === undefined) continue;
        // REAL market offers only (the sale-quantity directive + §3/§24):
        // each seller's REMAINING sale quota, largest first — never shaped
        // by this country's need.
        const offers = marketOffersOf(state, countryId, entry.resourceId, config);
        const price = unitPriceOf(config, entry.resourceId);
        const block = this.create('div', 'pd-purchase');
        const head = this.create('div', 'pd-purchase-head');
        const name = this.create('span', 'pd-purchase-name');
        name.setText(
          entry.need > 0
            ? `${resource.name} — نیاز شما ${faNum(entry.need)}`
            : `${resource.name}`
        );
        head.appendChild(name);
        const hint = this.create('span', 'pd-purchase-hint');
        hint.setText(`قیمت هر واحد ${faNum(price, price % 1 !== 0 ? 1 : 0)}`);
        head.appendChild(hint);
        block.appendChild(head);
        if (offers.length === 0) {
          const empty = this.create('div', 'pd-purchase-row');
          empty.setText('هیچ کشوری سهمیهٔ فروش آزاد ندارد');
          block.appendChild(empty);
        }
        for (const seller of offers) {
          const row = this.create('div', 'pd-purchase-row');
          const label = this.create('span', 'pd-purchase-seller');
          // THE SELLER'S OWN FIXED SALE QUANTITY (the sale-quantity
          // directive §2/§5/§8) — not this country's need. The number the
          // row shows is the SELLER'S real, variable offer — never the
          // buyer's want.
          label.setText(`${countryName(seller.countryId)} — عرضه فروش: ${faNum(seller.amount)} واحد در ماه`);
          row.appendChild(label);
          // A MONTHLY CONTRACT (§6): the buyer's want capped by the
          // seller's remaining offer — demand beyond the quota buys
          // nothing extra, and the rest of the quota stays for later deals
          // (signing reserves it, §16). A good the player does not NEED
          // shows no purchase amount at all (the sale-quantity directive:
          // a "1" on every row read as if every seller sold one unit).
          const sign = this.create('button', 'pd-buy');
          if (entry.need <= 0) {
            sign.setText('بدون نیاز خرید');
            sign.setAttribute('disabled', 'true');
          } else {
            const amount = Math.min(seller.amount, Math.ceil(entry.need));
            sign.setText(`قرارداد ماهانه ${faNum(amount)}`);
            sign.onClick(() =>
              this.send({
                type: 'economy.signContract',
                countryId,
                sellerId: seller.countryId,
                resourceId: entry.resourceId,
                amountPerMonth: amount
              })
            );
          }
          row.appendChild(sign);
          block.appendChild(row);
        }
        rows.push(block);
      }
      const close = this.create('button', 'pd-market-close');
      close.setText('بستن بازار');
      close.onClick(() => this.closeMarket());
      rows.push(close);
      return rows;
    });
  }

  private refreshBudget(countryId: string): void {
    const government = this.context?.state.government.countries[countryId];
    if (government === undefined) return;
    const config = this.economyConfig();
    // The TWO halves of the ONE 100% pool (spec §6) — live from state, in
    // TEN-point steps (the budget directive §1). The economic row carries
    // the REAL production effect (the budget directive §2): the same
    // modifier the monthly cycle applies to every production path, so the
    // president sees exactly what the budget does before/after changing it.
    const economic = government.budget.shares.economic;
    let economicText = percent(economic);
    if (config !== null) {
      const perPoint = config.economicBudget.productionPerPoint;
      const deltaPct = Math.round((economic * 100 - 50) * perPoint * 100);
      const effect =
        deltaPct === 0 ? 'بی‌اثر بر تولید' : deltaPct > 0 ? `تولید +${faNum(deltaPct)}٪` : `تولید −${faNum(-deltaPct)}٪`;
      economicText = `${percent(economic)} · ${effect}`;
    }
    this.rows.get('budget.economic')?.setText(economicText);
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

  /** Budget-pool stepper (the budget directive §1) — ±10 percentage points
   *  of the 100% pool: the budget ONLY ever sits on the 0/10/…/100 grid
   *  (the core's mutator snaps any requested value to the nearest step).
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
  return toFaDigits(`${Math.round(value * 100)}٪`);
}

function money(value: number): string {
  // The SIMPLE money scale (spec §1/§12): plain Persian numbers, no units.
  return faNum(value, Math.abs(value % 1) > 1e-9 ? 1 : 0);
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
