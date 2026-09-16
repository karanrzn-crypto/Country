import type { CommandBus } from '../core/CommandBus';
import type { SystemContext } from '../core/GameContext';
import type { UIElement } from './adapter/UIDomAdapter';
import type { ScreenManager } from './ScreenManager';
import { MAP_LAYERS, type MapLayerGroup, type MapLayerId } from '../world/map/MapLayers';
import { relationBand } from '../state/slices/countrySlice';
import type { CountryState } from '../state/slices/countrySlice';
import { flagDataUrl } from './flags';
import {
  buildBiomeLegend,
  buildElevationLegend,
  elevationGradientCss,
  elevationLegendSignature,
  legendSignature
} from './biomeLegend';
import type { MapLegendEntry, ElevationLegendData } from './biomeLegend';

/**
 * Strategic map UI (Part 1 + 2 + 3):
 * - country info panel: flag, capital, population, economy, resources,
 *   military and foreign relations — all read from Game State (countrySlice
 *   + static map model); the UI owns no country data;
 * - layer toggle row (each map layer independently switchable);
 * - the 'map' screen lists countries (flag + core stats); clicking selects +
 *   focuses it.
 *
 * UI observes state + sends commands only — it never mutates state directly.
 */
export class MapUI {
  private context: SystemContext | null = null;
  private readonly infoRows: { label: string; value: UIElement }[] = [];
  private infoTitle: UIElement | null = null;
  private detailContainer: UIElement | null = null;
  private basicContainer: UIElement | null = null;
  private detailNodes: {
    flagImg: UIElement;
    name: UIElement;
    rows: Map<string, UIElement>;
    resources: UIElement;
    relations: UIElement;
  } = {
    flagImg: null as unknown as UIElement,
    name: null as unknown as UIElement,
    rows: new Map(),
    resources: null as unknown as UIElement,
    relations: null as unknown as UIElement
  };
  private layerButtons = new Map<MapLayerId, UIElement>();
  private confirmButton: UIElement | null = null;
  private legendContainer: UIElement | null = null;
  private legendRows: UIElement[] = [];
  private legendSignature = '';
  private readonly detailChips: UIElement[] = [];
  private readonly detailRelationRows: UIElement[] = [];

  constructor(
    private readonly screens: ScreenManager,
    private readonly commands: CommandBus,
    private readonly create: (tag: string, className?: string) => UIElement
  ) {}

  /** Called from UIManager.init with the full SystemContext. */
  register(context: SystemContext, root: UIElement): void {
    this.context = context;
    this.buildInfoPanel(root);
    this.buildLegend(root);
    this.screens.registerScreen('map', (container) => this.buildMapScreen(container));
    this.screens.registerScreen('countrySelect', (container) => this.buildCountrySelectScreen(container));
    this.refreshInfo();
  }

  // —— info panel ——

