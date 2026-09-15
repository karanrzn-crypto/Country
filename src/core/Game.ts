import { resolveConfig } from '../config/GameConfig';
import type { DeepPartial } from '../config/GameConfig';
import type { GameConfig } from '../config/configTypes';
import { EventBus } from '../events/EventBus';
import { CommandBus } from './CommandBus';
import { GameLoop } from './GameLoop';
import { ManualFrameClock, RafFrameClock } from './GameLoop';
import type { FrameClock } from './GameLoop';
import { IdGenerator } from './IdGenerator';
import { Logger, ConsoleLogSink } from '../utils/Logger';
import { Random } from '../utils/Random';
import { hashValue } from '../utils/hash';
import { WorldError, StateError } from '../utils/errors';
import { TimeSystem } from '../time/TimeSystem';
import { createInitialState } from '../state/createInitialState';
import { STATE_SLICE_KEYS } from '../state/GameState';
import type { GameState } from '../state/GameState';
import { DataRegistry } from '../data/DataRegistry';
import { WorldManager } from '../world/WorldManager';
import { AssetRegistry } from '../assets/AssetRegistry';
import { AssetCache } from '../assets/AssetCache';
import { AssetManager } from '../assets/AssetManager';
import { GeneratedAssetLoader } from '../assets/loaders';
import { Profiler } from '../debug/Profiler';
import { PerformanceManager } from '../perf/PerformanceManager';
import { SimulationEngine } from '../simulation/SimulationEngine';
import { createDefaultSimulationSystems } from '../simulation/createSimulationSystems';
import { AIManager } from '../ai/AIManager';
import { CombatSystem } from '../combat/CombatSystem';
import { PlayerModeSystem } from '../player/PlayerModeSystem';
import { PlayerController } from '../player/PlayerController';
import { InputManager } from '../input/InputManager';
import type { InputSource } from '../input/InputTypes';
import { UIManager } from '../ui/UIManager';
import type { UIDomAdapter } from '../ui/adapter/UIDomAdapter';
import { SaveManager } from '../save/SaveManager';
import { MemorySaveStorage } from '../save/SaveStorage';
import type { SaveStorage } from '../save/SaveStorage';
import type { SaveData } from '../save/SaveTypes';
import { registerCoreCommandHandlers } from './CommandHandlers';
import { registerDebugCommandHandlers } from '../debug/DebugCommands';
import { DebugOverlay } from '../debug/DebugOverlay';
import type { IGameRenderer } from './RendererAdapter';
import type { FrameInfo, GamePhase, PhaseSystem, SystemUpdate } from './SystemTypes';
import type { SystemContext } from './GameContext';
import { createUnitFromType } from '../military/spawnUnit';
import { addStockpile } from '../state/slices/economySlice';

export interface GameOptions {
  readonly configOverrides?: DeepPartial<GameConfig>;
  readonly renderer?: IGameRenderer;
  readonly uiAdapter?: UIDomAdapter;
  readonly inputSource?: InputSource;
  readonly saveStorage?: SaveStorage;
  readonly seed?: number;
  readonly frameClock?: FrameClock;
}

const FRAME_PHASES: readonly GamePhase[] = ['input', 'state', 'render'];

/**
 * The Game kernel — composition root of the whole architecture.
 *
 * Owns the fixed-timestep loop and phase scheduling
 * (Input → State → Simulation → AI → Combat → Rendering), builds every
 * subsystem and hands them a shared SystemContext. The kernel contains no
 * gameplay logic itself; it wires and schedules.
 *
 * Headless usage (no renderer / ui / input) is a first-class mode: the same
 * class runs and is tested without Three.js.
 */
export class Game {
  private readonly options: GameOptions;
  private readonly systems: PhaseSystem[] = [];
  private readonly renderer: IGameRenderer | null;
  private loop: GameLoop | null = null;
  private initialized = false;
  private accumulator = 0;
  private readonly stepSeconds: number;

  // Built during init():
  private config!: GameConfig;
  private logger!: Logger;
  private events!: EventBus;
  private ids!: IdGenerator;
  private rng!: Random;
  private commands!: CommandBus;
  private profiler!: Profiler;
  private perf!: PerformanceManager;
  private data!: DataRegistry;
  private time!: TimeSystem;
  private state!: GameState;
  private world!: WorldManager;
  private assets!: AssetManager;
  private context!: SystemContext;
  private playerModeSystem!: PlayerModeSystem;
  private simEngine!: SimulationEngine;
  private aiManager!: AIManager;
  private combatSystem!: CombatSystem;
  private inputManager: InputManager | null = null;
  private uiManager: UIManager | null = null;
  private saveManager!: SaveManager;

