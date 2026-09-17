import type { CommandBus } from '../core/CommandBus';
import type { SystemContext } from '../core/GameContext';
import type { UIElement } from './adapter/UIDomAdapter';
import type { ScreenManager } from './ScreenManager';
import { MAP_LAYERS, type MapLayerGroup, type MapLayerId } from '../world/map/MapLayers';
import { relationBand } from '../state/slices/countrySlice';
import type { CountryState } from '../state/slices/countrySlice';
import { flagDataUrl } from './flags';
import { describeGridCell, describeProvince } from '../world/map/MapGeography';
import { selectionSummary } from '../state/slices/mapSlice';
import { cityResourceProduction } from '../economy/resources';
import type { StrategicResourcesConfig } from '../economy/types';
import { cityConnectionsOf, connectionsOfCity, connectionOtherCity, connectionLengthKm } from '../world/cityareas/CityConnections';
import type { CityConnection } from '../world/cityareas/CityConnections';
import {
  buildBiomeLegend,
  buildElevationLegend,
  elevationGradientCss,
  elevationLegendSignature,
  legendSignature
} from './biomeLegend';
import type { MapLegendEntry, ElevationLegendData } from './biomeLegend';

/**
 * Strategic map UI (Part 1 + 2 + 3) — all player-facing text in PERSIAN:
 * - country info panel: flag, capital, population, economy, resources,
 *   military and foreign relations — all read from Game State (countrySlice
 *   + static map model); the UI owns no country data;
 * - layer toggle row (each map layer independently switchable);
 * - the region-selection mode segment (country ⇄ province land-click pick);
 * - the 'map' screen lists countries (flag + core stats); clicking selects +
 *   focuses it.
 *
 * UI observes state + sends commands only — it never mutates state directly.
 */

// —— Persian display vocabularies (kind/enum ids → readable labels) ——

const TERRAIN_LABELS: Readonly<Record<string, string>> = {
  lowland: 'جلگه',
  valley: 'دره',
  plains: 'دشت',
  plateau: 'فلات',
  hills: 'تپه‌ها',
  mountain: 'کوهستان',
  highMountain: 'کوه‌های بلند'
};

const CITY_TYPE_LABELS: Readonly<Record<string, string>> = {
  capital: 'پایتخت',
  major: 'کلان‌شهر',
  medium: 'شهر متوسط',
  small: 'شهر کوچک',
  settlement: 'آبادی'
};

const SITE_KIND_LABELS: Readonly<Record<string, string>> = {
  port: 'بندر',
  farm: 'مزرعه',
  factory: 'کارخانه',
  mine: 'معدن',
  oil: 'چاه نفت',
  lumber: 'جنگل‌داری',
  base: 'پایگاه نظامی',
  airbase: 'پایگاه هوایی'
};

/** Persian display name of a resource id (data-driven — unknown ids pass through). */
function resourceLabel(config: StrategicResourcesConfig, resourceId: string): string {
  return config.resources.find((resource) => resource.id === resourceId)?.name ?? resourceId;
}

const BUILDING_KIND_LABELS: Readonly<Record<string, string>> = {
  residential: 'مسکونی',
  industrial: 'صنعتی',
  commercial: 'تجاری',
  government: 'دولتی',
  hospital: 'بیمارستان',
  militaryBase: 'پایگاه نظامی',
  airport: 'فرودگاه',
  port: 'بندر',
  railwayStation: 'ایستگاه راه‌آهن',
  power: 'نیروگاه'
};

const RIVER_MOUTH_LABELS: Readonly<Record<string, string>> = {
  ocean: 'دریا',
  lake: 'دریاچه',
  river: 'رودخانهٔ بزرگ‌تر'
};

const RELATION_BAND_LABELS: Readonly<Record<string, string>> = {
  hostile: 'متخاصم',
  wary: 'محتاط',
  neutral: 'بی‌طرف',
  cordial: 'صمیمی',
  friendly: 'دوستانه'
};

