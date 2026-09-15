import type { UIDomAdapter } from './adapter/UIDomAdapter';
import type { EventBus } from '../events/EventBus';
import type { Logger } from '../utils/Logger';
import type { CommandBus } from '../core/CommandBus';
import type { SystemContext } from '../core/GameContext';
import type { PhaseSystem, SystemUpdate } from '../core/SystemTypes';
import type { PlayerModeSystem } from '../player/PlayerModeSystem';
import { ScreenManager } from './ScreenManager';
import { HUDSystem } from './HUDSystem';
import { NotificationSystem } from './NotificationSystem';
import type { NotificationLevel } from './NotificationSystem';
import { DialogSystem } from './DialogSystem';
import { MenuSystem } from './MenuSystem';
import { MapUI } from './MapUI';

/**
 * UI phase system (render phase). Assembles all UI foundations and wires
 * them to events. UI only observes state and emits commands — it never
 * mutates the simulation directly (spec 0.9).
 */
export class UIManager implements PhaseSystem {
  readonly id = 'core.ui';
  readonly phase = 'render' as const;

  private readonly screens: ScreenManager;
  private readonly hud: HUDSystem;
  private readonly notifications: NotificationSystem;
  private readonly dialogs: DialogSystem;
  private readonly mapUI: MapUI;
  private frameCounter = 0;
  private lastTreasuryWarnFrame = -1_000_000;
  private readonly unsubscribes: (() => void)[] = [];

  constructor(
    adapter: UIDomAdapter,
    modes: PlayerModeSystem,
    private readonly commands: CommandBus,
    private readonly events: EventBus,
    private readonly logger: Logger
  ) {
    const root = adapter.create('div', 'ui-root');
    adapter.root().appendChild(root);

    this.screens = new ScreenManager(adapter, events);
    this.hud = new HUDSystem(root, adapter, modes);
    this.notifications = new NotificationSystem(
      (() => {
        const container = adapter.create('div', 'notifications');
        root.appendChild(container);
        return container;
      })(),
      (tag, className) => adapter.create(tag, className)
    );
    this.dialogs = new DialogSystem(adapter);

    const menus = new MenuSystem(this.screens, this.commands, (tag, className) => adapter.create(tag, className));
    menus.registerBuilders();
    this.mapUI = new MapUI(this.screens, this.commands, (tag, className) => adapter.create(tag, className));
  }

  init(context: SystemContext): void {
    this.mapUI.registerBuilder(context.state);

    this.unsubscribes.push(
      this.events.on('input.actionPressed', ({ action }) => {
        if (action === 'toggleMap') {
          if (this.screens.isOpen('map')) this.screens.close('map');
          else this.screens.open('map');
        } else if (action === 'ui.back') {
          this.screens.closeTop();
        }
      }),
      this.events.on('combat.engagementStarted', ({ regionId }) => {
        this.notify('warn', 'Combat', `Forces clashing in ${regionId}`);
      }),
      this.events.on('save.saved', ({ slot }) => {
        this.notify('info', 'Saved', `Game saved to "${slot}"`);
      }),
      this.events.on('save.loaded', ({ slot }) => {
        this.notify('info', 'Loaded', `Game restored from "${slot}"`);
      }),
      this.events.on('sim.economyTreasuryChanged', ({ factionId, value }) => {
        if (
          factionId === context.state.player.countryId &&
          value < context.config.economy.lowTreasuryWarnThreshold &&
          this.frameCounter - this.lastTreasuryWarnFrame > 360
        ) {
          this.lastTreasuryWarnFrame = this.frameCounter;
          this.notify('warn', 'Treasury Low', 'Income no longer covers upkeep.');
        }
      })
    );

    // Boot state: main menu open, game paused until the player starts.
    if (!this.screens.isOpen('mainMenu')) {
      this.screens.open('mainMenu');
      this.commands.send({ type: 'game.togglePause' });
    }
  }

  update(context: SystemContext, update: SystemUpdate): void {
    if (update.kind !== 'frame') return;
    this.frameCounter = update.frame.frameIndex;
    this.notifications.update(this.frameCounter);
    if (this.frameCounter % 10 === 0) {
      this.hud.update(context);
    }
  }

  // —— external surface ——

  notify(level: NotificationLevel, title: string, message: string): void {
    this.notifications.push(level, title, message, this.frameCounter);
    this.events.emit('ui.notification', { level, title, message });
  }

  openScreen(screenId: string): void {
    try {
      this.screens.open(screenId);
    } catch (error) {
      this.logger.warn(`Cannot open screen "${screenId}"`, error);
    }
  }

  closeScreen(screenId: string): void {
    this.screens.close(screenId);
  }

  confirm(title: string, message: string): Promise<boolean> {
    return this.dialogs.confirm(title, message);
  }

  get screenManager(): ScreenManager {
    return this.screens;
  }

  get notificationCount(): number {
    return this.notifications.size;
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes.length = 0;
  }
}
