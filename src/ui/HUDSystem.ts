import type { SystemContext } from '../core/GameContext';
import type { UIElement } from './adapter/UIDomAdapter';
import { buildHudModel } from './HUDModel';
import { formatSpeedLabel } from './HUDModel';
import { formatCalendarElapsed } from '../time/Calendar';
import type { TimeMode } from '../time/TimeSystem';
import type { PlayerModeSystem } from '../player/PlayerModeSystem';
import type { CommandBus } from '../core/CommandBus';

/**
 * HUD view: bottom-left status panel + TOP-CENTER TIME BAR.
 * Everything reflects state (never owns it): the date and the pause/speed
 * buttons read SystemContext.time — THE single source of truth for the game
 * clock — and only send commands (game.setPaused / game.setSpeedStep).
 * Built through the UIDomAdapter so logic stays DOM-free and testable.
 */
export class HUDSystem {
  private readonly rows: { key: UIElement; value: UIElement }[] = [];
  private readonly panel: UIElement;
  private readonly timeBar: UIElement;
  private readonly dateLabel: UIElement;
  private readonly pauseButton: UIElement;
  private readonly modeButtons: UIElement[] = [];
  private readonly speedButtons: UIElement[] = [];
  private timeBarBuilt = false;

  constructor(
    container: UIElement,
    private readonly adapter: { create(tag: string, className?: string): UIElement },
    private readonly modes: PlayerModeSystem,
    private readonly commands: CommandBus
  ) {
    // —— time bar (top-center): date + MODE segment + play/pause + speeds ——
    this.timeBar = adapter.create('div', 'time-bar');
    this.dateLabel = adapter.create('span', 'time-date');
    this.timeBar.appendChild(this.dateLabel);
    // Pause is created NOW but appended on first update, AFTER the mode
    // segment (button order: date · Hour/Day/Month/Year · pause · speeds).
    this.pauseButton = adapter.create('button', 'time-btn pause');
    this.pauseButton.onClick(() => {
      this.commands.send({ type: 'game.togglePause' });
    });
    container.appendChild(this.timeBar);
    // Mode + speed buttons are added on first update — they are generated
    // from the data-driven lists owned by the TimeSystem.

    // —— status panel (bottom-left) ——
    this.panel = adapter.create('div', 'hud');
    const title = adapter.create('div', 'hud-title');
    title.setText('COUNTRY');
    this.panel.appendChild(title);
    container.appendChild(this.panel);

    for (const key of ['Mode', 'Treasury', 'Population', 'Chunks']) {
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

  /** Builds the mode + speed buttons once, from the TimeSystem's own lists. */
  private ensureTimeBarButtons(context: SystemContext): void {
    if (this.timeBarBuilt) return;
    this.timeBarBuilt = true;
    // —— mode segment: the UNIT the clock advances in ——
    const modeLabels: Record<TimeMode, string> = { hour: 'Hour', day: 'Day', month: 'Month', year: 'Year' };
    for (const mode of context.time.timeModeList) {
      const button = this.adapter.create('button', 'time-btn mode');
      button.setText(modeLabels[mode]);
      button.setAttribute('title', `Advance by ${modeLabels[mode].toLowerCase()}`);
      const modeValue = mode;
      button.onClick(() => {
        this.commands.send({ type: 'game.setTimeMode', mode: modeValue });
      });
      this.timeBar.appendChild(button);
      this.modeButtons.push(button);
    }
    // Pause follows the mode segment (appended here — see constructor).
    this.timeBar.appendChild(this.pauseButton);
    // —— speed steps: how FAST the chosen unit passes (separate from mode) ——
    const steps = context.time.speedStepList;
    for (let index = 0; index < steps.length; index++) {
      const button = this.adapter.create('button', 'time-btn speed');
      button.setText(formatSpeedLabel(steps[index]));
      const stepIndex = index;
      button.onClick(() => {
        this.commands.send({ type: 'game.setSpeedStep', index: stepIndex });
      });
      this.timeBar.appendChild(button);
      this.speedButtons.push(button);
    }
  }

  update(context: SystemContext): void {
    const state = context.state;
    this.ensureTimeBarButtons(context);
    const modeName = state.player.mode !== null ? this.modes.modeDef(state.player.mode).name : '—';
    const model = buildHudModel(state, modeName, context.world.counts());
    const values = [model.mode, model.treasury, model.population, model.chunks];
    for (let index = 0; index < this.rows.length; index++) {
      this.rows[index].value.setText(values[index] ?? '');
    }

    // —— time bar reflects the clock (read-only view of the source of truth) ——
    // Campaign-elapsed form of the central clock: "Year 1 — January — Day 1 — 08:00".
    this.dateLabel.setText(formatCalendarElapsed(context.time.date, context.time.startDate));
    const paused = context.time.isPaused;
    this.pauseButton.setText(paused ? 'Play' : 'Pause');
    this.pauseButton.setClass(paused ? 'time-btn pause stopped' : 'time-btn pause');
    const activeModeIndex = context.time.timeModeIndex;
    for (let index = 0; index < this.modeButtons.length; index++) {
      this.modeButtons[index].setClass(
        index === activeModeIndex ? 'time-btn mode on' : 'time-btn mode'
      );
    }
    const activeIndex = context.time.speedStepIndex;
    for (let index = 0; index < this.speedButtons.length; index++) {
      this.speedButtons[index].setClass(
        index === activeIndex ? 'time-btn speed on' : 'time-btn speed'
      );
    }
  }

  setVisible(visible: boolean): void {
    this.panel.setVisible(visible);
  }
}
