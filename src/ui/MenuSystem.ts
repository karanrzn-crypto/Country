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
    title.setText('COUNTRY');
    const subtitle = this.create('div', 'screen-subtitle');
    subtitle.setText('Hybrid 2.5D/3D strategy — Phase 0 foundation build');
    container.appendChild(title);
    container.appendChild(subtitle);

    this.button(container, 'New Campaign', () => {
      this.screens.close('mainMenu');
      this.send({ type: 'game.togglePause' });
    });
    this.button(container, 'Load Latest Autosave', () => {
      this.send({ type: 'save.load', slot: 'autosave' });
    });
  }

  private buildPauseMenu(container: UIElement): void {
    const title = this.create('h2');
    title.setText('Paused');
    container.appendChild(title);

    this.button(container, 'Resume', () => {
      this.screens.close('pauseMenu');
      this.send({ type: 'game.togglePause' });
    });
    this.button(container, 'Save Now', () => {
      this.send({ type: 'save.save', slot: 'quick', label: 'Quick save' });
    });
    this.button(container, 'Main Menu', () => {
      this.screens.close('pauseMenu');
      this.screens.open('mainMenu');
    });
  }
}
