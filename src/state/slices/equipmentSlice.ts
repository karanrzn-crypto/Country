/**
 * Equipment state slice — per-country equipment stockpiles.
 * Definitions themselves live in the DataRegistry (data-driven).
 */

export interface EquipmentSlice {
  /** country id → equipment id → count. */
  stockpiles: Record<string, Record<string, number>>;
}

export function addEquipment(
  slice: EquipmentSlice,
  countryId: string,
  equipmentId: string,
  amount: number
): void {
  const stock = (slice.stockpiles[countryId] ??= {});
  stock[equipmentId] = (stock[equipmentId] ?? 0) + amount;
}

export function equipmentCount(
  slice: EquipmentSlice,
  countryId: string,
  equipmentId: string
): number {
  return slice.stockpiles[countryId]?.[equipmentId] ?? 0;
}
