import type { GameCommand } from './CommandTypes';
import type { Logger } from '../utils/Logger';
import { CommandError } from '../utils/errors';

export type CommandHandler<T extends GameCommand = GameCommand> = (command: T) => void;
export type CommandType = GameCommand['type'];

/**
 * FIFO command queue. UI and input never mutate game state directly — they
 * send commands; the state phase flushes them once per frame. This keeps the
 * data flow one-directional: UI/Input → Command → State.
 */
export class CommandBus {
  private readonly queue: GameCommand[] = [];
  private readonly handlers = new Map<CommandType, CommandHandler<never>>();

  constructor(private readonly logger?: Logger) {}

  register<K extends CommandType>(type: K, handler: CommandHandler<Extract<GameCommand, { type: K }>>): void {
    if (this.handlers.has(type)) {
      throw new CommandError(`Command handler already registered for "${type}"`);
    }
    this.handlers.set(type, handler as CommandHandler<never>);
  }

  send(command: GameCommand): void {
    this.queue.push(command);
  }

  /** Processes queued commands in FIFO order. Handler errors are isolated. */
  flush(): void {
    while (this.queue.length > 0) {
      const command = this.queue.shift() as GameCommand;
      const handler = this.handlers.get(command.type);
      if (handler === undefined) {
        this.logger?.warn(`No handler registered for command "${command.type}"`);
        continue;
      }
      try {
        (handler as CommandHandler<GameCommand>)(command);
      } catch (error) {
        this.logger?.error(`Command handler failed for "${command.type}"`, error);
      }
    }
  }

  get pending(): number {
    return this.queue.length;
  }

  clear(): void {
    this.queue.length = 0;
  }
}
