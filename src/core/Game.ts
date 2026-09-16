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
import type { TimeMode } from '../time/TimeSystem';
import { createInitialState } from '../state/createInitialState';
import { STATE_SLICE_KEYS } from '../state/GameState';
import type { GameState } from '../state/GameState';
import { DataRegistry } from '../data/DataRegistry';
import { WorldManager } from '../world/WorldManager';
import { generateStrategicMap } from '../world/map/MapGenerator';
import { pickAt, hoverAt, clampCamera, type PickEligibility } from '../world/map/MapQueries';
import { findGridCell } from '../world/map/MapGeography';
import {
  isKnownMapLayer,
  DEFAULT_LAYER_VISIBILITY,
  applyLayerToggle,
  normalizeLayerVisibility,
  type MapLayerId
} from '../world/map/MapLayers';
import { MapCameraController } from '../world/map/MapCameraController';
import type { StrategicMapModel } from '../world/map/MapTypes';
import { clearMapSelection, setMapSelection, setFeatureSelection, type MapFeatureSelection } from '../state/slices/mapSlice';
import { syncCountryCapitals } from '../state/slices/countrySlice';
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
  private stepSeconds: number;

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
  private mapModel!: StrategicMapModel;
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
    // Fixed sim step = 1 / tickRateHz real seconds at speed 1 (speed scales
    // the accumulator, so each step always advances the clock by the same
    // simulated duration — the rate of simulated time, not its meaning).
    this.stepSeconds = 1 / this.config.sim.tickRateHz;
    this.logger = new Logger(new ConsoleLogSink(), this.config.debug.logLevel, 'game');
    this.events = new EventBus(this.logger.child('events'));
    this.ids = new IdGenerator();
    this.rng = new Random(this.options.seed ?? 12345);
    this.commands = new CommandBus(this.logger.child('commands'));
    this.profiler = new Profiler();
    this.perf = new PerformanceManager(this.config.performance, this.events);
    this.data = new DataRegistry(this.logger.child('data'));
    this.time = new TimeSystem(this.config.time, this.events);
    // Static political map (Part 1) — deterministic, immutable, renderer-free.
    // Generated BEFORE the initial state so the country data slice (Part 2)
    // can join capitals + id space at construction time. Part 3: the DECLARED
    // profile populations anchor the geographic population tree — Σ provinces
    // (and Σ cities inside them) always equals the declared value exactly.
    const declaredPopulations = Object.fromEntries(
      this.data.countryProfileList.map((profile) => [profile.id, profile.population])
    );
    const mapGeneration = generateStrategicMap(this.config.map, { countryPopulations: declaredPopulations });
    this.mapModel = mapGeneration.model;
    for (const warning of mapGeneration.warnings) {
      this.logger.warn(`map: ${warning}`);
    }
    this.state = createInitialState(this.data, this.config, this.ids, this.mapModel);
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
        runtime: {
          tick: this.time.tick,
          stepCounter: this.time.step,
          rngState: this.rng.getState(),
          ids: this.ids.serialize(),
          timeMode: this.time.timeMode,
          speedStepIndex: this.time.speedStepIndex
        }
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
      map: this.mapModel,
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
    this.addSystem(new MapCameraController(this.events));

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

    // Fresh campaign: hand the choice of country to the player (Part 3).
    // The UI opens its country-select screen when it receives this event.
    if (!this.state.player.countryConfirmed) {
      this.events.emit('player.countrySelectionStarted', {});
    }

    this.events.emit('game.ready', { tick: this.time.tick });
    this.events.emit('map.generated', {
      seed: this.mapModel.seed,
      continentName: this.mapModel.continentName,
      countryCount: this.mapModel.stats.countries,
      provinceCount: this.mapModel.stats.provinces,
      cityCount: this.mapModel.stats.cities,
      warnings: mapGeneration.warnings
    });
    this.logger.info(
      `Game initialized: world "${this.state.world.worldId}", ${Object.keys(this.state.world.chunks).length} chunks, seed ${this.rng.getState()}`
    );
    this.logger.info(
      `Strategic map "${this.mapModel.continentName}": ${this.mapModel.stats.countries} countries, ` +
        `${this.mapModel.stats.provinces} provinces, ${this.mapModel.stats.cities} cities ` +
        `(${this.mapModel.stats.coastalCountries} coastal, ${this.mapModel.stats.landlockedCountries} landlocked)`
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
    // Country capitals are joined from the live map model — heals migrated
    // saves whose stored join may come from a different map config.
    syncCountryCapitals(this.state.countries.countries, this.mapModel);
    // New map layers (Part 3): fill in registry defaults ONLY for keys the
    // save does not carry — saved toggles always win over defaults.
    const visibility = this.state.map.layerVisibility as Record<string, boolean | undefined>;
    for (const [layer, visible] of Object.entries(DEFAULT_LAYER_VISIBILITY)) {
      if (typeof visibility[layer] !== 'boolean') visibility[layer] = visible;
    }
    // Exclusivity heal: older saves may carry two exclusive surface layers
    // ON at once (a composite this version no longer renders). Normalize to
    // the registry policy so the loaded state is always a valid surface mode.
    normalizeLayerVisibility(this.state.map.layerVisibility);
    // Defensive heal: migration v3→v4 normally injects this, but hand-made
    // saves / external tooling may miss the field.
    if (typeof this.state.player.countryConfirmed !== 'boolean') {
      this.state.player.countryConfirmed = true;
    }
    // Map selection references generated ids — heal selections that no longer
    // exist in the live model (seed/config drift across versions), keeping the
    // hierarchy consistent: city ⇒ province ⇒ country.
    const map = this.state.map;
    if (map.selectedCityId !== null && this.mapModel.cities[map.selectedCityId] === undefined) {
      map.selectedCityId = null;
    }
    if (map.selectedProvinceId !== null && this.mapModel.provinces[map.selectedProvinceId] === undefined) {
      map.selectedProvinceId = null;
      map.selectedCityId = null;
    }
    if (map.selectedCountryId !== null && this.mapModel.countries[map.selectedCountryId] === undefined) {
      map.selectedCountryId = null;
      map.selectedProvinceId = null;
      map.selectedCityId = null;
    }
    // Feature selections (Part 3.5) heal the same way — a stale key/id from
    // seed drift is dropped rather than rendered as a ghost selection.
    if (
      (map.selectedGridKey !== null && findGridCell(this.mapModel, map.selectedGridKey) < 0) ||
      (map.selectedRiverId !== null && !this.mapModel.features.rivers.some((r) => r.id === map.selectedRiverId)) ||
      (map.selectedLakeId !== null && !this.mapModel.features.lakes.some((l) => l.id === map.selectedLakeId)) ||
      (map.selectedSiteId !== null && !this.mapModel.features.sites.some((s) => s.id === map.selectedSiteId)) ||
      (map.selectedBuildingId !== null && !this.mapModel.features.buildings.some((b) => b.id === map.selectedBuildingId))
    ) {
      map.selectedGridKey = null;
      map.selectedRiverId = null;
      map.selectedLakeId = null;
      map.selectedSiteId = null;
      map.selectedBuildingId = null;
    }
    this.time.setTick(data.runtime.tick, data.runtime.stepCounter ?? 0);
    // Runtime extras (optional — older saves predate them): the time mode
    // and speed step restore only when present and valid; otherwise the
    // defaults (Hour, ×1) apply.
    if (typeof data.runtime.timeMode === 'string') {
      this.time.setTimeMode(data.runtime.timeMode as TimeMode);
    }
    if (typeof data.runtime.speedStepIndex === 'number') {
      this.time.setSpeedStep(data.runtime.speedStepIndex);
    }
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

  setPaused(paused: boolean): void {
    this.assertInitialized();
    this.time.setPaused(paused);
  }

  /**
   * Country-selection flow (Part 3): re-opens the "choose your country"
   * phase — the game pauses and the UI opens its countrySelect screen on the
   * emitted event. The player country stays whatever it was until confirm.
   */
  beginCountrySelection(): void {
    this.assertInitialized();
    this.state.player.countryConfirmed = false;
    if (!this.time.isPaused) this.time.togglePause();
    this.events.emit('player.countrySelectionStarted', {});
  }

  /**
   * Registers the player's country in the MAIN game state (state.player —
   * the single source of truth every future system reads), marks the choice
   * confirmed, centers the camera and resumes the campaign. Data-driven and
   * id-agnostic: works for any country present in the map model.
   */
  confirmCountrySelection(countryId: string): void {
    this.assertInitialized();
    if (this.mapModel.countries[countryId] === undefined) {
      this.logger.warn(`confirmCountrySelection: unknown country "${countryId}"`);
      return;
    }
    // Keep the map selection hierarchy consistent with the confirmed country.
    this.mapSelect({ countryId });
    this.state.player.countryId = countryId;
    this.state.player.countryConfirmed = true;
    this.mapFocusCountry(countryId);
    this.focusChunk(this.world.capitalChunkId(countryId));
    if (this.time.isPaused) this.time.togglePause();
    this.events.emit('player.countryConfirmed', { countryId });
  }

  setSpeed(speed: number): void {
    this.assertInitialized();
    this.time.setSpeed(speed);
  }

  setSpeedStep(index: number): void {
    this.assertInitialized();
    this.time.setSpeedStep(index);
  }

  cycleSpeed(): void {
    this.assertInitialized();
    this.time.cycleSpeed();
  }

  /** Sets the time mode (Hour/Day/Month/Year) — the Time Bar's write path. */
  setTimeMode(mode: 'hour' | 'day' | 'month' | 'year'): void {
    this.assertInitialized();
    this.time.setTimeMode(mode);
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

  // —— strategic map API (Part 1) — the ONLY mutation path for the map slice ——

  mapSelect(ids: { countryId?: string | null; provinceId?: string | null; cityId?: string | null }): void {
    this.assertInitialized();
    const map = this.state.map;
    const countryId = ids.countryId ?? null;
    const provinceId = ids.provinceId ?? null;
    const cityId = ids.cityId ?? null;
    if (cityId !== null) {
      const city = this.mapModel.cities[cityId];
      if (city === undefined) {
        this.logger.warn(`mapSelect: unknown city "${cityId}"`);
        return;
      }
      setMapSelection(map, {
        cityId: city.id,
        provinceId: city.provinceId,
        countryId: city.countryId
      });
    } else if (provinceId !== null) {
      const province = this.mapModel.provinces[provinceId];
      if (province === undefined) {
        this.logger.warn(`mapSelect: unknown province "${provinceId}"`);
        return;
      }
      setMapSelection(map, { provinceId: province.id, countryId: province.countryId });
    } else if (countryId !== null) {
      if (this.mapModel.countries[countryId] === undefined) {
        this.logger.warn(`mapSelect: unknown country "${countryId}"`);
        return;
      }
      setMapSelection(map, { countryId });
    } else {
      clearMapSelection(map);
    }
    this.emitSelectionChanged();
  }

  /** Pointer pick: resolves the top-most VISIBLE entity at a world position.
   *  The shared interaction semantics live in pickAt (MapQueries) — click and
   *  hover resolve identically headless and on screen. Eligibility follows
   *  layer visibility: a hidden layer is never selectable.
   *  Selection kinds are mutually exclusive: point features (city/site/
   *  building), linear features (river), area features (lake, grid cell) and
   *  the country hierarchy — the panel always shows ONE coherent selection. */
  mapPick(x: number, z: number): void {
    this.assertInitialized();
    const result = pickAt(this.mapModel, { x, z }, this.pickOptions());
    if (result.cityId !== null) {
      this.mapSelect({ cityId: result.cityId });
      return;
    }
    if (result.siteId !== null) {
      this.applyFeatureSelection({ kind: 'site', siteId: result.siteId });
      return;
    }
    if (result.buildingId !== null) {
      this.applyFeatureSelection({ kind: 'building', buildingId: result.buildingId });
      return;
    }
    if (result.riverId !== null) {
      this.applyFeatureSelection({ kind: 'river', riverId: result.riverId });
      return;
    }
    if (result.lakeId !== null) {
      this.applyFeatureSelection({ kind: 'lake', lakeId: result.lakeId });
      return;
    }
    if (result.gridCellKey !== null) {
      this.applyFeatureSelection({ kind: 'grid', gridKey: result.gridCellKey });
      return;
    }
    if (result.provinceId !== null || result.countryId !== null) {
      this.mapSelect({ provinceId: result.provinceId, countryId: result.countryId });
      return;
    }
    this.mapClearSelection();
  }

  /** Hover: resolves like a pick (no state mutation) and broadcasts the brief
   *  info (grid id + province, river/lake/city name ids) as an EVENT so the
   *  renderer can highlight a cell and the UI can show a tooltip. Ephemeral
   *  by design — hover is never saved, never hashed. */
  mapHover(x: number | null, z: number | null): void {
    this.assertInitialized();
    if (x === null || z === null) {
      this.events.emit('map.hoverChanged', { hover: null });
      return;
    }
    const result = hoverAt(this.mapModel, { x, z }, this.pickOptions());
    if (
      result.gridCellKey === null &&
      result.riverId === null &&
      result.lakeId === null &&
      result.cityId === null &&
      result.siteId === null
    ) {
      this.events.emit('map.hoverChanged', { hover: null });
      return;
    }
    this.events.emit('map.hoverChanged', {
      hover: {
        cellIndex: result.cellIndex,
        gridCellKey: result.gridCellKey,
        provinceId: result.provinceId,
        countryId: result.countryId,
        riverId: result.riverId,
        lakeId: result.lakeId,
        cityId: result.cityId,
        siteId: result.siteId
      }
    });
  }

  /** Pick/hover resolution options derived ONCE per interaction from the
   *  live state: geometry constants + layer-visibility eligibility. */
  private pickOptions(): {
    pickRadius: number;
    riverPickDistance: number;
    columns: number;
    rows: number;
    cellSize: number;
    eligibility: PickEligibility;
  } {
    const visibility = this.state.map.layerVisibility;
    const anySiteLayer =
      visibility.resources === true ||
      visibility.ports === true ||
      visibility.industry === true ||
      visibility.military === true;
    const anyBuildingLayer = visibility.buildings === true || visibility.airports === true;
    // PRECISE hit testing (§H): markers are drawn at FIXED world sizes, so
    // their hit radius is fixed world size too — never a zoom-scaled
    // fraction of the viewport (which used to grow to ~half a cell when
    // zoomed out and steal cell clicks for far-away cities/rivers).
    //   city hit  = between the drawn marker radius and the theme hit radius
    //   river hit = just outside the widest ribbon half-width — a click on
    //               the river SURFACE hits the river, open ground never does
    const theme = this.data.mapTheme;
    const zoomRadius = this.config.map.pickRadiusFraction * this.state.map.camera.viewHeight;
    const pickRadius = Math.min(
      Math.max(zoomRadius, theme.cityRadius),
      theme.cityHitRadius
    );
    const riverPickDistance = Math.max(theme.layerColors.riverWidth.max * 0.5 + 0.4, 0.9);
    return {
      pickRadius,
      riverPickDistance,
      columns: this.config.map.columns,
      rows: this.config.map.rows,
      cellSize: this.config.map.cellSize,
      eligibility: {
        grid: visibility.grid === true,
        rivers: visibility.rivers !== false,
        lakes: visibility.lakes !== false,
        sites: anySiteLayer,
        buildings: anyBuildingLayer,
        cities: visibility.cities !== false,
        capitals: visibility.capitals !== false
      }
    };
  }

  /** Applies a validated feature selection (unknown ids are ignored with a
   *  warning — stale ids can only come from hand-made state). */
  private applyFeatureSelection(selection: MapFeatureSelection): void {
    const map = this.state.map;
    const valid =
      (selection.kind === 'grid' && findGridCell(this.mapModel, selection.gridKey) >= 0) ||
      (selection.kind === 'river' &&
        this.mapModel.features.rivers.some((river) => river.id === selection.riverId)) ||
      (selection.kind === 'lake' &&
        this.mapModel.features.lakes.some((lake) => lake.id === selection.lakeId)) ||
      (selection.kind === 'site' &&
        this.mapModel.features.sites.some((site) => site.id === selection.siteId)) ||
      (selection.kind === 'building' &&
        this.mapModel.features.buildings.some((building) => building.id === selection.buildingId));
    if (!valid) {
      this.logger.warn(`mapPick: unknown feature ${JSON.stringify(selection)}`);
      return;
    }
    setFeatureSelection(map, selection);
    this.emitSelectionChanged();
  }

  mapClearSelection(): void {
    this.assertInitialized();
    clearMapSelection(this.state.map);
    this.emitSelectionChanged();
  }

  /**
   * THE single mutation path for layer visibility (command → here). Applies
   * the layer registry's exclusivity policy (e.g. enabling Biomes disables
   * Terrain and vice versa) AT THE STATE LEVEL — not by hiding UI — and
   * emits one event per actually-changed layer so every listener stays in
   * sync with the final visibility record.
   */
  mapSetLayerVisible(layer: string, visible: boolean): void {
    this.assertInitialized();
    if (!isKnownMapLayer(layer)) {
      this.logger.warn(`mapSetLayerVisible: unknown layer "${layer}"`);
      return;
    }
    const next = applyLayerToggle(this.state.map.layerVisibility, layer, visible);
    // Toggled layer first (the user's action), then exclusivity fallout.
    if (this.state.map.layerVisibility[layer] !== next[layer]) {
      this.state.map.layerVisibility[layer] = next[layer];
      this.events.emit('map.layerVisibilityChanged', { layer, visible: next[layer] });
    }
    for (const id of Object.keys(next) as MapLayerId[]) {
      if (id === layer) continue;
      if (this.state.map.layerVisibility[id] !== next[id]) {
        this.state.map.layerVisibility[id] = next[id];
        this.events.emit('map.layerVisibilityChanged', { layer: id, visible: next[id] });
      }
    }
  }

  /**
   * Applies a logical camera TARGET (the single mutation path for the map
   * camera state). When `cancelGesture` is set, an active cursor-anchored
   * zoom gesture is released first — explicit centering intents win.
   */
  private applyCameraTarget(
    view: { x?: number; z?: number; viewHeight?: number },
    cancelGesture: boolean
  ): void {
    const camera = this.state.map.camera;
    const aspect = this.state.map.viewport.width / this.state.map.viewport.height;
    const clamped = clampCamera(
      {
        x: view.x ?? camera.x,
        z: view.z ?? camera.z,
        viewHeight: view.viewHeight ?? camera.viewHeight,
        aspect
      },
      this.mapModel.bounds,
      this.config.map.minViewHeight,
      this.config.map.maxViewHeight
    );
    if (cancelGesture) {
      this.events.emit('map.zoomGesture', { anchor: null });
    }
    camera.x = clamped.x;
    camera.z = clamped.z;
    camera.viewHeight = clamped.viewHeight;
    this.events.emit('map.cameraChanged', {
      x: camera.x,
      z: camera.z,
      viewHeight: camera.viewHeight
    });
  }

  mapSetCamera(view: { x?: number; z?: number; viewHeight?: number }): void {
    this.assertInitialized();
    this.applyCameraTarget(view, true);
  }

  mapPanBy(dx: number, dz: number): void {
    this.assertInitialized();
    const camera = this.state.map.camera;
    this.applyCameraTarget({ x: camera.x + dx, z: camera.z + dz }, true);
  }

  /**
   * Zoom the logical camera target by `factor`.
   *
   * With an anchor + cursor pixel the new target center is solved EXACTLY so
   * the anchor world point stays under the cursor at the target view height;
   * a `map.zoomGesture` lets the presentation rig reproduce that anchoring
   * for every intermediate frame of the smoothed animation. Without an anchor
   * (keyboard zoom) the current center is kept and any active gesture is
   * preserved so wheel + keyboard zoom compose naturally.
   */
  mapZoomBy(factor: number, anchor?: { x: number; z: number }, screen?: { x: number; y: number }): void {
    this.assertInitialized();
    const camera = this.state.map.camera;
    const newViewHeight = camera.viewHeight * factor;
    if (anchor === undefined || screen === undefined) {
      this.applyCameraTarget({ viewHeight: newViewHeight }, false);
      return;
    }
    const viewport = this.state.map.viewport;
    const aspect = viewport.width / viewport.height;
    const ndcX = (screen.x / viewport.width) * 2 - 1;
    const ndcY = (screen.y / viewport.height) * 2 - 1;
    const halfWidth = (newViewHeight * aspect) / 2;
    const halfHeight = newViewHeight / 2;
    // Exact inverse of MapCamera.screenToWorld (north = -Z = screen top):
    // keep `anchor` under the cursor pixel for the whole animation.
    const x = anchor.x - ndcX * halfWidth;
    const z = anchor.z - ndcY * halfHeight;
    this.events.emit('map.zoomGesture', {
      anchor: { x: anchor.x, z: anchor.z, screenX: screen.x, screenY: screen.y }
    });
    this.applyCameraTarget({ x, z, viewHeight: newViewHeight }, false);
  }

  mapFocusCountry(countryId: string): void {
    this.assertInitialized();
    const country = this.mapModel.countries[countryId];
    if (country === undefined) {
      this.logger.warn(`mapFocusCountry: unknown country "${countryId}"`);
      return;
    }
    this.mapSetCamera({ x: country.labelPoint.x, z: country.labelPoint.z, viewHeight: 70 });
  }

  mapSetViewport(width: number, height: number): void {
    this.assertInitialized();
    if (!(width > 0 && height > 0)) return;
    this.state.map.viewport.width = width;
    this.state.map.viewport.height = height;
    // Re-clamp: the visible world rectangle changed with the aspect ratio.
    this.mapSetCamera({});
  }

  private emitSelectionChanged(): void {
    const map = this.state.map;
    this.events.emit('map.selectionChanged', {
      countryId: map.selectedCountryId,
      provinceId: map.selectedProvinceId,
      cityId: map.selectedCityId,
      gridKey: map.selectedGridKey,
      riverId: map.selectedRiverId,
      lakeId: map.selectedLakeId,
      siteId: map.selectedSiteId,
      buildingId: map.selectedBuildingId
    });
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

  get strategicMap(): StrategicMapModel {
    return this.mapModel;
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
