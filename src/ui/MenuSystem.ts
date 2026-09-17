import type { CommandBus } from '../core/CommandBus';
import type { GameCommand } from '../core/CommandTypes';
import type { UIElement } from './adapter/UIDomAdapter';
import type { ScreenManager } from './ScreenManager';

/**
 * Main / pause menu screens. Buttons emit commands only — never mutate
 * state — honoring the UI→Command→Core data-flow rule.
 */
export class MenuSystem {
  constructor(
    private readonly screens: ScreenManager,
    private readonly commands: CommandBus,
    private readonly create: (tag: string, className?: string) => UIElement
  ) {}

  private send(command: GameCommand): void {
    this.commands.send(command);
  }

  registerBuilders(): void {
    this.screens.registerScreen('mainMenu', (container) => this.buildMainMenu(container));
    this.screens.registerScreen('pauseMenu', (container) => this.buildPauseMenu(container));
  }

  private button(container: UIElement, label: string, onClick: () => void): void {
    const button = this.create('button');
    button.setText(label);
    button.onClick(onClick);
    container.appendChild(button);
  }

  private buildMainMenu(container: UIElement): void {
    const title = this.create('h1');
    title.setText('کشور');
    const subtitle = this.create('div', 'screen-subtitle');
    subtitle.setText('بازی استراتژیک ترکیبی ۲.۵بعدی/۳بعدی — ساخت نقشهٔ راهبردی');
    container.appendChild(title);
    container.appendChild(subtitle);

    // New Campaign → the country-selection flow (Part 3): the core pauses
    // and the UI opens its countrySelect screen on the emitted event.
    this.button(container, 'کارزار جدید', () => {
      this.send({ type: 'player.beginCountrySelection' });
    });
    this.button(container, 'بارگذاری آخرین ذخیرهٔ خودکار', () => {
      this.send({ type: 'save.load', slot: 'autosave' });
    });
  }

  private buildPauseMenu(container: UIElement): void {
    const title = this.create('h2');
    title.setText('بازی متوقف شد');
    container.appendChild(title);

    this.button(container, 'ادامه', () => {
      this.screens.close('pauseMenu');
      this.send({ type: 'game.togglePause' });
    });
    // Phase 2 — presidential command center.
    this.button(container, 'دفتر رئیس‌جمهور', () => {
      this.screens.close('pauseMenu');
      this.send({ type: 'ui.openScreen', screenId: 'president' });
    });
    this.button(container, 'ذخیرهٔ فوری', () => {
      this.send({ type: 'save.save', slot: 'quick', label: 'ذخیرهٔ فوری' });
    });
    this.button(container, 'منوی اصلی', () => {
      this.screens.close('pauseMenu');
      this.screens.open('mainMenu');
    });
  }
}
