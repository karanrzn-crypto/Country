import type { GameState } from '../state/GameState';
import { unitsOfCountry } from '../state/slices/militarySlice';
import { regionsOfCountry } from '../state/slices/worldSlice';
import { areHostile } from '../state/slices/diplomacySlice';

/**
 * Computes the AI decision metrics for one faction from the current state.
 *
 * Phase 0 formulas are deliberately simple and documented; they form the
 * contract between the simulation and data-driven strategies. Later phases
 * refine the formulas without changing the metric vocabulary.
 */
export function computeFactionMetrics(state: GameState, factionId: string): Record<string, number> {
  const countryIds = Object.keys(state.world.countries);
  const ownStrength = state.military.strengthCache[factionId] ?? 0;
  const otherStrengths = countryIds
    .filter((id) => id !== factionId)
    .map((id) => state.military.strengthCache[id] ?? 0);
  const strongestOther = otherStrengths.length > 0 ? Math.max(...otherStrengths) : 0;

  const ownRegions = regionsOfCountry(state.world, factionId).map((region) => region.id);
  const ownSupply =
    ownRegions.length > 0
      ? ownRegions.reduce((sum, regionId) => sum + (state.economy.supply[regionId] ?? 0), 0) /
        ownRegions.length
      : 0;

  const ownUnits = unitsOfCountry(state.military, factionId);
  const liveOwn = ownUnits.filter((unit) => unit.operationalState !== 'destroyed');

  // Threat: hostile units standing inside our regions.
  const underThreat = ownRegions.some((regionId) =>
    Object.values(state.military.units).some(
      (unit) =>
        unit.regionId === regionId &&
        unit.countryId !== factionId &&
        unit.operationalState !== 'destroyed' &&
        areHostile(state.diplomacy, factionId, unit.countryId)
    )
  )
    ? 1
    : 0;

  const ownFactories = Object.values(state.economy.factories).filter(
    (factory) => state.world.countryOfRegion[factory.regionId] === factionId
  );
  const ownIndustrial = ownFactories.reduce(
    (sum, factory) => sum + (factory.active ? factory.lastOutputAmount : 0),
    0
  );
  const otherIndustrial = Math.max(
    1,
    ...countryIds
      .filter((id) => id !== factionId)
      .map((id) =>
        Object.values(state.economy.factories)
          .filter((factory) => state.world.countryOfRegion[factory.regionId] === id)
          .reduce((sum, factory) => sum + (factory.active ? factory.lastOutputAmount : 0), 0)
      )
  );

  return {
    // Relative military power vs the strongest rival.
    strength_ratio: strongestOther > 0 ? ownStrength / strongestOther : ownStrength > 0 ? 2 : 1,
    // Average supply satisfaction across own regions.
    supply_ratio: ownSupply,
    // 1 when hostile forces stand on own soil.
    under_threat: underThreat,
    // Industrial output vs best rival.
    industrial_ratio: ownIndustrial / otherIndustrial,
    // Placeholder until air combat exists in the detailed sim (Phase 2+).
    air_superiority: 1,
    // Share of own units that are idle (potential reserve).
    reserve_ratio:
      liveOwn.length > 0
        ? liveOwn.filter((unit) => unit.operationalState === 'idle').length / liveOwn.length
        : 0,
    // Placeholder until unit speed metrics exist (Phase 2+).
    mobility_ratio: 1
  };
}
