/**
 * Validation schemas for every data-driven JSON file.
 * Shape correctness is enforced here; referential integrity (IDs pointing to
 * existing records) is enforced when the initial state is built.
 */

import type { FieldSchema } from '../utils/validation';

const idField: FieldSchema = { type: 'string', minLength: 2, pattern: '^[a-z0-9_-]+$' };
const nameField: FieldSchema = { type: 'string', minLength: 1 };
const positiveNumber: FieldSchema = { type: 'number', min: 0 };

export const UNIT_TYPE_SCHEMA: FieldSchema = {
  type: 'object',
  allowUnknown: false,
  fields: {
    id: idField,
    name: nameField,
    category: { type: 'enum', values: ['infantry', 'vehicle', 'aircraft', 'ship'] },
    soldiers: { type: 'number', min: 0, max: 100_000, integer: true },
    organizationMax: { type: 'number', min: 1, max: 100 },
    supplyUsePerDay: positiveNumber,
    speedKmh: { type: 'number', min: 0, max: 2000 },
    equipment: { type: 'record', values: { type: 'number', min: 0, max: 10_000 } }
  }
};

export const EQUIPMENT_SCHEMA: FieldSchema = {
  type: 'object',
  allowUnknown: false,
  fields: {
    id: idField,
    name: nameField,
    category: { type: 'enum', values: ['weapon', 'vehicle', 'aircraft', 'ship', 'support'] },
    domain: { type: 'enum', values: ['ground', 'air', 'sea'] },
    cost: positiveNumber,
    upkeepPerDay: positiveNumber,
    damage: { type: 'number', min: 0, max: 10_000 },
    armorPen: { type: 'number', min: 0, max: 1 },
    range: positiveNumber,
    accuracy: { type: 'number', min: 0, max: 1 },
    cooldownTicks: { type: 'number', min: 0, max: 1000 },
    armor: { type: 'number', min: 0, max: 10_000 },
    speedKmh: positiveNumber
  }
};

export const ECONOMY_SCHEMA: FieldSchema = {
  type: 'object',
  allowUnknown: false,
  fields: {
    resources: {
      type: 'array',
      minLength: 1,
      items: {
        type: 'object',
        fields: { id: idField, name: nameField, weight: positiveNumber }
      }
    },
    factoryTypes: {
      type: 'array',
      minLength: 1,
      items: {
        type: 'object',
        fields: {
          id: idField,
          name: nameField,
          inputs: { type: 'record', values: positiveNumber },
          outputs: { type: 'record', values: positiveNumber },
          cyclesPerDay: positiveNumber,
          workforce: positiveNumber
        }
      }
    },
    startingStockpiles: {
      type: 'object',
      fields: {
        resources: { type: 'record', values: positiveNumber },
        equipment: { type: 'record', values: positiveNumber }
      }
    }
  }
};

export const AI_STRATEGY_SCHEMA: FieldSchema = {
  type: 'object',
  allowUnknown: false,
  fields: {
    id: idField,
    name: nameField,
    kind: { type: 'enum', values: ['strategic', 'tactical'] },
    priority: { type: 'number', min: 0, max: 100 },
    conditions: {
      type: 'array',
      items: {
        type: 'object',
        fields: {
          metric: idField,
          op: { type: 'enum', values: ['>', '>=', '<', '<=', '==', '!='] },
          value: { type: 'number' }
        }
      }
    },
    tags: { type: 'array', items: idField }
  }
};

export const PLAYER_MODE_SCHEMA: FieldSchema = {
  type: 'object',
  allowUnknown: false,
  fields: {
    id: idField,
    name: nameField,
    camera: { type: 'enum', values: ['strategic', 'tactical', 'ground', 'aircraft'] },
    transitions: { type: 'array', items: idField }
  }
};

