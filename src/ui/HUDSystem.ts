import type { SystemContext } from '../core/GameContext';
import type { UIElement } from './adapter/UIDomAdapter';
import { buildHudModel } from './HUDModel';
import type { PlayerModeSystem } from '../player/PlayerModeSystem';

/**
 * HUD view: fixed bottom-left panel reflecting state (never owning it).
 * Built through the UIDomAdapter so logic stays DOM-free and testable.
 */
export class HUDSystem {
  private readonly rows: { key: UIElement; value: UIElement }[] = [];
  private readonly panel: UIElement;

  constructor(
    container: UIElement,
    adapter: { create(tag: string, className?: string): UIElement },
    private readonly modes: PlayerModeSystem
  ) {
    this.panel = adapter.create('div', 'hud');
    const title = adapter.create('div', 'hud-title');
    title.setText('COUNTRY');
    this.panel.appendChild(title);
    container.appendChild(this.panel);

    for (const key of ['Date', 'Speed', 'Mode', 'Treasury', 'Population', 'Chunks']) {
      const row = adapter.create('div', 'hud-row');
      const keyElement = adapter.create('span', 'hud-key');
      keyElement.setText(key);
      const valueElement = adapter.create('span', 'hud-value');
      row.appendChild(keyElement);
      row.appendChild(valueElement);
      this.panel.appendChild(row);
      this.rows.push({ key: keyElement, value: valueElement });
    }
  }

  update(context: SystemContext): void {
    const state = context.state;
    const modeName = state.player.mode !== null ? this.modes.modeDef(state.player.mode).name : '—';
    const model = buildHudModel(
      state,
      context.time.date,
      context.time.isPaused,
      context.time.speed,
      modeName,
      context.world.counts()
    );
    const values = [model.date, model.speed, model.mode, model.treasury, model.population, model.chunks];
    for (let index = 0; index < this.rows.length; index++) {
      this.rows[index].value.setText(values[index] ?? '');
    }
  }

  setVisible(visible: boolean): void {
    this.panel.setVisible(visible);
  }
}
