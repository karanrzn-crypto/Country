/**
 * Military hierarchy utilities: parent/child traversal over formation records
 * and strength roll-ups. Pure functions — no state ownership.
 */

import type { EntityId } from '../core/IdGenerator';
import type { FormationRecord, UnitRecord } from './types';

export type FormationMap = Readonly<Record<EntityId, FormationRecord>>;
export type UnitMap = Readonly<Record<EntityId, UnitRecord>>;

export function childrenOf(formations: FormationMap, parentId: EntityId): FormationRecord[] {
  return Object.values(formations).filter((formation) => formation.parentId === parentId);
}

export function ancestorsOf(formations: FormationMap, id: EntityId): FormationRecord[] {
  const chain: FormationRecord[] = [];
  let current = formations[id];
  const visited = new Set<EntityId>();
  while (current !== undefined && current.parentId !== null && !visited.has(current.parentId)) {
    visited.add(current.parentId);
    const parent = formations[current.parentId];
    if (parent === undefined) break;
    chain.push(parent);
    current = parent;
  }
  return chain;
}

/** Aggregated soldier count of every unit attached to the formation subtree. */
export function subtreeSoldiers(formations: FormationMap, units: UnitMap, formationId: EntityId): number {
  let total = 0;
  for (const unit of Object.values(units)) {
    if (unit.formationId === null) continue;
    const chain = [unit.formationId, ...ancestorsOf(formations, unit.formationId).map((f) => f.id)];
    if (chain.includes(formationId)) total += unit.soldiersCurrent;
  }
  return total;
}

/** Assigns a commander to a formation (foundation for command traits later). */
export function assignCommander(formations: FormationMap, formationId: EntityId, characterId: EntityId): FormationRecord {
  const formation = formations[formationId];
  if (formation === undefined) {
    throw new Error(`assignCommander: unknown formation "${formationId}"`);
  }
  return { ...formation, commanderId: characterId };
}
