import { clamp } from '../utils/math';

/**
 * Pure damage math. Kept free of any entity-registry dependency so it can be
 * unit-tested exhaustively and reused for soldiers, vehicles, aircraft and
 * characters in later phases.
 */

/** Armor softening constant: higher armor → diminishing returns. */
export const ARMOR_SOFTENING_K = 50;

/**
 * Fraction of incoming damage absorbed by armor, reduced by penetration.
 * armor=0 → 0; armor→∞ → 1 − armorPen.
 */
export function armorReduction(armor: number, armorPen: number): number {
  if (armor <= 0) return 0;
  const raw = armor / (armor + ARMOR_SOFTENING_K);
  return raw * (1 - clamp(armorPen, 0, 1));
}

/** Final damage after armor interaction. Always ≥ 0. */
export function computeDamage(baseDamage: number, armorPen: number, targetArmor: number): number {
  if (baseDamage <= 0) return 0;
  return Math.max(0, baseDamage * (1 - armorReduction(targetArmor, armorPen)));
}

/** Total armor of an equipment loadout (data-driven). */
export function totalArmorOf(equipment: Readonly<Record<string, number>>, lookup: (id: string) => { armor: number }): number {
  let total = 0;
  for (const [equipmentId, count] of Object.entries(equipment)) {
    total += lookup(equipmentId).armor * count;
  }
  return total;
}