  constructor(options: GameOptions = {}) {
    this.options = options;
    this.renderer = options.renderer ?? null;
    // Placeholder; recomputed in init() from the resolved config.
    this.stepSeconds = 1 / 5;
  }

  // —— lifecycle ——

  init(): void {
    if (this.initialized) throw new StateError('Game already initialized');

    this.config = resolveConfig(this.options.configOverrides);
    this.logger = new Logger(new ConsoleLogSink(), this.config.debug.logLevel, 'game');
    this.events = new EventBus(this.logger.child('events'));
    this.ids = new IdGenerator();
    this.rng = new Random(this.options.seed ?? 12345);
    this.commands = new CommandBus(this.logger.child('commands'));
    this.profiler = new Profiler();
    this.perf = new PerformanceManager(this.config.performance, this.events);
    this.data = new DataRegistry(this.logger.child('data'));
    this.time = new TimeSystem(this.config.time, this.events);
    this.state = createInitialState(this.data, this.config, this.ids);
    this.world = new WorldManager(this.state.world, this.events, this.config.world);
    this.assets = new AssetManager(new AssetRegistry(), new AssetCache(), this.events, this.logger.child('assets'));
    this.assets.registerLoader(new GeneratedAssetLoader());
    this.playerModeSystem = new PlayerModeSystem(this.data.playerModeList, this.events);

    this.saveManager = new SaveManager({
      storage: this.options.saveStorage ?? new MemorySaveStorage(),
      logger: this.logger.child('save'),
      events: this.events,
      autoSaveIntervalTicks: this.config.save.autoSaveIntervalTicks,
      getSnapshot: () => ({
        state: this.state,
        runtime: { tick: this.time.tick, rngState: this.rng.getState(), ids: this.ids.serialize() }
      }),
      applySnapshot: (data) => this.applyLoadedSnapshot(data)
    });

    this.context = {
      config: this.config,
      events: this.events,
      state: this.state,
      time: this.time,
      rng: this.rng,
      ids: this.ids,
      logger: this.logger,
      profiler: this.profiler,
      data: this.data,
      world: this.world,
      assets: this.assets,
      perf: this.perf,
      commands: this.commands,
      input: null
    };

    // Renderer first: it subscribes to chunk/mode events before streaming starts.
    this.renderer?.init(this.context);

    // —— phase systems (registration order = execution order per phase) ——
    this.inputManager = new InputManager(this.options.inputSource ?? null, this.data.inputBindings, this.events);
    this.context = { ...this.context, input: this.inputManager };
    this.addSystem(this.inputManager);
    this.addSystem(new PlayerController());
    this.addSystem({
      id: 'core.commands',
      phase: 'state',
      update: (ctx) => ctx.commands.flush()
    });
    this.addSystem({
      id: 'core.streaming',
      phase: 'state',
      update: (ctx) => ctx.world.streamTick()
    });

    this.simEngine = new SimulationEngine(createDefaultSimulationSystems(this.config), this.logger.child('sim'));
    this.addSystem(this.simEngine);
    this.aiManager = new AIManager(this.events, this.ids);
    this.addSystem(this.aiManager);
    this.combatSystem = new CombatSystem(this.events, this.ids);
    this.addSystem(this.combatSystem);

    if (this.options.uiAdapter !== undefined) {
      this.uiManager = new UIManager(
        this.options.uiAdapter,
        this.playerModeSystem,
        this.commands,
        this.events,
        this.logger.child('ui')
      );
      this.addSystem(this.uiManager);
      if (this.config.debug.enabled) {
        this.addSystem(this.buildDebugOverlay());
      }
    }

    registerCoreCommandHandlers(this);
    if (this.config.debug.enabled) {
      registerDebugCommandHandlers(this);
    }

    for (const system of this.systems) {
      system.init?.(this.context);
    }

    // From here on the kernel is operational (focusChunk asserts this).
    this.initialized = true;

    // Initial camera focus on the player capital + default mode.
    this.focusChunk(this.world.capitalChunkId(this.state.player.countryId));
    this.playerModeSystem.setMode(this.state, 'president');

    this.events.emit('game.ready', { tick: this.time.tick });
    this.logger.info(
      `Game initialized: world "${this.state.world.worldId}", ${Object.keys(this.state.world.chunks).length} chunks, seed ${this.rng.getState()}`
    );
  }

