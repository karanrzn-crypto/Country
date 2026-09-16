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
 *
 * Sections (per spec 2.10): Overview · Economy · Budget · Politics ·
 * Government (ministries) · Decisions · Events · Public Opinion · Elections.
 *
 * The UI owns NO simulation state: every value is read from GameState at
 * refresh time, every action goes out as a command (tax/spending/decision/
 * event/ministry). The skeleton is built once per open; dynamic lists
 * (decisions, events, ministries, results) are rebuilt by removing stale
 * elements. Each section keeps its OWN dynamic list so the monthly refresh
 * pass never removes another section's fresh rows.
 */

type SectionId =
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
  overview: 'Overview',
  economy: 'Economy',
  budget: 'Budget',
  politics: 'Politics',
  government: 'Government',
  decisions: 'Decisions',
  events: 'Events',
  opinion: 'Opinion',
  elections: 'Elections'
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
  economy: 'Economy',
  taxes: 'Taxes',
  services: 'Public services',
  corruption: 'Corruption',
  security: 'Security'
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

export class PresidentDashboard {
  private context: SystemContext | null = null;
  private readonly tabButtons = new Map<SectionId, UIElement>();
  private readonly sections = new Map<SectionId, UIElement>();
  private readonly dynamic = new Map<string, UIElement[]>();
  private readonly rows = new Map<string, UIElement>();

  constructor(
    private readonly screens: ScreenManager,
    private readonly commands: CommandBus,
    private readonly create: (tag: string, className?: string) => UIElement
  ) {}

  register(context: SystemContext): void {
    this.context = context;
    this.screens.registerScreen('president', (container) => this.build(container));
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
    title.setText('PRESIDENTIAL OFFICE');
    header.appendChild(title);
    const closeButton = this.create('button', 'pd-close');
    closeButton.setText('Close');
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

    this.showSection('overview');
    this.refresh();
  }

  private section(container: UIElement, className: string): UIElement {
    const element = this.create('div', `pd-section ${className}`);
    container.appendChild(element);
    return element;
  }

  private buildOverview(container: UIElement): UIElement {
    const section = this.section(container, 'pd-overview');
    this.addRows(section, ['President', 'Party', 'Term', 'Approval', 'Political support', 'Executive authority', 'Public trust', 'Corruption', 'Protests', 'Urban network'], 'overview.');
    return section;
  }

  private buildEconomy(container: UIElement): UIElement {
    const section = this.section(container, 'pd-economy');
    this.addRows(section, ['GDP (annual)', 'Growth', 'Inflation', 'Unemployment', 'Debt', 'Treasury', 'Revenue / month', 'Spending / month', 'Balance / month', 'Trade balance', 'Population', 'Workforce'], 'economy.');
    const sectorTitle = this.create('div', 'pd-subtitle');
    sectorTitle.setText('SECTORS — output · jobs · productivity');
    section.appendChild(sectorTitle);
    for (const sectorId of SECTOR_ORDER) {
      this.addRow(section, `sector.${sectorId}`, sectorId);
    }
    return section;
  }

  private buildBudget(container: UIElement): UIElement {
    const section = this.section(container, 'pd-budget');

    const taxTitle = this.create('div', 'pd-subtitle');
    taxTitle.setText('TAX RATES');
    section.appendChild(taxTitle);
    for (const category of TAX_CATEGORIES) {
      section.appendChild(this.buildStepperRow(category, 'tax', 0.01));
    }

    const spendTitle = this.create('div', 'pd-subtitle');
    spendTitle.setText('SPENDING — annual share of GDP');
    section.appendChild(spendTitle);
    for (const category of SPENDING_CATEGORIES) {
      section.appendChild(this.buildStepperRow(category, 'spending', 0.005));
    }
    return section;
  }

  private buildPolitics(container: UIElement): UIElement {
    const section = this.section(container, 'pd-politics');
    this.addRows(section, ['Government', 'Parliament seats', 'Protests', 'Strikes'], 'politics.');
    const partiesTitle = this.create('div', 'pd-subtitle');
    partiesTitle.setText('PARTIES — support · seats · role');
    section.appendChild(partiesTitle);
    const parties = this.create('div', 'pd-parties');
    section.appendChild(parties);
    this.track(parties, 'parties');
    return section;
  }

  private buildGovernment(container: UIElement): UIElement {
    const section = this.section(container, 'pd-government');
    const title = this.create('div', 'pd-subtitle');
    title.setText('MINISTRIES — funding drives efficiency');
    section.appendChild(title);
    const list = this.create('div', 'pd-ministries');
    section.appendChild(list);
    this.track(list, 'ministries');
    return section;
  }

  private buildDecisions(container: UIElement): UIElement {
    const section = this.section(container, 'pd-decisions');
    const title = this.create('div', 'pd-subtitle');
    title.setText('PRESIDENTIAL DECISIONS — data-driven registry');
    section.appendChild(title);
    const list = this.create('div', 'pd-decision-list');
    section.appendChild(list);
    this.track(list, 'decisions');
    return section;
  }