export class MapUI {
  private context: SystemContext | null = null;
  private readonly infoRows: { label: string; value: UIElement }[] = [];
  private infoTitle: UIElement | null = null;
  private detailContainer: UIElement | null = null;
  private basicContainer: UIElement | null = null;
  private featureContainer: UIElement | null = null;
  private featureTitle: UIElement | null = null;
  private featureRows: UIElement[] = [];
  private featureSignature = '';
  private hoverTip: UIElement | null = null;
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
  private modeButtons: { country: UIElement; province: UIElement } | null = null;
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
    // Ephemeral hover tip (event-driven — the core resolves, the UI shows):
    // `A3 — Province X`, a river/lake/city name, or hidden when over nothing.
    context.events.on('map.hoverChanged', ({ hover }) => {
      if (this.hoverTip === null) return;
      if (hover === null) {
        this.hoverTip.setVisible(false);
        return;
      }
      const model = context.map;
      const provinceName = (provinceId: string | null): string =>
        provinceId !== null ? (model.provinces[provinceId]?.name ?? provinceId) : '—';
      let text: string | null = null;
      if (hover.cityId !== null) {
        const city = model.cities[hover.cityId];
        text = `${city.name} — ${provinceName(city.provinceId)}`;
      } else if (hover.riverId !== null) {
        text = model.features.rivers.find((river) => river.id === hover.riverId)?.name ?? null;
      } else if (hover.lakeId !== null) {
        text = model.features.lakes.find((lake) => lake.id === hover.lakeId)?.name ?? null;
      } else if (hover.siteId !== null) {
        const site = model.features.sites.find((candidate) => candidate.id === hover.siteId);
        text = site !== undefined
          ? `${SITE_KIND_LABELS[site.kind] ?? site.kind} — ${provinceName(site.cityId !== null ? model.cities[site.cityId].provinceId : null)}`
          : null;
      } else if (hover.gridCellKey !== null) {
        const gridId = hover.gridCellKey.slice(hover.gridCellKey.indexOf('#') + 1);
        text = `${gridId} — ${provinceName(hover.provinceId)}`;
      }
      if (text === null) {
        this.hoverTip.setVisible(false);
        return;
      }
      this.hoverTip.setText(text);
      this.hoverTip.setVisible(true);
    });
    this.refreshInfo();
  }

  // —— info panel ——

  private buildInfoPanel(root: UIElement): void {
    const panel = this.create('div', 'map-info-panel');
    root.appendChild(panel);

    // —— header: flag + title ——
    const header = this.create('div', 'map-info-header');
    const flagImg = this.create('img', 'map-info-flag');
    flagImg.setAttribute('alt', 'پرچم');
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

    const addRow = (parent: UIElement, key: string): UIElement => {
      const row = this.create('div', 'map-info-row');
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
    rows.set('پایتخت', addRow(detail, 'پایتخت'));
    rows.set('جمعیت', addRow(detail, 'جمعیت'));
    section('اقتصاد');
    for (const key of ['تولید ناخالص', 'خزانه', 'درآمد', 'هزینه‌ها'] as const) {
      rows.set(key, addRow(detail, key));
    }
    section('نظامی');
    for (const key of ['نیروی انسانی', 'ارتش', 'تجهیزات', 'هواپیماها', 'نیروی دریایی'] as const) {
      rows.set(key, addRow(detail, key));
    }
    section('منابع');
    const resources = this.create('div', 'map-resource-chips');
    detail.appendChild(resources);
    section('روابط خارجی');
    const relations = this.create('div', 'map-relations');
    detail.appendChild(relations);

    this.detailNodes = { flagImg, name: detailName, rows, resources, relations };
    this.detailContainer = detail;

    // —— feature detail (Part 3.5): grid cell / river / lake / site / city ——
    const featureDetail = this.create('div', 'map-feature-detail');
    panel.appendChild(featureDetail);
    const featureTitle = this.create('div', 'map-section-title feature-kind');
    featureDetail.appendChild(featureTitle);
    this.featureContainer = featureDetail;
    this.featureTitle = featureTitle;

    // —— basic rows (no country selected) ——
    const basic = this.create('div', 'map-country-basic');
    panel.appendChild(basic);
    for (const label of ['کشور', 'استان‌ها', 'شهرها', 'انتخاب']) {
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

    // —— hover tip (fixed chip at the top edge of the map area) ——
    const hoverTip = this.create('div', 'map-hover-tip');
    hoverTip.setVisible(false);
    root.appendChild(hoverTip);
    this.hoverTip = hoverTip;

    // —— layer toggles (generated from the data-driven registry) ——
    const layerTitle = this.create('div', 'map-layers-title');
    layerTitle.setText('لایه‌ها');
    panel.appendChild(layerTitle);

    const groupOrder: readonly MapLayerGroup[] = ['geography', 'infrastructure', 'society', 'base'];
    for (const group of groupOrder) {
      const defs = MAP_LAYERS.filter((def) => def.group === group);
      if (defs.length === 0) continue;
      const groupRow = this.create('div', 'map-layers');
      for (const def of defs) {
        const button = this.create('button', 'map-layer-toggle');
        button.setText(def.label);
        button.setAttribute('title', def.label);
        button.onClick(() => {
          const current = this.context?.state.map.layerVisibility[def.id] ?? true;
          this.commands.send({ type: 'map.setLayerVisible', layer: def.id, visible: !current });
        });
        groupRow.appendChild(button);
        this.layerButtons.set(def.id, button);
      }
      panel.appendChild(groupRow);
    }

    // —— region-selection mode (country ⇄ province land-click pick) ——
    // Pure UI preference wired through a command: the CORE owns the mode
    // (state.map.selectionMode), the pick resolves it, the highlight level
    // follows the stored selection automatically.
    const modeTitle = this.create('div', 'map-layers-title');
    modeTitle.setText('حالت انتخاب');
    panel.appendChild(modeTitle);
    const modeRow = this.create('div', 'map-selectmode');
    const countryButton = this.create('button', 'map-mode-btn');
    countryButton.setText('کشور');
    countryButton.setAttribute('title', 'کلیک روی خشکی، کشور را انتخاب می‌کند');
    countryButton.onClick(() => this.commands.send({ type: 'map.setSelectionMode', mode: 'country' }));
    const provinceButton = this.create('button', 'map-mode-btn');
    provinceButton.setText('استان');
    provinceButton.setAttribute('title', 'کلیک روی خشکی، استانِ همان نقطه را انتخاب می‌کند');
    provinceButton.onClick(() => this.commands.send({ type: 'map.setSelectionMode', mode: 'province' }));
    modeRow.appendChild(countryButton);
    modeRow.appendChild(provinceButton);
    panel.appendChild(modeRow);
    this.modeButtons = { country: countryButton, province: provinceButton };
  }

  // —— feature detail blocks (Part 3.5 shared interaction) ——

  /**
   * Renders the block for the CURRENT selection kind: grid cell / river /
   * lake / site / building / city. Every value is read from the central
   * StrategicMapModel (via describeGridCell for cells) — the UI owns no
   * geography. Rebuilds only when the selection signature changes.
   */
  private refreshFeatureBlock(map: SystemContext['state']['map']): void {
    const context = this.context;
    if (context === null || this.featureContainer === null) return;
    const model = context.map;
    const columns = context.config.map.columns;
    const rows = context.config.map.rows;

    const signature =
      `${map.selectedGridKey}|${map.selectedRiverId}|${map.selectedLakeId}` +
      `|${map.selectedSiteId}|${map.selectedBuildingId}|${map.selectedCityId}` +
      `|${map.selectedProvinceId}|${map.selectedCityConnectionId}`;
    if (signature === this.featureSignature) return;
    this.featureSignature = signature;
    for (const row of this.featureRows) row.remove();
    this.featureRows.length = 0;

    const addRow = (key: string, value: string): void => {
      if (this.featureContainer === null) return;
      const row = this.create('div', 'map-info-row');
      const keyEl = this.create('span', 'map-info-key');
      keyEl.setText(key);
      const valueEl = this.create('span', 'map-info-value');
      valueEl.setText(value);
      row.appendChild(keyEl);
      row.appendChild(valueEl);
      this.featureContainer.appendChild(row);
      this.featureRows.push(row);
    };
    const addChips = (key: string, values: readonly string[]): void => {
      if (this.featureContainer === null) return;
      const row = this.create('div', 'map-info-row');
      const keyEl = this.create('span', 'map-info-key');
      keyEl.setText(key);
      row.appendChild(keyEl);
      const chips = this.create('span', 'map-resource-chips');
      if (values.length === 0) {
        const empty = this.create('span', 'map-resource-chip empty');
        empty.setText('هیچ');
        chips.appendChild(empty);
      } else {
        for (const value of values) {
          const chip = this.create('span', 'map-resource-chip');
          chip.setText(value);
          chips.appendChild(chip);
        }
      }
      row.appendChild(chips);
      this.featureContainer.appendChild(row);
      this.featureRows.push(row);
    };
    const yesNo = (value: boolean): string => (value ? '✓' : '✗');

    let featureVisible = false;

    // —— PROVINCE (independent province layer: clickable + info block) ——
    // Province selection lives in the SAME central state as every other
    // feature kind; the block reads the central model via describeProvince.
    if (map.selectedProvinceId !== null && map.selectedCityId === null && map.selectedGridKey === null) {
      const info = describeProvince(model, map.selectedProvinceId);
      if (info !== null) {
        featureVisible = true;
        this.featureTitle?.setText(`استان — ${info.name}`);
        addRow('استان', info.name);
        addRow('کشور', model.countries[info.countryId]?.name ?? info.countryId);
        addRow('پایتخت', info.capitalCityId !== null ? (model.cities[info.capitalCityId]?.name ?? info.capitalCityId) : 'هیچ');
        addChips(
          'شهرها',
          info.cityIds.map((cityId) => model.cities[cityId]?.name ?? cityId)
        );
        addRow('جمعیت', formatCompact(info.population));
        addRow('زمین', TERRAIN_LABELS[info.terrainType] ?? info.terrainType);
        addRow('مساحت', `${info.areaCells} سلول`);
        addChips('منابع', [...info.resourceIds].map((id) => resourceLabel(context.data.economyData.strategicResources, id)));
        addRow('ساختمان‌ها', info.buildingIds.length > 0 ? String(info.buildingIds.length) : 'هیچ');
        addRow(
          'زیرساخت',
          `جاده ${info.infrastructure.roads} · راه‌آهن ${info.infrastructure.railways} · ` +
            `فرودگاه ${info.infrastructure.airports} · بندر ${info.infrastructure.ports}`
        );
        addRow('توسعه', `${Math.round(info.developmentLevel * 100)}٪`);
        addRow('ارزش راهبردی', String(info.strategicValue));
        addChips(
          'همسایه‌ها',
          info.neighborProvinceIds.map((neighborId) => model.provinces[neighborId]?.name ?? neighborId)
        );
      }
    }

    // —— GRID CELL (the spec's exact block; empty cells say None / 0) ——
    if (map.selectedGridKey !== null) {
      const info = describeGridCell(model, map.selectedGridKey, columns, rows);
      if (info !== null) {
        featureVisible = true;
        this.featureTitle?.setText(`خانهٔ شبکه — ${info.gridId}`);
        addRow('شناسهٔ خانه', info.gridId);
        addRow('کشور', model.countries[info.countryId]?.name ?? info.countryId);
        addRow('استان', info.provinceId !== null ? (model.provinces[info.provinceId]?.name ?? info.provinceId) : 'هیچ');
        addRow('زمین', TERRAIN_LABELS[info.terrainId] ?? info.terrainId);
        addRow('جمعیت', info.population > 0 ? formatCompact(info.population) : '۰');
        addChips(
          'شهرها',
          info.cityIds.map((cityId) => model.cities[cityId]?.name ?? cityId)
        );
        addChips('منابع', [...info.resourceIds].map((id) => resourceLabel(context.data.economyData.strategicResources, id)));
        addRow('ساختمان‌ها', info.buildingIds.length > 0 ? String(info.buildingIds.length) : 'هیچ');
        addRow('زیرساخت', `${info.roadIds.length} جاده · ${info.railwayIds.length} راه‌آهن`);
        addRow('ارزش راهبردی', String(info.strategicValue));
      }
    }

    // —— CITY ——
    if (featureVisible === false && map.selectedCityId !== null) {
      const city = model.cities[map.selectedCityId];
      if (city !== undefined) {
        featureVisible = true;
        this.featureTitle?.setText(`شهر — ${city.name}`);
        addRow('نام', city.name);
        addRow('استان', model.provinces[city.provinceId]?.name ?? city.provinceId);
        addRow('کشور', model.countries[city.countryId]?.name ?? city.countryId);
        addRow('شبکه', city.gridId !== '' ? city.gridId : '—');
        addRow('جمعیت', formatCompact(city.population));
        addRow('نوع', CITY_TYPE_LABELS[city.type] ?? city.type);
        addRow('اهمیت', `${Math.round(city.importance * 100)}٪`);
        // Real City Areas data (state.cityAreas) — the urban core's
        // development and the city's actual network connections. No
        // parallel city data: resolved live from the network slice.
        const network = context.state.cityAreas.network;
        const core = network.areas[`area_${city.id}_core`];
        if (core !== undefined) addRow('توسعه', `${Math.round(core.development * 100)}٪`);
        const connections = cityConnectionsOf(network);
        addChips(
          'اتصال‌ها',
          connectionsOfCity(connections, city.id).map((connection) => {
            const otherId = connectionOtherCity(connection, city.id);
            const other = model.cities[otherId];
            return `${other?.name ?? otherId} (${connectionLengthKm(connection)} کیلومتر)`;
          })
        );
        addChips(
          'منابع شهر',
          (() => {
            const config = context.data.economyData.strategicResources;
            const production = cityResourceProduction(model, city.id, config);
            const ids = new Set<string>([...city.resourceIds, ...Object.keys(production)]);
            return [...ids].sort().map((id) => {
              const amount = production[id];
              return amount !== undefined
                ? `${resourceLabel(config, id)} ${Math.round(amount).toLocaleString('en-US')}`
                : resourceLabel(config, id);
            });
          })()
        );
        addRow(
          'زیرساخت',
          `جاده ${yesNo(city.infrastructure.roadIds.length > 0)} · راه‌آهن ${yesNo(city.infrastructure.railwayIds.length > 0)} · ` +
            `فرودگاه ${yesNo(city.infrastructure.airportId !== null)} · بندر ${yesNo(city.infrastructure.portId !== null)}`
        );
        addRow('ارزش راهبردی', String(city.strategicValue));
      }
    }

    // —— CITY CONNECTION (City Areas network route) ——
    if (featureVisible === false && map.selectedCityConnectionId !== null) {
      const connections: readonly CityConnection[] = cityConnectionsOf(context.state.cityAreas.network);
      const connection = connections.find((entry) => entry.id === map.selectedCityConnectionId);
      if (connection !== undefined) {
        featureVisible = true;
        const nameA = model.cities[connection.cityA]?.name ?? connection.cityA;
        const nameB = model.cities[connection.cityB]?.name ?? connection.cityB;
        this.featureTitle?.setText(`اتصال شهری — ${nameA} ← ${nameB}`);
        addRow('از', nameA);
        addRow('به', nameB);
        addRow('استان‌ها',
          connection.provinceA === connection.provinceB
            ? (model.provinces[connection.provinceA]?.name ?? connection.provinceA)
            : `${model.provinces[connection.provinceA]?.name ?? connection.provinceA} ↔ ${model.provinces[connection.provinceB]?.name ?? connection.provinceB}`
        );
        addRow('فاصله', `${connectionLengthKm(connection).toLocaleString('en-US')} کیلومتر`);
        addRow('نوع', connection.kind === 'railway' ? 'راه‌آهن' : 'جاده');
        addRow(
          'گستره',
          connection.crossCountry ? 'مرزی' : connection.crossProvince ? 'بین‌استانی' : 'درون‌استانی'
        );
        // Link condition = the network's live maintenance state (0..1).
        const conditions = connection.linkIds
          .map((linkId) => context.state.cityAreas.network.links[linkId]?.condition)
          .filter((value): value is number => value !== undefined);
        const condition = conditions.length > 0
          ? conditions.reduce((sum, value) => sum + value, 0) / conditions.length
          : 0;
        addRow(
          'زیرساخت',
          condition >= 0.75 ? 'توسعه‌یافته' : condition >= 0.5 ? 'خوب' : condition >= 0.25 ? 'فرسوده' : 'ضعیف'
        );
        addRow('نقاط مسیر', String(connection.path.length));
      }
    }

    // —— RIVER ——
    if (featureVisible === false && map.selectedRiverId !== null) {
      const river = model.features.rivers.find((candidate) => candidate.id === map.selectedRiverId);
      if (river !== undefined) {
        featureVisible = true;
        this.featureTitle?.setText(`رودخانه — ${river.name}`);
        addRow('نام', river.name);
        addRow('طول', `${Math.round(river.length)} واحد`);
        addRow(
          'دهانه',
          (RIVER_MOUTH_LABELS[river.mouthType] ?? river.mouthType) +
            (river.parentRiverId !== null ? ' (شاخه)' : '')
        );
        addRow('استان‌ها', String(river.provinceIds.length));
        addChips('شهرها', river.cityIds.map((cityId) => model.cities[cityId]?.name ?? cityId));
        addChips('شاخه‌ها', [...river.tributaryIds]);
        addRow('قابل کشتیرانی', yesNo(river.navigable));
        addRow('اهمیت', `${Math.round(river.importance * 100)}٪`);
      }
    }

    // —— LAKE ——
    if (featureVisible === false && map.selectedLakeId !== null) {
      const lake = model.features.lakes.find((candidate) => candidate.id === map.selectedLakeId);
      if (lake !== undefined) {
        featureVisible = true;
        this.featureTitle?.setText(`دریاچه — ${lake.name}`);
        addRow('نام', lake.name);
        addRow('مساحت', `${lake.areaCells} سلول`);
        addRow('ژرفا', `${Math.round(lake.depth * 100)}٪`);
        addChips('رودهای ورودی', [...lake.inflowRiverIds]);
        addChips('رودهای خروجی', [...lake.outflowRiverIds]);
        addRow('استان‌ها', String(lake.provinceIds.length));
        addChips('شهرها', lake.cityIds.map((cityId) => model.cities[cityId]?.name ?? cityId));
      }
    }

    // —— SITE (resource/port/military/production) ——
    if (featureVisible === false && map.selectedSiteId !== null) {
      const site = model.features.sites.find((candidate) => candidate.id === map.selectedSiteId);
      if (site !== undefined) {
        featureVisible = true;
        this.featureTitle?.setText(`محوطه — ${SITE_KIND_LABELS[site.kind] ?? site.kind}`);
        addRow('نوع', SITE_KIND_LABELS[site.kind] ?? site.kind);
        if (site.resourceId !== null) addRow('منبع', site.resourceId);
        const deposit = model.features.deposits.find((candidate) => candidate.siteId === site.id);
        if (deposit !== undefined) addRow('مقدار', String(deposit.quantity));
        addRow('کشور', model.countries[site.countryId]?.name ?? site.countryId);
        addRow('شهر', site.cityId !== null ? (model.cities[site.cityId]?.name ?? site.cityId) : 'هیچ');
      }
    }

    // —— BUILDING (urban facility) ——
    if (featureVisible === false && map.selectedBuildingId !== null) {
      const building = model.features.buildings.find(
        (candidate) => candidate.id === map.selectedBuildingId
      );
      if (building !== undefined) {
        featureVisible = true;
        this.featureTitle?.setText(`ساختمان — ${BUILDING_KIND_LABELS[building.kind] ?? building.kind}`);
        addRow('نوع', BUILDING_KIND_LABELS[building.kind] ?? building.kind);
        addRow('سطح', String(building.level));
        addRow('استان', model.provinces[building.provinceId]?.name ?? building.provinceId);
        addRow('شهر', building.cityId !== null ? (model.cities[building.cityId]?.name ?? building.cityId) : 'هیچ');
      }
    }

    this.featureContainer.setVisible(featureVisible);
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
      sections.push({ title: 'زیست‌بوم‌ها', rows: buildBiomeLegend(context.map, context.data.mapTheme) });
    } else if (visibility.terrain === true) {
      sections.push({ title: 'ارتفاع', gradient: buildElevationLegend(context.data.mapTheme) });
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
      fill('پایتخت', capital !== undefined ? capital.name : '—');
      fill('جمعیت', formatCompact(countryState.population));
      fill('تولید ناخالص', `${countryState.economy.gdp} میلیارد دلار`);
      fill('خزانه', `${countryState.economy.treasury} میلیون دلار`);
      fill('درآمد', `+${countryState.economy.income} میلیون دلار`);
      fill('هزینه‌ها', `-${countryState.economy.expenses} میلیون دلار`);
      fill('نیروی انسانی', formatCompact(countryState.military.manpower));
      fill('ارتش', formatCompact(countryState.military.armySize));
      fill('تجهیزات', `${countryState.military.equipment}`);
      fill('هواپیماها', `${countryState.military.aircraft}`);
      fill('نیروی دریایی', `${countryState.military.navy}`);

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
      'کشور': country !== undefined ? country.name : '—',
      'استان‌ها': country !== undefined ? String(country.provinceIds.length) : '—',
      'شهرها': country !== undefined ? String(country.cityIds.length) : '—',
      // ONE central summary for EVERY selection kind — the same state (and
      // the same resolver) the feature detail block uses, so the panels can
      // never contradict each other.
      'انتخاب': selectionSummary(state, model, cityConnectionsOf(context.state.cityAreas.network))
    };
    for (const row of this.infoRows) {
      row.value.setText(values[row.label] ?? '');
    }

    const title = this.context !== null ? model.continentName : 'نقشهٔ راهبردی';
    this.infoTitle?.setText(`نقشهٔ راهبردی — ${title}`);

    this.refreshFeatureBlock(state);

    for (const [layerId, button] of this.layerButtons) {
      const visible = state.layerVisibility[layerId] !== false;
      button.setClass(visible ? 'map-layer-toggle on' : 'map-layer-toggle off');
    }
    // Region-selection segment mirrors the CORE-owned mode.
    if (this.modeButtons !== null) {
      this.modeButtons.country.setClass(
        state.selectionMode === 'country' ? 'map-mode-btn on' : 'map-mode-btn'
      );
      this.modeButtons.province.setClass(
        state.selectionMode === 'province' ? 'map-mode-btn on' : 'map-mode-btn'
      );
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
    title.setText('کشورها');
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
    title.setText('کشور خود را انتخاب کنید');
    container.appendChild(title);
    const subtitle = this.create('div', 'screen-subtitle');
    subtitle.setText('روی نقشه یک کشور کلیک کنید یا از فهرست انتخابش کنید، سپس تأیید کنید.');
    container.appendChild(subtitle);
    if (context === null) return;

    this.buildCountryRows(container, (countryId) => {
      this.commands.send({ type: 'map.select', countryId });
      this.commands.send({ type: 'map.focusCountry', countryId });
    });

    const actions = this.create('div', 'screen-actions');
    const confirm = this.create('button', 'screen-confirm');
    confirm.setText('تأیید و شروع');
    confirm.onClick(() => {
      const selected = this.context?.state.map.selectedCountryId ?? null;
      if (selected === null) return;
      this.commands.send({ type: 'player.confirmCountry', countryId: selected });
    });
    this.confirmButton = confirm;
    actions.appendChild(confirm);

    const cancel = this.create('button', 'screen-cancel');
    cancel.setText('بازگشت');
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
        `${countryState.name} — پایتخت ${capital.name}، ${formatCompact(countryState.population)}` +
          `${country.coastal ? '' : ' (محصور در خشکی)'}`
      );
      button.appendChild(label);
      button.onClick(() => onPick(country.id));
      list.appendChild(button);
    }
    container.appendChild(list);
  }
}

// —— formatting + small DOM builders (module-scope, DOM-free logic where possible) ——

/** Compact magnitudes with Persian units; Latin digits stay tabular. */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${trim(value / 1_000_000_000)} میلیارد`;
  if (abs >= 1_000_000) return `${trim(value / 1_000_000)} میلیون`;
  if (abs >= 10_000) return `${trim(value / 1_000)} هزار`;
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
    empty.setText('هیچ');
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
    const band = relationBand(value);
    const chip = create('span', `map-relation-band band-${band}`);
    chip.setText(`${RELATION_BAND_LABELS[band] ?? band} ${value > 0 ? '+' : ''}${value}`);
    row.appendChild(name);
    row.appendChild(chip);
    container.appendChild(row);
    tracker.push(row);
  }
  if (entries.length === 0) {
    const empty = create('span', 'map-relation-empty');
    empty.setText('روابطی برقرار نشده است');
    container.appendChild(empty);
    tracker.push(empty);
  }
}
