import { describe, it, expect } from 'vitest';
import { DataRegistry, KNOWN_METRICS } from '../../../data/DataRegistry';
import { DataValidationError } from '../../../utils/errors';

describe('DataRegistry (static game data validation)', () => {
  const data = new DataRegistry();

  it('loads unit types with valid equipment references', () => {
    const unitTypes = data.unitTypeList;
    expect(unitTypes.length).toBeGreaterThanOrEqual(4);
    for (const unit of unitTypes) {
      for (const equipmentId of Object.keys(unit.equipment)) {
        expect(() => data.equipment(equipmentId)).not.toThrow();
      }
    }
  });

  it('loads equipment across all categories (weapon/vehicle/aircraft/support)', () => {
    const categories = new Set(data.equipmentList.map((def) => def.category));
    expect(categories.has('weapon')).toBe(true);
    expect(categories.has('vehicle')).toBe(true);
    expect(categories.has('aircraft')).toBe(true);
    expect(categories.has('support')).toBe(true);
  });

  it('loads economy with balanced factory inputs/outputs', () => {
    const { resources, factoryTypes } = data.economyData;
    const resourceIds = new Set(resources.map((resource) => resource.id));
    expect(resourceIds.has('food')).toBe(true);
    for (const factoryType of factoryTypes) {
      for (const inputId of Object.keys(factoryType.inputs)) {
        expect(resourceIds.has(inputId)).toBe(true);
      }
      for (const outputId of Object.keys(factoryType.outputs)) {
        expect(resourceIds.has(outputId)).toBe(true);
      }
    }
  });

  it('loads at least 8 data-driven AI strategies', () => {
    expect(data.strategyList.length).toBeGreaterThanOrEqual(8);
    const ids = data.strategyList.map((strategy) => strategy.id);
    expect(ids).toContain('offensive');
    expect(ids).toContain('defensive');
    expect(ids).toContain('encirclement');
    expect(ids).toContain('attrition');
    expect(ids).toContain('air_assault');
    expect(ids).toContain('defensive_withdrawal');
    expect(ids).toContain('counterattack');
  });

  it('loads 4 player modes with valid camera profiles', () => {
    expect(data.playerModeList).toHaveLength(4);
    for (const mode of data.playerModeList) {
      expect(['strategic', 'tactical', 'ground', 'aircraft']).toContain(mode.camera);
    }
  });

  it('loads input bindings including pause/debug/map', () => {
    const bindings = data.inputBindings;
    expect(Object.values(bindings.keyboard)).toContain('togglePause');
    expect(Object.values(bindings.keyboard)).toContain('toggleDebug');
    expect(Object.values(bindings.keyboard)).toContain('toggleMap');
  });

  it('loads the demo world', () => {
    const world = data.world('demo-country');
    expect(world.regions.length).toBeGreaterThanOrEqual(4);
    expect(data.worldIds).toContain('demo-country');
  });

  it('fails loudly on unknown ids', () => {
    expect(() => data.unitType('ghost_unit')).toThrowError(DataValidationError);
    expect(() => data.equipment('ghost_gun')).toThrowError(DataValidationError);
    expect(() => data.world('ghost-world')).toThrowError(DataValidationError);
  });

  it('exposes the AI metric vocabulary', () => {
    expect(KNOWN_METRICS.has('strength_ratio')).toBe(true);
    expect(KNOWN_METRICS.has('under_threat')).toBe(true);
  });
});