  start(): void {
    this.assertInitialized();
    if (this.loop !== null && this.loop.isRunning) return;
    const clock = this.options.frameClock ?? (this.renderer !== null ? new RafFrameClock() : new ManualFrameClock());
    this.loop = new GameLoop(clock, (dt) => this.frame(dt));
    this.loop.start();
  }

  stop(): void {
    this.loop?.stop();
  }

  dispose(): void {
    this.stop();
    for (const system of [...this.systems].reverse()) {
      system.dispose?.();
    }
    this.systems.length = 0;
    this.renderer?.dispose();
    this.assets.disposeAll();
    this.events.clear();
    this.initialized = false;
  }

  // —— frame & tick ——

  /** One rendered frame: input → state → fixed sim ticks → render. */
  frame(dtRealSeconds: number): void {
    this.assertInitialized();
    const frameInfo: FrameInfo = {
      frameIndex: this.profiler.frames + 1,
      dtRealSeconds,
      simTicksThisFrame: 0
    };
    this.profiler.beginFrame();

    for (const phase of FRAME_PHASES) {
      this.profiler.mark(`frame.${phase}`);
      for (const system of this.systems) {
        if (system.phase !== phase) continue;
        const update: SystemUpdate = { kind: 'frame', frame: frameInfo };
        this.profiler.mark(`sys.${system.id}`);
        try {
          system.update(this.context, update);
        } finally {
          this.profiler.endMark(`sys.${system.id}`);
        }
      }
      this.profiler.endMark(`frame.${phase}`);
    }

    // Fixed-timestep simulation driven by an accumulator (speed-aware).
    const speed = this.time.isPaused ? 0 : this.time.speed;
    this.accumulator += dtRealSeconds * speed;
    let steps = 0;
    this.profiler.mark('frame.simulation');
    while (this.accumulator >= this.stepSeconds && steps < this.config.sim.maxCatchUpSteps) {
      this.accumulator -= this.stepSeconds;
      steps += 1;
      this.runTick();
    }
    this.profiler.endMark('frame.simulation');
    if (this.accumulator > this.stepSeconds) this.accumulator = 0; // drop backlog
    frameInfo.simTicksThisFrame = steps;

    this.renderer?.render({ state: this.state, frameIndex: frameInfo.frameIndex, dtSeconds: dtRealSeconds });
    this.perf.sampleFrame(dtRealSeconds);
    this.profiler.endFrame();
  }

  /** One fixed simulation tick: time → simulation → AI → combat. */
  runTick(): void {
    this.assertInitialized();
    this.profiler.mark('tick.total');
    const tickInfo = this.time.advance();
    const update: SystemUpdate = { kind: 'tick', tick: tickInfo };
    for (const system of this.systems) {
      if (system.phase !== 'simulation' && system.phase !== 'ai' && system.phase !== 'combat') continue;
      this.profiler.mark(`sys.${system.id}`);
      try {
        system.update(this.context, update);
      } finally {
        this.profiler.endMark(`sys.${system.id}`);
      }
    }
    this.saveManager.onTick(tickInfo.tick);
    this.profiler.endMark('tick.total');
  }

  /** Test/headless helper: run N frames of the given delta. */
  runFrames(count: number, dtSeconds = 1 / 60): void {
    for (let index = 0; index < count; index++) this.frame(dtSeconds);
  }

  /** Test/headless helper: run N simulation ticks directly (no rendering). */
  runTicks(count: number): void {
    for (let index = 0; index < count; index++) this.runTick();
  }

  private addSystem(system: PhaseSystem): void {
    this.systems.push(system);
  }

  private buildDebugOverlay(): PhaseSystem {
    return new DebugOverlay(this.options.uiAdapter ?? null, this.config.debug.overlayVisibleByDefault, [
      { label: 'ai', read: () => this.aiManager.getStats() },
      { label: 'combat', read: () => this.combatSystem.getStats() },
      { label: 'assets', read: () => ({ ...this.assets.stats }) }
    ]);
  }

  private applyLoadedSnapshot(data: SaveData): void {
    // Slice identity is preserved (managers hold references); contents swap.
    for (const key of STATE_SLICE_KEYS) {
      Object.assign(this.state[key] as object, data.state[key] as object);
    }
    this.time.setTick(data.runtime.tick);
    this.rng.setState(data.runtime.rngState);
    this.ids.restore(data.runtime.ids);
    const focus = this.state.player.focusChunkId ?? this.world.capitalChunkId(this.state.player.countryId);
    this.world.setFocusChunk(focus, Number.MAX_SAFE_INTEGER);
    this.accumulator = 0;
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new StateError('Game is not initialized — call init() first');
  }

