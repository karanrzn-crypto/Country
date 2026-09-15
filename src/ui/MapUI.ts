import type { CommandBus } from '../core/CommandBus';
import type { SystemContext } from '../core/GameContext';
import type { UIElement } from './adapter/UIDomAdapter';
import type { ScreenManager } from './ScreenManager';
import { MAP_LAYER_ORDER, type MapLayerId } from '../world/map/MapLayers';

/**
 * Strategic map UI (Part 1):
 * - selection info panel (Country Name / Capital / Province Count / City
 *   Count — nothing more, per spec);
 * - layer toggle row (each map layer independently switchable);
 * - the 'map' screen lists countries; clicking selects + focuses it.
 *
 * UI observes state + sends commands only — it never mutates state directly.
 */
export class MapUI {
  private context: SystemContext | null = null;
  private infoRows: { label: string; value: UIElement }[] = [];
  private infoTitle: UIElement | null = null;
  private layerButtons = new Map<MapLayerId, UIElement>();

  constructor(
    private readonly screens: ScreenManager,
    private readonly commands: CommandBus,
    private readonly create: (tag: string, className?: string) => UIElement
  ) {}

  /** Called from UIManager.init with the full SystemContext. */
  register(context: SystemContext, root: UIElement): void {
    this.context = context;
    this.buildInfoPanel(root);
    this.screens.registerScreen('map', (container) => this.buildMapScreen(container));
    this.refreshInfo();
  }

  private buildInfoPanel(root: UIElement): void {
    const panel = this.create('div', 'map-info-panel');
    root.appendChild(panel);

    const title = this.create('div', 'map-info-title');
    this.infoTitle = title;
    panel.appendChild(title);

    for (const label of ['Country', 'Capital', 'Provinces', 'Cities', 'Selection']) {
      const row = this.create('div', 'map-info-row');
      const key = this.create('span', 'map-info-key');
      key.setText(label);
      const value = this.create('span', 'map-info-value');
      row.appendChild(key);
      row.appendChild(value);
      panel.appendChild(row);
      this.infoRows.push({ label, value });
    }

    const layerTitle = this.create('div', 'map-layers-title');
    layerTitle.setText('Layers');
    panel.appendChild(layerTitle);

    const layerRow = this.create('div', 'map-layers');
    for (const layerId of MAP_LAYER_ORDER) {
      const button = this.create('button', 'map-layer-toggle');
      button.setText(layerId);
      button.onClick(() => {
        const current = this.context?.state.map.layerVisibility[layerId] ?? true;
        this.commands.send({ type: 'map.setLayerVisible', layer: layerId, visible: !current });
      });
      layerRow.appendChild(button);
      this.layerButtons.set(layerId, button);
    }
    panel.appendChild(layerRow);
  }

  /** Re-reads the map slice + model into the info panel (observer, cheap). */
  refreshInfo(): void {
    const context = this.context;
    if (context === null || this.infoTitle === null) return;
    const state = context.state.map;
    const model = context.map;

    this.infoTitle.setText(`STRATEGIC MAP — ${model.continentName.toUpperCase()}`);

    const country =
      state.selectedCountryId !== null ? model.countries[state.selectedCountryId] : undefined;
    const province =
      state.selectedProvinceId !== null ? model.provinces[state.selectedProvinceId] : undefined;
    const city = state.selectedCityId !== null ? model.cities[state.selectedCityId] : undefined;

    const values: Record<string, string> = {
      Country: country !== undefined ? country.name : '—',
      Capital: country !== undefined ? model.cities[country.capitalCityId].name : '—',
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

    for (const [layerId, button] of this.layerButtons) {
      const visible = state.layerVisibility[layerId] !== false;
      button.setClass(visible ? 'map-layer-toggle on' : 'map-layer-toggle off');
    }
  }

  private buildMapScreen(container: UIElement): void {
    const context = this.context;
    const title = this.create('h2');
    title.setText('Countries');
    container.appendChild(title);
    if (context === null) return;

    const list = this.create('div', 'map-country-list');
    for (const countryId of context.map.countryOrder) {
      const country = context.map.countries[countryId];
      const capital = context.map.cities[country.capitalCityId];
      const button = this.create('button');
      button.setText(
        `${country.name} — capital ${capital.name}, ${country.provinceIds.length} provinces, ` +
          `${country.cityIds.length} cities${country.coastal ? '' : ' (landlocked)'}`
      );
      button.onClick(() => {
        this.commands.send({ type: 'map.select', countryId: country.id });
        this.commands.send({ type: 'map.focusCountry', countryId: country.id });
        this.screens.close('map');
      });
      list.appendChild(button);
    }
    container.appendChild(list);
  }
}