export const INPUT_BINDINGS_SCHEMA: FieldSchema = {
  type: 'object',
  allowUnknown: false,
  fields: {
    // Keys are device codes (KeyW, Digit1, "8"...) — values are action ids.
    keyboard: { type: 'record', values: { type: 'string', minLength: 1 } },
    gamepad: { type: 'record', values: { type: 'string', minLength: 1 } }
  }
};

const colorField: FieldSchema = { type: 'string', minLength: 4, pattern: '^#[0-9a-fA-F]{6}$' };

export const MAP_THEME_SCHEMA: FieldSchema = {
  type: 'object',
  allowUnknown: false,
  fields: {
    oceanColor: colorField,
    oceanTone: colorField,
    landColor: colorField,
    countryPalette: { type: 'array', minLength: 8, items: colorField },
    selectedTint: colorField,
    selectedOpacity: { type: 'number', min: 0, max: 1 },
    provinceFill: colorField,
    provinceFillOpacity: { type: 'number', min: 0, max: 1 },
    coastStroke: colorField,
    countryBorderStroke: colorField,
    provinceBorderStroke: colorField,
    provinceBorderOpacity: { type: 'number', min: 0, max: 1 },
    cityFill: colorField,
    cityStroke: colorField,
    capitalFill: colorField,
    capitalStroke: colorField,
    cityRadius: { type: 'number', min: 0.1, max: 20 },
    capitalRadius: { type: 'number', min: 0.1, max: 40 },
    cityHitRadius: { type: 'number', min: 0.1, max: 40 },
    labelColor: colorField,
    labelHaloColor: colorField,
    countryLabelSize: { type: 'number', min: 1, max: 100 },
    cityLabelSize: { type: 'number', min: 1, max: 100 },
    selectionRingColor: colorField,
    selectionRingColorAlt: colorField
  }
};

export const WORLD_SCHEMA: FieldSchema = {
  type: 'object',
  allowUnknown: false,
  fields: {
    id: idField,
    name: nameField,
    countries: {
      type: 'array',
      minLength: 1,
      items: { type: 'object', fields: { id: idField, name: nameField } }
    },
    provinces: {
      type: 'array',
      minLength: 1,
      items: { type: 'object', fields: { id: idField, name: nameField, countryId: idField } }
    },
    cities: {
      type: 'array',
      items: {
        type: 'object',
        fields: { id: idField, name: nameField, provinceId: idField, population: positiveNumber }
      }
    },
    regions: {
      type: 'array',
      minLength: 1,
      items: {
        type: 'object',
        fields: {
          id: idField,
          name: nameField,
          provinceId: idField,
          capitalCityId: { type: 'optional', inner: idField },
          gridX: { type: 'number', min: 0, max: 64, integer: true },
          gridZ: { type: 'number', min: 0, max: 64, integer: true },
          chunkCountX: { type: 'number', min: 1, max: 8, integer: true },
          chunkCountZ: { type: 'number', min: 1, max: 8, integer: true },
          infrastructure: { type: 'number', min: 0, max: 5 },
          population: positiveNumber,
          neighbors: { type: 'array', items: idField }
        }
      }
    },
    factories: {
      type: 'array',
      items: { type: 'object', fields: { id: idField, typeId: idField, regionId: idField } }
    },
    startingUnits: {
      type: 'array',
      items: { type: 'object', fields: { typeId: idField, countryId: idField, regionId: idField } }
    },
    startingCharacters: {
      type: 'array',
      items: {
        type: 'object',
        fields: { id: idField, name: nameField, role: { type: 'enum', values: ['leader', 'commander', 'soldier', 'civilian'] }, countryId: idField }
      }
    },
    relations: {
      type: 'array',
      items: { type: 'object', fields: { a: idField, b: idField, value: { type: 'number', min: -100, max: 100 } } }
    },
    startingStockpiles: {
      type: 'object',
      fields: {
        resources: { type: 'record', values: positiveNumber },
        equipment: { type: 'record', values: positiveNumber }
      }
    }
  }
};
