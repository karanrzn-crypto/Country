import type { UIDomAdapter } from './adapter/UIDomAdapter';
import type { UIElement } from './adapter/UIDomAdapter';
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
import { PresidentDashboard } from './PresidentDashboard';

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
  private readonly root: UIElement;
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
    this.root = this.createRoot(adapter);

    this.screens = new ScreenManager(adapter, events);
    this.hud = new HUDSystem(this.root, adapter, modes, commands);
    this.notifications = new NotificationSystem(
      (() => {
        const container = adapter.create('div', 'notifications');
        this.root.appendChild(container);
        return container;
      })(),
      (tag, className) => adapter.create(tag, className)
    );
    this.dialogs = new DialogSystem(adapter);

    const menus = new MenuSystem(this.screens, this.commands, (tag, className) => adapter.create(tag, className));
    menus.registerBuilders();
    this.mapUI = new MapUI(this.screens, this.commands, (tag, className) => adapter.create(tag, className));
    this.dashboard = new PresidentDashboard(this.screens, this.commands, (tag, className) => adapter.create(tag, className));
  }

  private readonly dashboard: PresidentDashboard;

  private createRoot(adapter: UIDomAdapter): UIElement {
    const root = adapter.create('div', 'ui-root');
    adapter.root().appendChild(root);
    return root;
  }

  init(context: SystemContext): void {
    // Map UI observes the strategic map slice + static model.
    this.mapUI.register(context, this.root);
    // Phase 2: the presidential dashboard (screen 'president').
    this.dashboard.register(context);
    this.unsubscribes.push(
      this.events.on('map.selectionChanged', () => {
        this.mapUI.refreshInfo();
        if (this.screens.isOpen('countrySelect')) this.mapUI.refreshCountrySelect();
      }),
      this.events.on('map.layerVisibilityChanged', () => this.mapUI.refreshInfo()),
      // —— Phase 2 government events: notifications + dashboard refresh ——
      this.events.on('government.eventFired', ({ countryId, title }) => {
        if (countryId === context.state.player.countryId) {
          this.notify('warn', 'Event', title);
        }
        this.dashboard.refresh();
      }),
      this.events.on('government.eventResolved', () => this.dashboard.refresh()),
      this.events.on('government.decisionEnacted', () => this.dashboard.refresh()),
      this.events.on('government.budgetChanged', () => this.dashboard.refresh()),
      this.events.on('government.ministryFundingChanged', () => this.dashboard.refresh()),
      this.events.on('government.monthProcessed', ({ countryId }) => {
        if (countryId === context.state.player.countryId && this.screens.isOpen('president')) {
          this.dashboard.refresh();
        }
      }),
      this.events.on('government.electionHeld', ({ countryId, winnerId }) => {
        if (countryId === context.state.player.countryId) {
          const partyName =
            context.state.government.countries[countryId]?.politics.parties[winnerId]?.name ?? winnerId;
          this.notify('info', 'Election', `${partyName} wins the election.`);
        }
        this.dashboard.refresh();
      }),
      this.events.on('government.campaignStarted', ({ countryId }) => {
        if (countryId === context.state.player.countryId) {
          this.notify('info', 'Election Campaign', 'The campaign window has opened.');
        }
      })
    );
    // Country-selection flow (Part 3): the core drives the phase via events;
    // the UI only opens/closes its screens and informs the player.
    this.unsubscribes.push(
      this.events.on('player.countrySelectionStarted', () => {
        this.screens.close('mainMenu');
        this.screens.open('countrySelect');
      }),
      this.events.on('player.countryConfirmed', ({ countryId }) => {
        this.screens.close('countrySelect');
        const name = context.state.countries.countries[countryId]?.name ?? countryId;
        this.notify('info', 'Country Selected', `You now lead ${name}.`);
      })
    );
    this.unsubscribes.push(
      this.events.on('input.actionPressed', ({ action }) => {
        if (action === 'toggleMap') {
          if (this.screens.isOpen('map')) this.screens.close('map');
          else this.screens.open('map');
        } else if (action === 'ui.back') {
          if (this.screens.depth > 0) {
            this.screens.closeTop();
          } else if (context.state.player.countryConfirmed) {
            // No screen open → Escape is the pause menu (dashboard entry).
            this.commands.send({ type: 'game.setPaused', paused: true });
            this.screens.open('pauseMenu');
          }
        } else if (action === 'togglePause') {
          // Ignore pause before the campaign actually starts (country-select
          // flow owns the pause state until the player confirms a country).
          if (context.state.player.countryConfirmed) {
            this.commands.send({ type: 'game.togglePause' });
          }
        } else if (action.startsWith('speed')) {
          // speed1..speedN → the Nth data-driven speed step.
          const index = Number(action.slice('speed'.length)) - 1;
          if (Number.isInteger(index) && index >= 0) {
            this.commands.send({ type: 'game.setSpeedStep', index });
          }
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
    // Dashboard live refresh while open (2× per second at 30 Hz).
    if (this.screens.isOpen('president') && this.frameCounter % 15 === 0) {
      this.dashboard.refresh();
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
