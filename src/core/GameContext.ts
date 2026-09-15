import type { GameConfig } from '../config/configTypes';
import type { EventBus } from '../events/EventBus';
import type { GameState } from '../state/GameState';
import type { TimeSystem } from '../time/TimeSystem';
import type { Random } from '../utils/Random';
import type { Logger } from '../utils/Logger';
import type { Profiler } from '../debug/Profiler';
import type { WorldManager } from '../world/WorldManager';
import type { AssetManager } from '../assets/AssetManager';
import type { DataRegistry } from '../data/DataRegistry';
import type { PerformanceManager } from '../perf/PerformanceManager';
import type { CommandBus } from './CommandBus';
import type { IdGenerator } from './IdGenerator';

/**
 * Minimal input surface systems may consume (structural — keeps the context
 * independent of the concrete InputManager, so no dependency cycles form).
 */
export interface InputSurface {
  isDown(action: string): boolean;
}

/**
 * Service locator handed to every system at init time.
 *
 * Deliberately exposes only shared services; systems keep their own internal
 * state and never reach into each other. Accessing slices MUST happen through
 * `state` on every use (never cache slice references) so save/load can swap
 * slice contents in place.
 */
export interface SystemContext {
  readonly config: GameConfig;
  readonly events: EventBus;
  readonly state: GameState;
  readonly time: TimeSystem;
  readonly rng: Random;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly profiler: Profiler;
  readonly data: DataRegistry;
  readonly world: WorldManager;
  readonly assets: AssetManager;
  readonly perf: PerformanceManager;
  readonly commands: CommandBus;
  readonly input: InputSurface | null;
}
