import type { Logger } from '../utils/Logger';
import type { EventBus } from '../events/EventBus';
import type { UIManager } from '../ui/UIManager';
import type { CommandBus } from './CommandBus';
import type { PlayerModeId } from '../player/types';

type EntityId = string;

/**
 * Structural API the command handlers operate against. Game implements this;
 * handlers depend on the interface (never on the concrete Game class) which
 * keeps the dependency graph acyclic.
 */
export interface CoreGameApi {
  togglePause(): void;
  setSpeed(speed: number): void;
  setPlayerMode(mode: PlayerModeId): boolean;
  focusChunk(chunkId: string): void;
  selectEntities(entityIds: readonly EntityId[]): void;
  saveToSlot(slot: string, label?: string): void;
  loadFromSlot(slot: string): void;
  readonly ui: UIManager | null;
  readonly bus: EventBus;
  readonly log: Logger;
  readonly commandBus: CommandBus;
}

/** Registers the standard command set (game, player, ui, save). */
export function registerCoreCommandHandlers(game: CoreGameApi): void {
  const bus = game.commandBus;
  bus.register('game.togglePause', () => game.togglePause());
  bus.register('game.setSpeed', (cmd) => game.setSpeed(cmd.speed));
  bus.register('player.setMode', (cmd) => game.setPlayerMode(cmd.mode));
  bus.register('player.focusChunk', (cmd) => game.focusChunk(cmd.chunkId));
  bus.register('player.select', (cmd) => game.selectEntities(cmd.entityIds));
  bus.register('ui.openScreen', (cmd) => game.ui?.openScreen(cmd.screenId));
  bus.register('ui.closeScreen', (cmd) => game.ui?.closeScreen(cmd.screenId));
  bus.register('ui.notify', (cmd) => game.ui?.notify(cmd.level, cmd.title, cmd.message));
  bus.register('save.save', (cmd) => game.saveToSlot(cmd.slot, cmd.label));
  bus.register('save.load', (cmd) => game.loadFromSlot(cmd.slot));
}