  private buildEvents(container: UIElement): UIElement {
    const section = this.section(container, 'pd-events');
    const title = this.create('div', 'pd-subtitle');
    title.setText('PENDING EVENTS — your choice shapes the outcome');
    section.appendChild(title);
    const list = this.create('div', 'pd-event-list');
    section.appendChild(list);
    this.track(list, 'events');
    return section;
  }

  private buildOpinion(container: UIElement): UIElement {
    const section = this.section(container, 'pd-opinion');
    const title = this.create('div', 'pd-subtitle');
    title.setText('PUBLIC OPINION — what the country thinks');
    section.appendChild(title);
    this.addRows(section, OPINION_TOPICS.map((topic) => TOPIC_LABELS[topic]), 'opinion.');
    return section;
  }

  private buildElections(container: UIElement): UIElement {
    const section = this.section(container, 'pd-elections');
    this.addRows(section, ['Status', 'Next election', 'Last election', 'Winner', 'Your party support'], 'elections.');
    const results = this.create('div', 'pd-election-results');
    section.appendChild(results);
    this.track(results, 'results');
    return section;
  }

  /** A labeled row with −/+ steppers wired to a budget command. */
  private buildStepperRow(category: string, kind: 'tax' | 'spending', step: number): UIElement {
    const row = this.create('div', 'pd-stepper');
    const label = this.create('span', 'pd-stepper-label');
    label.setText(category);
    const value = this.create('span', 'pd-stepper-value');
    row.appendChild(label);
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

    this.rows.get('overview.President')?.setText(government.president.name);
    this.rows.get('overview.Party')?.setText(partyName(government, government.president.partyId));
    this.rows.get('overview.Term')?.setText(`${Math.floor(termMonthsLeft / 12)}y ${termMonthsLeft % 12}m left · term ${government.president.termsServed}`);
    this.rows.get('overview.Approval')?.setText(percent(government.president.approval));
    this.rows.get('overview.Political support')?.setText(percent(government.president.politicalSupport));
    this.rows.get('overview.Executive authority')?.setText(percent(government.president.executiveAuthority));
    this.rows.get('overview.Public trust')?.setText(percent(government.politics.publicTrust));
    this.rows.get('overview.Corruption')?.setText(percent(government.politics.corruption));
    this.rows.get('overview.Protests')?.setText(`${government.politics.protests} (pressure ${percent(government.politics.protestPressure)})`);
    this.rows.get('overview.Urban network')?.setText(`${summary.areas} areas · ${summary.links} links · connectivity ${percent(summary.connectivity)}`);
  }