  private buildInfoPanel(root: UIElement): void {
    const panel = this.create('div', 'map-info-panel');
    root.appendChild(panel);

    // —— header: flag + title ——
    const header = this.create('div', 'map-info-header');
    const flagImg = this.create('img', 'map-info-flag');
    flagImg.setAttribute('alt', 'flag');
    header.appendChild(flagImg);
    const title = this.create('div', 'map-info-title');
    header.appendChild(title);
    panel.appendChild(header);
    this.infoTitle = title;

    // —— country detail (Part 2) ——
    const detail = this.create('div', 'map-country-detail');
    const detailName = this.create('div', 'map-country-name');
    detail.appendChild(detailName);
    panel.appendChild(detail);

    const addRow = (parent: UIElement, key: string, className = 'map-info-row'): UIElement => {
      const row = this.create('div', className);
      const keyEl = this.create('span', 'map-info-key');
      keyEl.setText(key);
      const valueEl = this.create('span', 'map-info-value');
      row.appendChild(keyEl);
      row.appendChild(valueEl);
      parent.appendChild(row);
      return valueEl;
    };

    const section = (title: string): UIElement => {
      const el = this.create('div', 'map-section-title');
      el.setText(title);
      detail.appendChild(el);
      return el;
    };

    const rows = new Map<string, UIElement>();
    rows.set('Capital', addRow(detail, 'Capital'));
    rows.set('Population', addRow(detail, 'Population'));
    section('Economy');
    for (const key of ['GDP', 'Treasury', 'Income', 'Expenses'] as const) {
      rows.set(key, addRow(detail, key));
    }
    section('Military');
    for (const key of ['Manpower', 'Army', 'Equipment', 'Aircraft', 'Navy'] as const) {
      rows.set(key, addRow(detail, key));
    }
    section('Resources');
    const resources = this.create('div', 'map-resource-chips');
    detail.appendChild(resources);
    section('Foreign Relations');
    const relations = this.create('div', 'map-relations');
    detail.appendChild(relations);

    this.detailNodes = { flagImg, name: detailName, rows, resources, relations };
    this.detailContainer = detail;

    // —— basic rows (no country selected) ——
    const basic = this.create('div', 'map-country-basic');
    panel.appendChild(basic);
    for (const label of ['Country', 'Provinces', 'Cities', 'Selection']) {
      const row = this.create('div', 'map-info-row');
      const key = this.create('span', 'map-info-key');
      key.setText(label);
      const value = this.create('span', 'map-info-value');
      row.appendChild(key);
      row.appendChild(value);
      basic.appendChild(row);
      this.infoRows.push({ label, value });
    }
    this.basicContainer = basic;

    // —— layer toggles (generated from the data-driven registry) ——
    const layerTitle = this.create('div', 'map-layers-title');
    layerTitle.setText('Layers');
    panel.appendChild(layerTitle);

    const groupOrder: readonly MapLayerGroup[] = ['geography', 'infrastructure', 'society', 'base'];
    for (const group of groupOrder) {
      const defs = MAP_LAYERS.filter((def) => def.group === group);
      if (defs.length === 0) continue;
      const groupRow = this.create('div', 'map-layers');
      for (const def of defs) {
        const button = this.create('button', 'map-layer-toggle');
        button.setText(def.label);
        button.setAttribute('title', `${def.label} (${group})`);
        button.onClick(() => {
          const current = this.context?.state.map.layerVisibility[def.id] ?? true;
          this.commands.send({ type: 'map.setLayerVisible', layer: def.id, visible: !current });
        });
        groupRow.appendChild(button);
        this.layerButtons.set(def.id, button);
      }
      panel.appendChild(groupRow);
    }
  }

  // —— map legends (biomes / elevation) ——

  /**
   * Legend panel at the right edge of the map. Biomes and Terrain are
   * EXCLUSIVE surface layers (layer-state policy), so exactly ONE legend is
   * shown at a time — the one matching the active surface coloring. Rows,
   * colors, labels and the elevation gradient all come from the legend
   * builders (model + theme via the SAME central color definitions the
   * renderer paints with) — the UI owns no biome/terrain data. Content
   * rebuilds only when the signature changes.
   */
  private buildLegend(root: UIElement): void {
    this.legendContainer = this.create('div', 'map-legend');
    root.appendChild(this.legendContainer);
  }