  // —— public API used by command handlers / tests / debug ——

  togglePause(): void {
    this.assertInitialized();
    this.time.togglePause();
  }

  setSpeed(speed: number): void {
    this.assertInitialized();
    this.time.setSpeed(speed);
  }

  setPlayerMode(mode: Parameters<PlayerModeSystem['setMode']>[1]): boolean {
    this.assertInitialized();
    return this.playerModeSystem.setMode(this.state, mode);
  }

  focusChunk(chunkId: string): void {
    this.assertInitialized();
    if (this.state.world.chunks[chunkId] === undefined) {
      throw new WorldError(`Unknown chunk "${chunkId}"`);
    }
    this.state.player.focusChunkId = chunkId;
    this.world.setFocusChunk(chunkId);
    this.events.emit('player.focusChunkChanged', { chunkId });
  }

  selectEntities(entityIds: readonly string[]): void {
    this.assertInitialized();
    this.state.player.selection = [...entityIds];
    this.events.emit('player.selectionChanged', { entityIds: [...entityIds] });
  }

  saveToSlot(slot: string, label?: string): void {
    this.assertInitialized();
    this.saveManager.save(slot, label ?? '');
  }

  loadFromSlot(slot: string): void {
    this.assertInitialized();
    this.saveManager.load(slot);
  }

  listSaves() {
    return this.saveManager.list();
  }

  spawnUnit(typeId: string, countryId: string, regionId: string): string {
    this.assertInitialized();
    const unit = createUnitFromType(this.data, this.ids, typeId, countryId, regionId);
    this.state.military.units[unit.id] = unit;
    this.events.emit('military.unitSpawned', {
      unitId: unit.id,
      typeId,
      factionId: countryId,
      regionId
    });
    return unit.id;
  }

  addResource(countryId: string, resourceId: string, amount: number): void {
    this.assertInitialized();
    addStockpile(this.state.economy.stockpiles, countryId, resourceId, amount);
  }

  setTick(tick: number): void {
    this.assertInitialized();
    this.time.setTick(tick);
  }

  toggleAI(): void {
    this.assertInitialized();
    this.aiManager.setEnabled(!this.aiManager.isEnabled);
  }

  toggleCombat(): void {
    this.assertInitialized();
    this.combatSystem.setEnabled(!this.combatSystem.isEnabled);
  }

  stateHash(): number {
    this.assertInitialized();
    return hashValue(this.state);
  }

  notify(level: 'info' | 'warn' | 'error', title: string, message: string): void {
    this.uiManager?.notify(level, title, message);
  }

  openScreen(screenId: string): void {
    this.uiManager?.openScreen(screenId);
  }

  closeScreen(screenId: string): void {
    this.uiManager?.closeScreen(screenId);
  }

  // —— typed getters ——

  get isInitialized(): boolean {
    return this.initialized;
  }

  get bus(): EventBus {
    return this.events;
  }

  get log(): Logger {
    return this.logger;
  }

  get commandBus(): CommandBus {
    return this.commands;
  }

  get gameConfig(): GameConfig {
    return this.config;
  }

  get gameState(): GameState {
    return this.state;
  }

  get gameEvents(): EventBus {
    return this.events;
  }

  get gameCommands(): CommandBus {
    return this.commands;
  }

  get gameTime(): TimeSystem {
    return this.time;
  }

  get gameWorld(): WorldManager {
    return this.world;
  }

  get gameRng(): Random {
    return this.rng;
  }

  get gameIds(): IdGenerator {
    return this.ids;
  }

  get gameData(): DataRegistry {
    return this.data;
  }

  get gameContext(): SystemContext {
    return this.context;
  }

  get gameProfiler(): Profiler {
    return this.profiler;
  }

  get gamePerf(): PerformanceManager {
    return this.perf;
  }

  get ai(): AIManager {
    return this.aiManager;
  }

  get combat(): CombatSystem {
    return this.combatSystem;
  }

  get playerModes(): PlayerModeSystem {
    return this.playerModeSystem;
  }

  get ui(): UIManager | null {
    return this.uiManager;
  }

  get loggerRef(): Logger {
    return this.logger;
  }

  get playerCountryId(): string {
    return this.state.player.countryId;
  }

  get stateRef(): GameState {
    return this.state;
  }
}