  private refreshEconomy(countryId: string): void {
    const macro = this.context?.state.economy.macro[countryId];
    if (macro === undefined) return;
    const treasury = this.context?.state.economy.treasury[countryId] ?? 0;
    this.rows.get('economy.GDP (annual)')?.setText(money(macro.gdp));
    this.rows.get('economy.Growth')?.setText(percentSigned(macro.gdpGrowth));
    this.rows.get('economy.Inflation')?.setText(percentSigned(macro.inflation));
    this.rows.get('economy.Unemployment')?.setText(percent(macro.unemployment));
    this.rows.get('economy.Debt')?.setText(money(macro.debt));
    this.rows.get('economy.Treasury')?.setText(money(treasury));
    this.rows.get('economy.Revenue / month')?.setText(money(macro.lastRevenue));
    this.rows.get('economy.Spending / month')?.setText(money(macro.lastSpending));
    this.rows.get('economy.Balance / month')?.setText(moneySigned(macro.lastBalance));
    this.rows.get('economy.Trade balance')?.setText(moneySigned(macro.trade.balance));
    this.rows.get('economy.Population')?.setText(number(this.context?.state.countries.countries[countryId]?.population ?? 0));
    this.rows.get('economy.Workforce')?.setText(number(Math.round((this.context?.state.countries.countries[countryId]?.population ?? 0) * 0.52)));
    for (const [sectorId, sector] of Object.entries(macro.sectors)) {
      this.rows.get(`sector.${sectorId}`)?.setText(
        `${money(sector.output)} · ${number(Math.round(sector.jobs))} jobs · ${number(Math.round(sector.productivity))}$/yr`
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
    this.rows.get('politics.Government')?.setText(coalitionNames || 'caretaker');
    const seats = government.politics.parliament.seats;
    const seatSummary = Object.keys(seats).length
      ? Object.entries(seats).map(([partyId, count]) => `${partyName(government, partyId)}: ${count}`).join(' · ')
      : 'not elected yet';
    this.rows.get('politics.Parliament seats')?.setText(seatSummary);
    this.rows.get('politics.Protests')?.setText(government.politics.protests);
    this.rows.get('politics.Strikes')?.setText(
      government.politics.generalStrikeUntilMonth !== null ? `general strike until month ${government.politics.generalStrikeUntilMonth}` : `pressure ${percent(government.politics.strikePressure)}`
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
          `${party.name} — ${percent(party.support)} support · ${Math.round(party.seatShare * government.politics.parliament.seatsTotal)} seats${party.inGovernment ? ' · in government' : ''}`
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
      for (const [ministryId, ministry] of Object.entries(government.ministries)) {
        const def = context.data.ministryTemplateList.find((candidate) => candidate.id === ministryId);
        const row = this.create('div', 'pd-ministry-row');
        const label = this.create('span', 'pd-ministry-name');
        label.setText(`${def?.name ?? ministryId} — efficiency ${percent(ministry.efficiency)}`);
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
        name.setText(`${decision.name} — cost ${money(cost)}${decision.durationMonths > 0 ? ` · ${decision.durationMonths} months` : ''}`);
        const description = this.create('div', 'pd-decision-desc');
        description.setText(`${decision.description}  Effects: ${describeEffects(decision.effects)}`);
        row.appendChild(name);
        row.appendChild(description);
        if (reason === null) {
          const enact = this.create('button', 'pd-enact');
          enact.setText('Enact');
          enact.onClick(() => this.send({ type: 'government.enactDecision', countryId, decisionId: decision.id }));
          row.appendChild(enact);
        } else {
          const reasonText = this.create('div', 'pd-decision-reason');
          reasonText.setText(`Blocked: ${reason}`);
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
        empty.setText('No pending events — the country is calm.');
        rows.push(empty);
        return rows;
      }
      for (const pending of government.events.pending) {
        const def = context.data.eventList.find((candidate) => candidate.id === pending.eventId);
        if (def === undefined) continue;
        const block = this.create('div', 'pd-event');
        const title = this.create('div', 'pd-event-title');
        title.setText(`${def.title} — expires month ${pending.expiresMonth}`);
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
    this.rows.get('elections.Status')?.setText(elections.phase === 'campaigning' ? 'CAMPAIGNING' : 'idle');
    this.rows.get('elections.Next election')?.setText(`month ${elections.nextElectionMonth}`);
    this.rows.get('elections.Last election')?.setText(elections.lastElectionMonth >= 0 ? `month ${elections.lastElectionMonth}` : '—');
    this.rows.get('elections.Winner')?.setText(elections.lastWinnerId !== null ? partyName(government, elections.lastWinnerId) : '—');
    this.rows.get('elections.Your party support')?.setText(percent(government.politics.parties[government.president.partyId]?.support ?? 0));

    this.rebuild('results', this.parents.get('results'), () => {
      const rows: UIElement[] = [];
      if (elections.lastResults !== null) {
        for (const [partyId, share] of Object.entries(elections.lastResults)) {
          const row = this.create('div', 'pd-result-row');
          const party = government.politics.parties[partyId];
          const seats = Math.round((party?.seatShare ?? 0) * government.politics.parliament.seatsTotal);
          row.setText(`${partyName(government, partyId)}: ${percent(share)} · ${seats} seats`);
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
    for (const [id, element] of this.sections) element.setVisible(id === section);
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
  return `${Math.round(value * 100)}%`;
}

function percentSigned(value: number): string {
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;
}

function money(value: number): string {
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(2)}B$`;
  return `${Math.round(value)}M$`;
}

function moneySigned(value: number): string {
  return `${value >= 0 ? '+' : '−'}${money(Math.abs(value))}`;
}

function sentiment(value: number): string {
  const label = value > 0.15 ? 'pleased' : value < -0.15 ? 'angry' : 'content';
  return `${label} (${value >= 0 ? '+' : ''}${Math.round(value * 100)})`;
}

function number(value: number): string {
  return value.toLocaleString('en-US');
}

/** Effect summary: 'mul' always reads as %, money targets in M$, rates in %. */
function describeEffects(effects: readonly EffectDef[]): string {
  return effects
    .map((effect) => {
      const sign = effect.value >= 0 ? '+' : '−';
      const magnitude = Math.abs(effect.value);
      const duration = effect.durationMonths !== undefined && effect.durationMonths > 0 ? ` (${effect.durationMonths}m)` : '';
      // 'mul' is always a percentage modifier; 'add' is M$ for money/sector
      // targets and percentage points for rates (approval, growth, …).
      if (effect.mode === 'mul') {
        return `${effect.target} ${sign}${(magnitude * 100).toFixed(0)}%${duration}`;
      }
      const moneyTargets = ['treasury', 'debt'];
      const isMoney = moneyTargets.includes(effect.target) || effect.target.startsWith('sector.');
      const amount = isMoney ? `${sign}${money(magnitude)}` : `${sign}${(magnitude * 100).toFixed(1)}%`;
      return `${effect.target} ${amount}${duration}`;
    })
    .join(', ');
}
