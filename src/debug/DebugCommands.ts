import type { CommandBus } from '../core/CommandBus';
import type { EventBus } from '../events/EventBus';
import type { Logger } from '../utils/Logger';
import type { GameState } from '../state/GameState';
import { primaryChunkOfRegion } from '../state/slices/worldSlice';

/**
 * Structural API the debug commands operate against (implemented by Game).
 * Keeping it structural avoids importing the concrete Game class here.
 */
export interface DebugGameApi {
  togglePause(): void;
  toggleAI(): void;
  toggleCombat(): void;
  setTick(tick: number): void;
  focusChunk(chunkId: string): void;
  notify(level: 'info' | 'warn' | 'error', title: string, message: string): void;
  spawnUnit(typeId: string, countryId: string, regionId: string): string;
  addResource(countryId: string, resourceId: string, amount: number): void;
  stateHash(): number;
  readonly playerCountryId: string;
  readonly stateRef: GameState;
  readonly bus: EventBus;
  readonly log: Logger;
  readonly commandBus: CommandBus;
}

/**
 * Registers the debug command set (behind the 'debug.command' command).
 * Available only when config.debug.enabled — see Game wiring.
 */
export function registerDebugCommandHandlers(game: DebugGameApi): void {
  game.commandBus.register('debug.command', (cmd) => {
    const args = cmd.args ?? {};
    switch (cmd.name) {
      case 'spawn_unit': {
        const typeId = String(args.typeId ?? 'infantry_squad');
        const regionId = String(args.regionId ?? '');
        try {
          const unitId = game.spawnUnit(typeId, game.playerCountryId, regionId);
          game.notify('info', 'Debug', `Spawned ${typeId} (${unitId})`);
        } catch (error) {
          game.notify('error', 'Debug', `Spawn failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        break;
      }
      case 'give_resource': {
        const resourceId = String(args.resourceId ?? 'food');
        const amount = Number(args.amount ?? 100);
        game.addResource(game.playerCountryId, resourceId, amount);
        game.notify('info', 'Debug', `+${amount} ${resourceId}`);
        break;
      }
      case 'set_tick':
        game.setTick(Number(args.tick ?? 0));
        break;
      case 'toggle_pause':
        game.togglePause();
        break;
      case 'toggle_ai':
        game.toggleAI();
        break;
      case 'toggle_combat':
        game.toggleCombat();
        break;
      case 'state_hash':
        game.notify('info', 'Debug', `State hash: ${game.stateHash().toString(16)}`);
        break;
      case 'focus_region': {
        const regionId = String(args.regionId ?? '');
        const chunkId = primaryChunkOfRegion(game.stateRef.world, regionId);
        if (chunkId !== null) game.focusChunk(chunkId);
        break;
      }
      default:
        game.log.warn(`Unknown debug command "${cmd.name}"`);
    }
    game.bus.emit('debug.commandExecuted', { name: cmd.name, args });
  });
}