  private refreshLegend(): void {
    const context = this.context;
    if (context === null || this.legendContainer === null) return;
    const visibility = context.state.map.layerVisibility;
    // Exclusive surface layers → at most ONE section is ever active.
    const sections: { title: string; rows?: MapLegendEntry[]; gradient?: ElevationLegendData }[] = [];
    if (visibility.biomes === true) {
      sections.push({ title: 'BIOMES', rows: buildBiomeLegend(context.map, context.data.mapTheme) });
    } else if (visibility.terrain === true) {
      sections.push({ title: 'ELEVATION', gradient: buildElevationLegend(context.data.mapTheme) });
    }
    const visible = sections.length > 0;
    this.legendContainer.setVisible(visible);
    if (!visible) return;
    const signature = sections
      .map((section) =>
        section.rows !== undefined
          ? `${section.title}#${legendSignature(section.rows)}`
          : `${section.title}#${elevationLegendSignature(section.gradient as ElevationLegendData)}`
      )
      .join('||');
    if (signature === this.legendSignature) return;
    this.legendSignature = signature;
    for (const row of this.legendRows) row.remove();
    this.legendRows.length = 0;
    for (const section of sections) {
      const title = this.create('div', 'map-legend-title');
      title.setText(section.title);
      this.legendContainer.appendChild(title);
      this.legendRows.push(title);
      if (section.rows !== undefined) {
        for (const entry of section.rows) {
          const row = this.create('div', 'map-legend-row');
          const swatch = this.create('span', 'map-legend-swatch');
          swatch.setAttribute('style', `background: ${entry.color}`);
          const label = this.create('span', 'map-legend-label');
          label.setText(entry.label);
          row.appendChild(swatch);
          row.appendChild(label);
          this.legendContainer.appendChild(row);
          this.legendRows.push(row);
        }
      } else {
        const gradient = section.gradient as ElevationLegendData;
        const bar = this.create('div', 'map-legend-gradient');
        bar.setAttribute('style', `background: ${elevationGradientCss(gradient.stops)}`);
        this.legendContainer.appendChild(bar);
        this.legendRows.push(bar);
        const labels = this.create('div', 'map-legend-gradient-labels');
        const low = this.create('span', 'map-legend-gradient-label');
        low.setText(gradient.lowLabel);
        const high = this.create('span', 'map-legend-gradient-label');
        high.setText(gradient.highLabel);
        labels.appendChild(low);
        labels.appendChild(high);
        this.legendContainer.appendChild(labels);
        this.legendRows.push(labels);
      }
    }
  }

