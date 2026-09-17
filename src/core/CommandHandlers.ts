import type { Logger } from '../utils/Logger';
import type { EventBus } from '../events/EventBus';
import type { UIManager } from '../ui/UIManager';
import type { CommandBus } from './CommandBus';
import type { PlayerModeId } from '../player/types';
import type { TimeMode } from '../time/TimeSystem';

type EntityId = string;

/**
 * Structural API the command handlers operate against. Game implements this;
 * handlers depend on the interface (never on the concrete Game class) which
 * keeps the dependency graph acyclic.
 */
export interface CoreGameApi {
  togglePause(): void;
  setPaused(paused: boolean): void;
  setSpeed(speed: number): void;
  setSpeedStep(index: number): void;
  cycleSpeed(): void;
  setTimeMode(mode: TimeMode): void;
  setPlayerMode(mode: PlayerModeId): boolean;
  focusChunk(chunkId: string): void;
  selectEntities(entityIds: readonly EntityId[]): void;
  beginCountrySelection(): void;
  confirmCountrySelection(countryId: string): void;
  saveToSlot(slot: string, label?: string): void;
  loadFromSlot(slot: string): void;
  mapSelect(ids: { countryId?: string | null; provinceId?: string | null; cityId?: string | null }): void;
  mapPick(x: number, z: number): void;
  mapHover(x: number | null, z: number | null): void;
  mapClearSelection(): void;
  mapSetLayerVisible(layer: string, visible: boolean): void;
  mapSetSelectionMode(mode: 'country' | 'province'): void;
  mapSetCamera(view: { x?: number; z?: number; viewHeight?: number }): void;
  mapPanBy(dx: number, dz: number): void;
  mapZoomBy(factor: number, anchor?: { x: number; z: number }, screen?: { x: number; y: number }): void;
  mapFocusCountry(countryId: string): void;
  mapSetViewport(width: number, height: number): void;
  governmentSetTaxRate(countryId: string, category: 'income' | 'corporate' | 'trade', value: number): void;
  governmentSetSpending(
    countryId: string,
    category: 'military' | 'healthcare' | 'education' | 'infrastructure' | 'welfare' | 'government' | 'other',
    value: number
  ): void;
  governmentSetMinistryFunding(countryId: string, ministryId: string, value: number): void;
  governmentEnactDecision(countryId: string, decisionId: string): boolean;
  governmentResolveEvent(countryId: string, instanceId: string, choiceId: string): boolean;
  economySetImportPolicy(countryId: string, resourceId: string, active: boolean): void;
  economySetExportPolicy(countryId: string, resourceId: string, active: boolean): void;
  readonly ui: UIManager | null;
  readonly bus: EventBus;
  readonly log: Logger;
  readonly commandBus: CommandBus;
}

/** Registers the standard command set (game, player, ui, save, map). */
export function registerCoreCommandHandlers(game: CoreGameApi): void {
  const bus = game.commandBus;
  bus.register('game.togglePause', () => game.togglePause());
  bus.register('game.setPaused', (cmd) => game.setPaused(cmd.paused));
  bus.register('game.setSpeed', (cmd) => game.setSpeed(cmd.speed));
  bus.register('game.setSpeedStep', (cmd) => game.setSpeedStep(cmd.index));
  bus.register('game.cycleSpeed', () => game.cycleSpeed());
  bus.register('game.setTimeMode', (cmd) => game.setTimeMode(cmd.mode));
  bus.register('player.setMode', (cmd) => game.setPlayerMode(cmd.mode));
  bus.register('player.focusChunk', (cmd) => game.focusChunk(cmd.chunkId));
  bus.register('player.select', (cmd) => game.selectEntities(cmd.entityIds));
  bus.register('player.beginCountrySelection', () => game.beginCountrySelection());
  bus.register('player.confirmCountry', (cmd) => game.confirmCountrySelection(cmd.countryId));
  bus.register('ui.openScreen', (cmd) => game.ui?.openScreen(cmd.screenId));
  bus.register('ui.closeScreen', (cmd) => game.ui?.closeScreen(cmd.screenId));
  bus.register('ui.notify', (cmd) => game.ui?.notify(cmd.level, cmd.title, cmd.message));
  bus.register('save.save', (cmd) => game.saveToSlot(cmd.slot, cmd.label));
  bus.register('save.load', (cmd) => game.loadFromSlot(cmd.slot));
  bus.register('map.select', (cmd) =>
    game.mapSelect({ countryId: cmd.countryId, provinceId: cmd.provinceId, cityId: cmd.cityId })
  );
  bus.register('map.pick', (cmd) => game.mapPick(cmd.x, cmd.z));
  bus.register('map.hover', (cmd) => game.mapHover(cmd.x, cmd.z));
  bus.register('map.clearSelection', () => game.mapClearSelection());
  bus.register('map.setLayerVisible', (cmd) => game.mapSetLayerVisible(cmd.layer, cmd.visible));
  bus.register('map.setSelectionMode', (cmd) => game.mapSetSelectionMode(cmd.mode));
  bus.register('map.setCamera', (cmd) => game.mapSetCamera({ x: cmd.x, z: cmd.z, viewHeight: cmd.viewHeight }));
  bus.register('map.panBy', (cmd) => game.mapPanBy(cmd.dx, cmd.dz));
  bus.register('map.zoomBy', (cmd) =>
    game.mapZoomBy(
      cmd.factor,
      cmd.anchorX !== undefined && cmd.anchorZ !== undefined ? { x: cmd.anchorX, z: cmd.anchorZ } : undefined,
      cmd.screenX !== undefined && cmd.screenY !== undefined ? { x: cmd.screenX, y: cmd.screenY } : undefined
    )
  );
  bus.register('map.focusCountry', (cmd) => game.mapFocusCountry(cmd.countryId));
  bus.register('map.setViewport', (cmd) => game.mapSetViewport(cmd.width, cmd.height));
  bus.register('government.setTaxRate', (cmd) => game.governmentSetTaxRate(cmd.countryId, cmd.category, cmd.value));
  bus.register('government.setSpending', (cmd) => game.governmentSetSpending(cmd.countryId, cmd.category, cmd.value));
  bus.register('government.setMinistryFunding', (cmd) =>
    game.governmentSetMinistryFunding(cmd.countryId, cmd.ministryId, cmd.value)
  );
  bus.register('government.enactDecision', (cmd) => game.governmentEnactDecision(cmd.countryId, cmd.decisionId));
  bus.register('government.resolveEvent', (cmd) =>
    game.governmentResolveEvent(cmd.countryId, cmd.instanceId, cmd.choiceId)
  );
  bus.register('economy.setImportPolicy', (cmd) => game.economySetImportPolicy(cmd.countryId, cmd.resourceId, cmd.active));
  bus.register('economy.setExportPolicy', (cmd) => game.economySetExportPolicy(cmd.countryId, cmd.resourceId, cmd.active));
}
