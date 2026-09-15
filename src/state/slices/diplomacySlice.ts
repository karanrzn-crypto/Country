/**
 * Diplomacy state slice — pairwise country relations (-100 hostile .. +100 allied).
 */

export interface DiplomacySlice {
  /** country id → country id → relation value. Symmetric on write. */
  relations: Record<string, Record<string, number>>;
}

export const RELATION_HOSTILE_THRESHOLD = -20;

export function getRelation(slice: DiplomacySlice, a: string, b: string): number {
  return slice.relations[a]?.[b] ?? 0;
}

export function setRelation(slice: DiplomacySlice, a: string, b: string, value: number): void {
  const clamped = Math.max(-100, Math.min(100, value));
  (slice.relations[a] ??= {})[b] = clamped;
  (slice.relations[b] ??= {})[a] = clamped;
}

export function areHostile(slice: DiplomacySlice, a: string, b: string): boolean {
  if (a === b) return false;
  return getRelation(slice, a, b) <= RELATION_HOSTILE_THRESHOLD;
}
