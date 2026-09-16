/**
 * Player domain types: selectable player modes (President / Commander /
 * Soldier / Aircraft) and the player state slice shape. Leaf module.
 */

import type { EntityId } from '../core/IdGenerator';

export type PlayerModeId = 'president' | 'commander' | 'soldier' | 'aircraft';

export type CameraProfile = 'strategic' | 'tactical' | 'ground' | 'aircraft';

/** Data-driven player mode definition (src/data/playerModes.json). */
export interface PlayerModeDef {
  readonly id: PlayerModeId;
  readonly name: string;
  readonly camera: CameraProfile;
  readonly transitions: readonly PlayerModeId[];
}

/** Runtime player state — persisted in the player state slice. */
export interface PlayerSlice {
  /** Country the player currently controls. */
  countryId: string;
  /**
   * Country-selection flow (Part 3): false until the player confirms their
   * country on the strategic map (countrySelect screen). Fresh campaigns
   * start pending; confirming registers the country in THIS slice so every
   * future system reads the same source of truth.
   */
  countryConfirmed: boolean;
  mode: PlayerModeId | null;
  focusChunkId: string | null;
  selection: EntityId[];
}