  /** Re-reads map slice + country slice + model into the panel (observer). */
  refreshInfo(): void {
    const context = this.context;
    if (context === null || this.basicContainer === null) return;
    const state = context.state.map;
    const model = context.map;
    const countrySlice = context.state.countries.countries;

    const selectedCountryId = state.selectedCountryId;
    const country =
      selectedCountryId !== null ? model.countries[selectedCountryId] : undefined;
    const countryState: CountryState | undefined =
      selectedCountryId !== null ? countrySlice[selectedCountryId] : undefined;
    const province =
      state.selectedProvinceId !== null ? model.provinces[state.selectedProvinceId] : undefined;
    const city = state.selectedCityId !== null ? model.cities[state.selectedCityId] : undefined;

    const hasDetail = country !== undefined && countryState !== undefined;
    this.detailContainer?.setVisible(hasDetail);
    this.basicContainer.setVisible(!hasDetail);
    // The flag asset only exists for a selected country — hide the placeholder.
    this.detailNodes.flagImg.setVisible(hasDetail);

    if (country !== undefined && countryState !== undefined) {
      this.detailNodes.flagImg.setAttribute('src', flagDataUrl(countryState.flag));
      this.detailNodes.name.setText(countryState.name);
      const fill = (key: string, value: string): void => {
        const node = this.detailNodes.rows.get(key);
        if (node !== undefined) node.setText(value);
      };
      const capital =
        countryState.capitalId !== null ? model.cities[countryState.capitalId] : undefined;
      fill('Capital', capital !== undefined ? capital.name : '—');
      fill('Population', formatCompact(countryState.population));
      fill('GDP', `${countryState.economy.gdp}B`);
      fill('Treasury', `${countryState.economy.treasury}`);
      fill('Income', `+${countryState.economy.income}`);
      fill('Expenses', `-${countryState.economy.expenses}`);
      fill('Manpower', formatCompact(countryState.military.manpower));
      fill('Army', formatCompact(countryState.military.armySize));
      fill('Equipment', `${countryState.military.equipment}`);
      fill('Aircraft', `${countryState.military.aircraft}`);
      fill('Navy', `${countryState.military.navy}`);

      this.detailNodes.resources.setText('');
      for (const chip of this.detailChips) chip.remove();
      this.detailChips.length = 0;
      for (const row of this.detailRelationRows) row.remove();
      this.detailRelationRows.length = 0;
      rebuildChips(this.detailNodes.resources, countryState, this.create, this.detailChips);
      rebuildRelations(
        this.detailNodes.relations,
        countryState,
        model,
        countrySlice,
        this.create,
        this.detailRelationRows
      );
    }

    // Basic rows (only visible without a selection, but keep them fresh).
    const values: Record<string, string> = {
      Country: country !== undefined ? country.name : '—',
      Provinces: country !== undefined ? String(country.provinceIds.length) : '—',
      Cities: country !== undefined ? String(country.cityIds.length) : '—',
      Selection:
        city !== undefined
          ? `${city.name} (city, ${city.isCapital ? 'capital' : 'city'})`
          : province !== undefined
            ? `${province.name} (province)`
            : country !== undefined
              ? `${country.name} (country)`
              : 'nothing — click the map'
    };
    for (const row of this.infoRows) {
      row.value.setText(values[row.label] ?? '');
    }

    const title = this.context !== null ? model.continentName.toUpperCase() : 'STRATEGIC MAP';
    this.infoTitle?.setText(`STRATEGIC MAP — ${title}`);

    for (const [layerId, button] of this.layerButtons) {
      const visible = state.layerVisibility[layerId] !== false;
      button.setClass(visible ? 'map-layer-toggle on' : 'map-layer-toggle off');
    }
    this.refreshLegend();
    if (this.confirmButton !== null) {
      const selectable = state.selectedCountryId !== null;
      this.confirmButton.setClass(selectable ? 'screen-confirm' : 'screen-confirm disabled');
    }
  }

  /**
   * Re-reads the confirm button state (selection may change while the
   * country-select screen is open — clicking the map is a valid way to pick).
   */
  refreshCountrySelect(): void {
    if (this.context === null || this.confirmButton === null) return;
    const selectable = this.context.state.map.selectedCountryId !== null;
    this.confirmButton.setClass(selectable ? 'screen-confirm' : 'screen-confirm disabled');
  }

  /** The 'map' screen: flag + core stats per country; click selects + focuses. */
  private buildMapScreen(container: UIElement): void {
    const context = this.context;
    const title = this.create('h2');
    title.setText('Countries');
    container.appendChild(title);
    if (context === null) return;
    this.buildCountryRows(container, (countryId) => {
      this.commands.send({ type: 'map.select', countryId });
      this.commands.send({ type: 'map.focusCountry', countryId });
      this.screens.close('map');
    });
  }

  /**
   * Country-selection screen (Part 3): the player picks their country — by
   * clicking a row here OR by clicking the map — then confirms. All country
   * data comes from the map model + country slice (UI owns no country data).
   */
  private buildCountrySelectScreen(container: UIElement): void {
    const context = this.context;
    const title = this.create('h2');
    title.setText('Choose Your Country');
    container.appendChild(title);
    const subtitle = this.create('div', 'screen-subtitle');
    subtitle.setText('Click a country on the map or pick it from the list, then confirm.');
    container.appendChild(subtitle);
    if (context === null) return;

    this.buildCountryRows(container, (countryId) => {
      this.commands.send({ type: 'map.select', countryId });
      this.commands.send({ type: 'map.focusCountry', countryId });
    });

    const actions = this.create('div', 'screen-actions');
    const confirm = this.create('button', 'screen-confirm');
    confirm.setText('Confirm & Start');
    confirm.onClick(() => {
      const selected = this.context?.state.map.selectedCountryId ?? null;
      if (selected === null) return;
      this.commands.send({ type: 'player.confirmCountry', countryId: selected });
    });
    this.confirmButton = confirm;
    actions.appendChild(confirm);

    const cancel = this.create('button', 'screen-cancel');
    cancel.setText('Back');
    cancel.onClick(() => {
      this.screens.close('countrySelect');
      this.screens.open('mainMenu');
    });
    actions.appendChild(cancel);
    container.appendChild(actions);
    this.refreshCountrySelect();
  }

