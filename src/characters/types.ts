/**
 * Character domain model (leaders, commanders, soldiers-as-characters,
 * civilians). Leaf module.
 */

import type { EntityId } from '../core/IdGenerator';

export type CharacterRole = 'leader' | 'commander' | 'soldier' | 'civilian';

export interface CharacterRecord {
  readonly id: EntityId;
  readonly name: string;
  readonly role: CharacterRole;
  readonly countryId: string | null;
  traits: readonly string[];
}

export type CharacterMap = Readonly<Record<EntityId, CharacterRecord>>;

export function charactersByRole(characters: CharacterMap, role: CharacterRole): CharacterRecord[] {
  return Object.values(characters).filter((character) => character.role === role);
}

export function charactersByCountry(characters: CharacterMap, countryId: string): CharacterRecord[] {
  return Object.values(characters).filter((character) => character.countryId === countryId);
}

export function requireCharacter(characters: CharacterMap, id: EntityId): CharacterRecord {
  const character = characters[id];
  if (character === undefined) {
    throw new Error(`Unknown character "${id}"`);
  }
  return character;
}
