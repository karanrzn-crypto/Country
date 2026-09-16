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

const LABEL_TIER_SCHEMA: FieldSchema = {
  type: 'object',
  allowUnknown: false,
  fields: {
    maxViewHeight: { type: 'union', options: [{ type: 'number', min: 1 }, { type: 'null' }] },
    minPopulation: { type: 'number', min: 0 },
    priority: { type: 'number', min: 0, max: 1000 },
    screenPx: { type: 'number', min: 5, max: 80 }
  }
};

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
    cityAreaStroke: colorField,
    cityAreaOpacity: { type: 'number', min: 0, max: 1 },
    cityFill: colorField,
    cityStroke: colorField,
    capitalFill: colorField,
    capitalStroke: colorField,
    cityRadius: { type: 'number', min: 0.1, max: 20 },
    capitalRadius: { type: 'number', min: 0.1, max: 40 },
    cityHitRadius: { type: 'number', min: 0.1, max: 40 },
    labelColor: colorField,
    labelHaloColor: colorField,
    labels: {
      type: 'object',
      allowUnknown: false,
      fields: {
        fadeSpanViewHeight: { type: 'number', min: 1, max: 200 },
        fadeRatePerSecond: { type: 'number', min: 0.5, max: 60 },
        maxVisible: { type: 'number', min: 1, max: 2000, integer: true },
        collisionPaddingPx: { type: 'number', min: 0, max: 40 },
        labelOffsetPx: { type: 'number', min: 0, max: 80 },
        tiers: {
          type: 'object',
          allowUnknown: false,
          fields: {
            country: LABEL_TIER_SCHEMA,
            province: LABEL_TIER_SCHEMA,
            capital: LABEL_TIER_SCHEMA,
            majorCity: LABEL_TIER_SCHEMA,
            city: LABEL_TIER_SCHEMA
          }
        }
      }
    },
    selectionRingColor: colorField,
    selectionRingColorAlt: colorField,
    playerOutlineColor: colorField,
    layerColors: {
      type: 'object',
      allowUnknown: false,
      fields: {
        biomeFillOpacity: { type: 'number', min: 0, max: 1 },
        biomeVariation: {
          type: 'object',
          allowUnknown: false,
          fields: {
            patchStrength: { type: 'number', min: 0, max: 0.3 },
            cellJitter: { type: 'number', min: 0, max: 0.2 },
            elevationLightness: { type: 'number', min: 0, max: 0.5 }
          }
        },
        biomeLabels: {
          type: 'object',
          allowUnknown: false,
          fields: {
            forest: { type: 'string', minLength: 1 },
            grassland: { type: 'string', minLength: 1 },
            desert: { type: 'string', minLength: 1 },
            tundra: { type: 'string', minLength: 1 },
            drylands: { type: 'string', minLength: 1 },
            jungle: { type: 'string', minLength: 1 }
          }
        },
        biomeLegendOrder: {
          type: 'array',
          minLength: 1,
          items: { type: 'string', minLength: 1 }
        },
        biomes: {
          type: 'object',
          allowUnknown: false,
          fields: {
            forest: colorField,
            grassland: colorField,
            desert: colorField,
            tundra: colorField,
            drylands: colorField,
            jungle: colorField
          }
        },
        terrainFillOpacity: { type: 'number', min: 0, max: 1 },
        terrain: {
          type: 'object',
          allowUnknown: false,
          fields: {
            mountain: colorField,
            hills: colorField,
            plains: colorField,
            valley: colorField
          }
        },
        tintFillOpacity: { type: 'number', min: 0, max: 1 },
        populationLow: colorField,
        populationHigh: colorField,
        economyLow: colorField,
        economyHigh: colorField,
        riverStroke: colorField,
        riverOpacity: { type: 'number', min: 0, max: 1 },
        lakeFill: colorField,
        lakeOpacity: { type: 'number', min: 0, max: 1 },
        roadColors: {
          type: 'object',
          allowUnknown: false,
          fields: { highway: colorField, secondary: colorField, dirt: colorField }
        },
        roadOpacity: { type: 'number', min: 0, max: 1 },
        railwayStroke: colorField,
        railwayOpacity: { type: 'number', min: 0, max: 1 },
        seaRouteStroke: colorField,
        seaRouteOpacity: { type: 'number', min: 0, max: 1 },
        siteColors: {
          type: 'object',
          allowUnknown: false,
          fields: {
            port: colorField,
            farm: colorField,
            factory: colorField,
            mine: colorField,
            oil: colorField,
            airbase: colorField,
            base: colorField
          }
        },
        siteOpacity: { type: 'number', min: 0, max: 1 }
      }
    }
  }
};

export const FLAG_SCHEMA: FieldSchema = {
  type: 'object',
  allowUnknown: false,
  fields: {
    layout: { type: 'enum', values: ['solid', 'horizontal-stripes', 'vertical-stripes', 'canton'] },
    colors: { type: 'array', minLength: 1, items: colorField },
    emblem: { type: 'enum', values: ['none', 'star', 'circle', 'crescent', 'sun', 'cross'] },
    emblemColor: colorField
  }
};

const relationValue: FieldSchema = { type: 'number', min: -100, max: 100 };

/** Static country profiles (Part 2) — shape validation; cross-refs checked in the registry. */
export const COUNTRY_PROFILE_SCHEMA: FieldSchema = {
  type: 'object',
  allowUnknown: false,
  fields: {
    id: idField,
    name: nameField,
    flag: FLAG_SCHEMA,
    population: { type: 'number', min: 0, max: 2_000_000_000 },
    economy: {
      type: 'object',
      allowUnknown: false,
      fields: {
        gdp: positiveNumber,
        treasury: positiveNumber,
        income: positiveNumber,
        expenses: positiveNumber
      }
    },
    resources: { type: 'record', values: positiveNumber },
    military: {
      type: 'object',
      allowUnknown: false,
      fields: {
        manpower: positiveNumber,
        armySize: positiveNumber,
        equipment: positiveNumber,
        aircraft: positiveNumber,
        navy: positiveNumber
      }
    },
    foreignRelations: { type: 'record', values: relationValue }
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