  /** Shared country-row list (data-driven from the map model + country slice). */
  private buildCountryRows(
    container: UIElement,
    onPick: (countryId: string) => void
  ): void {
    const context = this.context;
    if (context === null) return;
    const list = this.create('div', 'map-country-list');
    for (const countryId of context.map.countryOrder) {
      const country = context.map.countries[countryId];
      const countryState = context.state.countries.countries[countryId];
      if (countryState === undefined) continue;
      const capital = context.map.cities[country.capitalCityId];
      const button = this.create('button', 'map-country-row');
      const flag = this.create('img', 'map-row-flag');
      flag.setAttribute('alt', '');
      flag.setAttribute('src', flagDataUrl(countryState.flag));
      button.appendChild(flag);
      const label = this.create('span');
      label.setText(
        `${countryState.name} — capital ${capital.name}, ${formatCompact(countryState.population)}` +
          `${country.coastal ? '' : ' (landlocked)'}`
      );
      button.appendChild(label);
      button.onClick(() => onPick(country.id));
      list.appendChild(button);
    }
    container.appendChild(list);
  }
}

// —— formatting + small DOM builders (module-scope, DOM-free logic where possible) ——

export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${trim(value / 1_000_000_000)}B`;
  if (abs >= 1_000_000) return `${trim(value / 1_000_000)}M`;
  if (abs >= 10_000) return `${trim(value / 1_000)}k`;
  return String(Math.round(value));
}

function trim(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function rebuildChips(
  container: UIElement,
  countryState: CountryState,
  create: (tag: string, className?: string) => UIElement,
  tracker: UIElement[]
): void {
  const entries = Object.entries(countryState.resources).sort((a, b) => b[1] - a[1]);
  for (const [resourceId, amount] of entries.slice(0, 6)) {
    const chip = create('span', 'map-resource-chip');
    chip.setText(`${resourceId} ${amount}`);
    container.appendChild(chip);
    tracker.push(chip);
  }
  if (entries.length === 0) {
    const empty = create('span', 'map-resource-chip empty');
    empty.setText('none');
    container.appendChild(empty);
    tracker.push(empty);
  }
}

function rebuildRelations(
  container: UIElement,
  countryState: CountryState,
  model: SystemContext['map'],
  countrySlice: Readonly<Record<string, CountryState>>,
  create: (tag: string, className?: string) => UIElement,
  tracker: UIElement[]
): void {
  const entries = Object.entries(countryState.foreignRelations).sort(
    (a, b) => Math.abs(b[1]) - Math.abs(a[1]) || a[0].localeCompare(b[0])
  );
  for (const [otherId, value] of entries.slice(0, 6)) {
    const otherProfile = countrySlice[otherId];
    const row = create('div', 'map-relation-row');
    const name = create('span', 'map-relation-name');
    name.setText(otherProfile !== undefined ? otherProfile.name : model.countries[otherId]?.name ?? otherId);
    const band = create('span', `map-relation-band band-${relationBand(value)}`);
    band.setText(`${relationBand(value)} ${value > 0 ? '+' : ''}${value}`);
    row.appendChild(name);
    row.appendChild(band);
    container.appendChild(row);
    tracker.push(row);
  }
  if (entries.length === 0) {
    const empty = create('span', 'map-relation-empty');
    empty.setText('no established relations');
    container.appendChild(empty);
    tracker.push(empty);
  }
}
