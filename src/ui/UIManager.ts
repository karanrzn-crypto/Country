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
import type { NotificationLevel, NotificationOptions } from './NotificationSystem';
import { DialogSystem } from './DialogSystem';
import { MenuSystem } from './MenuSystem';
import { MapUI } from './MapUI';
import { PresidentDashboard } from './PresidentDashboard';
import { PresidentStatusPanel } from './PresidentStatusPanel';
import { faNum } from '../utils/format';

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
    // Phase 2 — the permanent bottom-right quick overview, deep-linked into
    // the dashboard (no screen, no parallel state, no parallel event bus).
    this.statusPanel = new PresidentStatusPanel(this.dashboard, (tag, className) => adapter.create(tag, className));
    this.root.appendChild(this.statusPanel.root);
    // The panel's open/close button — a clear, standalone control pinned
    // bottom-center where it collides with no other map control.
    this.statusPanelToggle = adapter.create('button', 'psp-toggle');
    this.statusPanelToggle.setText('رئیس‌جمهور');
    this.statusPanelToggle.setAttribute('title', 'باز و بسته کردن پنل رئیس‌جمهور');
    this.statusPanelToggle.onClick(() => {
      const collapsed = this.statusPanel.toggle();
      this.statusPanelToggle.setClass(collapsed ? 'psp-toggle' : 'psp-toggle on');
    });
    this.statusPanelToggle.setVisible(false);
    this.root.appendChild(this.statusPanelToggle);
  }

  private readonly dashboard: PresidentDashboard;
  private readonly statusPanel: PresidentStatusPanel;
  /** Dedicated open/close button for the permanent status panel. */
  private readonly statusPanelToggle: UIElement;

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
    // Phase 2: the permanent presidential status panel (bottom-right).
    this.statusPanel.register(context, this.root);
    this.unsubscribes.push(
      this.events.on('map.selectionChanged', () => {
        this.mapUI.refreshInfo();
        if (this.screens.isOpen('countrySelect')) this.mapUI.refreshCountrySelect();
      }),
      this.events.on('map.layerVisibilityChanged', () => this.mapUI.refreshInfo()),
      // Region-selection mode (country ⇄ province): the segment mirrors the
      // core-owned state map.selectionMode.
      this.events.on('map.selectionModeChanged', () => this.mapUI.refreshInfo()),
      // —— Phase 2 government events: notifications + dashboard refresh ——
      this.events.on('government.eventFired', ({ countryId, title }) => {
        if (countryId === context.state.player.countryId) {
          this.notify('warn', 'رویداد', title);
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
          this.notify('info', 'انتخابات', `${partyName} در انتخابات پیروز شد.`);
        }
        this.dashboard.refresh();
      }),
      this.events.on('government.campaignStarted', ({ countryId }) => {
        if (countryId === context.state.player.countryId) {
          this.notify('info', 'کارزار انتخاباتی', 'مهلت کارزار انتخاباتی گشوده شد.');
        }
      }),
      // —— Phase 3 simple-economy events: map panel + dashboard refresh ——
      // Contracts/construction move the dashboard's live lists.
      this.events.on('economy.contractSigned', ({ buyerId }) => {
        if (buyerId === context.state.player.countryId) {
          this.notify('info', 'قرارداد تجاری', 'قرارداد ماهانه امضا شد — تحویل هر ماه انجام می‌شود.');
          this.dashboard.refresh();
        }
      }),
      this.events.on('economy.contractCancelled', ({ countryId }) => {
        if (countryId === context.state.player.countryId) {
          this.notify('info', 'قرارداد تجاری', 'قرارداد لغو شد — تحویل ماه بعد انجام نمی‌شود.');
          this.dashboard.refresh();
        }
      }),
      this.events.on('economy.constructionStarted', ({ countryId }) => {
        if (countryId === context.state.player.countryId) {
          // AUTO-RETURN (spec §1.11/1.12/§13): after a successful region
          // pick the player is back IN the economy panel — the new project
          // card (months remaining) is visible without hunting for the
          // panel. Also refreshes the map's cell panel + economy colors.
          this.dashboard.openAt('economy');
          this.mapUI.refreshInfo();
        }
      }),
      this.events.on('economy.constructionCompleted', ({ countryId }) => {
        if (countryId === context.state.player.countryId) {
          this.notify('info', 'ساخت‌وساز', 'یک ساختمان به بهره‌برداری رسید.');
          this.dashboard.refresh();
          // The map's cell panel + economy colors follow immediately (§2).
          this.mapUI.refreshInfo();
        }
      }),
      // —— The EXPORT REQUESTS (the export-request directive §3): a country
      //    asked to buy the player's goods — the president gets a CLEAR
      //    message and decides IN THE NOTIFICATION (موافقت / مخالفت — the
      //    notifications directive §7) or in «قراردادها». ——
      this.events.on('economy.exportRequested', ({ sellerId, buyerId, resourceId, amountPerMonth, requestId }) => {
        if (sellerId === context.state.player.countryId && buyerId !== sellerId) {
          const config = context.data.economyData.strategicResources;
          const good = config.resources.find((resource) => resource.id === resourceId)?.name ?? resourceId;
          const buyer = context.state.countries.countries[buyerId]?.name ?? buyerId;
          this.notify(
            'warn',
            'درخواست صادرات',
            `کشور ${buyer} درخواست خرید ${faNum(amountPerMonth)} واحد ${good} در ماه را دارد.`,
            {
              actions: [
                {
                  label: 'موافقت',
                  onClick: () => this.commands.send({ type: 'economy.approveExportRequest', requestId })
                },
                {
                  label: 'مخالفت',
                  onClick: () => this.commands.send({ type: 'economy.rejectExportRequest', requestId })
                }
              ]
            }
          );
          this.dashboard.refresh();
        }
      }),
      this.events.on('economy.exportRequestDecided', ({ sellerId, buyerId, approved, capacityOk }) => {
        if (sellerId === context.state.player.countryId && buyerId !== sellerId) {
          const buyer = context.state.countries.countries[buyerId]?.name ?? buyerId;
          this.notify(
            approved && capacityOk ? 'info' : 'warn',
            'درخواست صادرات',
            !approved
              ? `درخواست ${buyer} مخالفت شد — هیچ قراردادی ساخته نشد.`
              : capacityOk
                ? `درخواست ${buyer} موافقت شد — قرارداد صادراتی ماهانه شکل گرفت.`
                : `عرضهٔ فروش شما از زمان درخواست کم شده — موافقت با درخواست ${buyer} ممکن نشد.`
          );
          this.dashboard.refresh();
        }
      }),
      // —— THE ECONOMIC EVENTS (the events directive §5/§7): a temporary
      //    production shock starts (the president is told WHY and for how
      //    long) and the recovery is announced when it ends. ——
      this.events.on('economy.economicEventStarted', ({ countryId, short, message, monthsRemaining }) => {
        if (countryId === context.state.player.countryId) {
          this.notify(
            'warn',
            'رویداد اقتصادی',
            `${message} (${faNum(monthsRemaining)} ماه)` || short
          );
        }
        this.dashboard.refresh();
      }),
      this.events.on('economy.economicEventEnded', ({ countryId, short }) => {
        if (countryId === context.state.player.countryId) {
          this.notify('info', 'رویداد اقتصادی', `${short} به پایان رسید — اقتصاد به حالت عادی بازگشت.`);
        }
        this.dashboard.refresh();
      }),
      this.events.on('economy.spotPurchased', ({ buyerId, sellerId, resourceId, amount }) => {
        if (buyerId === context.state.player.countryId && sellerId !== buyerId) {
          const config = context.data.economyData.strategicResources;
          const good = config.resources.find((resource) => resource.id === resourceId)?.name ?? resourceId;
          this.notify('info', 'خرید فوری', `${faNum(amount)} واحد ${good} به انبار اضافه شد.`);
          this.dashboard.refresh();
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
        this.notify('info', 'کشور انتخاب شد', `اکنون رهبری ${name} را بر عهده دارید.`);
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
        this.notify('warn', 'نبرد', `درگیری نیروها در ${regionId}`);
      }),
      this.events.on('save.saved', ({ slot }) => {
        this.notify('info', 'ذخیره شد', `بازی در «${slot}» ذخیره شد.`);
      }),
      this.events.on('save.loaded', ({ slot }) => {
        this.notify('info', 'بارگذاری شد', `بازی از «${slot}» بازیابی شد.`);
      }),
      this.events.on('sim.economyTreasuryChanged', ({ factionId, value }) => {
        if (
          factionId === context.state.player.countryId &&
          value < context.config.economy.lowTreasuryWarnThreshold &&
          this.frameCounter - this.lastTreasuryWarnFrame > 360
        ) {
          this.lastTreasuryWarnFrame = this.frameCounter;
          this.notify('warn', 'خزانه رو به کسری است', 'درآمد دیگر هزینه‌ها را پوشش نمی‌دهد.');
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
    // The panel toggle exists only once a country is confirmed (before that
    // the panel has nothing to show — a dead button would be noise).
    this.statusPanelToggle.setVisible(context.state.player.countryConfirmed);
    if (this.frameCounter % 10 === 0) {
      this.hud.update(context);
    }
    // Status panel: bounded cadence (≈2 Hz at 30 Hz) + its own event-driven
    // refreshes — reads GameState directly, owns no state.
    this.statusPanel.update(context, this.frameCounter);
    // Dashboard live refresh while open (2× per second at 30 Hz).
    if (this.screens.isOpen('president') && this.frameCounter % 15 === 0) {
      this.dashboard.refresh();
    }
  }

  // —— external surface ——

  notify(level: NotificationLevel, title: string, message: string, options: NotificationOptions = {}): void {
    this.notifications.push(level, title, message, this.frameCounter, options);
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
    this.statusPanel.dispose();
  }
}
