import type { CommandBus } from '../core/CommandBus';
import type { GameState } from '../state/GameState';
import type { UIElement } from './adapter/UIDomAdapter';
import type { ScreenManager } from './ScreenManager';

/**
 * Strategic map UI foundation: lists regions; clicking one focuses its first
 * chunk (via command) and closes the map. Phase 1 replaces the list with the
 * real 2.5D map surface — the command contract stays identical.
 */
export class MapUI {
  constructor(
    private readonly screens: ScreenManager,
    private readonly commands: CommandBus,
    private readonly create: (tag: string, className?: string) => UIElement
  ) {}

  registerBuilder(state: GameState): void {
    this.screens.registerScreen('map', (container) => this.buildMap(container, state));
  }

  private buildMap(container: UIElement, state: GameState): void {
    const title = this.create('h2');
    title.setText('Strategic Map');
    container.appendChild(title);

    const list = this.create('div', 'map-region-list');
    for (const region of Object.values(state.world.regions)) {
      const countryName = state.world.countries[state.world.countryOfRegion[region.id]]?.name ?? '?';
      const button = this.create('button');
      button.setText(`${region.name} — ${countryName} (infra ${region.infrastructure})`);
      button.onClick(() => {
        const chunkId = region.chunkIds[0];
        if (chunkId !== undefined) {
          this.commands.send({ type: 'player.focusChunk', chunkId });
        }
        this.screens.close('map');
      });
      list.appendChild(button);
    }
    container.appendChild(list);
  }
}
