/**
 * Character state slice — leaders, commanders and notable persons.
 */

import type { CharacterRecord } from '../../characters/types';

export interface CharacterSlice {
  characters: Record<string, CharacterRecord>;
}
