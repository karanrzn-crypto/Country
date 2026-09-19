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

/** { low, medium, high } price multipliers — all positive. */

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
    strategicResources: {
      type: 'object',
      allowUnknown: false,
      fields: {
        productionScale: positiveNumber,
        // The market sale-quota rule (sellers' fixed, buyer-independent
        // offers — the sale-quantity directive) + the AI re-request cooldown.
        market: {
          type: 'object',
          allowUnknown: false,
          fields: {
            saleQuotaShare: { type: 'number', min: 0, max: 1 },
            requestCooldownMonths: { type: 'number', min: 0, max: 120, integer: true },
            requestTtlMonths: { type: 'optional', inner: { type: 'number', min: 1, max: 240, integer: true } }
          }
        },
        // Year-over-year demand growth (the demand directive — config):
        // `graceYears` keeps consumption at its BASE for the opening years,
        // then perYear compounds gradually (no sudden jump).
        consumptionGrowth: {
          type: 'object',
          allowUnknown: false,
          fields: {
            graceYears: { type: 'optional', inner: { type: 'number', min: 0, max: 50 } },
            perYear: { type: 'number', min: 0, max: 1 },
            maxFactor: { type: 'number', min: 1, max: 20 }
          }
        },
        // The economic-budget production modifier (50 = neutral, §budget).
        economicBudget: {
          type: 'object',
          allowUnknown: false,
          fields: {
            productionPerPoint: { type: 'number', min: 0, max: 0.05 }
          }
        },
        // The WAREHOUSE (the storage directive §2) — countries may buy more
        // than this month's consumption but never beyond the warehouse.
        storage: {
          type: 'optional',
          inner: {
            type: 'object',
            allowUnknown: false,
            fields: {
              maxMonths: { type: 'number', min: 0, max: 120 },
              floor: { type: 'record', values: { type: 'number', min: 0 } },
              aiFutureMonths: { type: 'number', min: 0, max: 24 },
              aiStockpileChance: { type: 'number', min: 0, max: 1 }
            }
          }
        },
        // The TEMPORARY economic events (the events directive §5): each a
        // production cut on ONE good for a few months, then auto-recovery.
        economicEvents: {
          type: 'optional',
          inner: {
            type: 'object',
            allowUnknown: false,
            fields: {
              checkChance: { type: 'number', min: 0, max: 1 },
              maxConcurrent: { type: 'number', min: 0, max: 5, integer: true },
              events: {
                type: 'array',
                minLength: 1,
                items: {
                  type: 'object',
                  allowUnknown: false,
                  fields: {
                    id: idField,
                    short: nameField,
                    message: { type: 'string' },
                    resource: idField,
                    factor: { type: 'number', min: 0, max: 1 },
                    durationMonths: { type: 'number', min: 1, max: 120, integer: true },
                    weight: { type: 'optional', inner: { type: 'number', min: 0, max: 100 } }
                  }
                }
              }
            }
          }
        },
        specialization: {
          type: 'object',
          allowUnknown: false,
          fields: {
            boostBest: { type: 'number', min: 0, max: 2 },
            boostSecond: { type: 'number', min: 0, max: 2 },
            reduceWeakest: { type: 'number', min: 0, max: 1 },
            // The country's per-good POTENTIAL by specialization rank (§15).
            potentialByRank: {
              type: 'array',
              minLength: 1,
              items: { type: 'number', min: 0, max: 3 }
            }
          }
        },
        economyLevel: {
          type: 'object',
          allowUnknown: false,
          fields: {
            start: { type: 'number', min: 0, max: 100 },
            maxStepPerMonth: { type: 'number', min: 0, max: 50 },
            buildingBonusPerPoint: { type: 'number', min: 0, max: 0.1 },
            targetBase: { type: 'number', min: 0, max: 100 },
            balanceFactor: { type: 'number', min: 0, max: 10 },
            balanceCap: { type: 'number', min: 0, max: 50 },
            shortagePenalty: { type: 'number', min: 0, max: 50 }
          }
        },
        satisfaction: {
          type: 'object',
          allowUnknown: false,
          fields: {
            breakpoints: {
              type: 'array',
              minLength: 1,
              items: {
                type: 'object',
                allowUnknown: false,
                fields: {
                  coverage: { type: 'number', min: 0, max: 1 },
                  penalty: { type: 'number', min: 0, max: 1 }
                }
              }
            },
            maxPenalty: { type: 'number', min: 0, max: 1 },
            stabilityFactor: { type: 'number', min: 0, max: 1 },
            // Duration escalation of the penalty (spec §13).
            durationEscalation: {
              type: 'object',
              allowUnknown: false,
              fields: {
                perMonth: { type: 'number', min: 0, max: 1 },
                maxMultiplier: { type: 'number', min: 1, max: 5 }
              }
            }
          }
        },
        finance: {
          type: 'object',
          allowUnknown: false,
          fields: {
            startingTreasury: { type: 'number', min: 0 },
            populationGrowthPerMonth: { type: 'number', min: 0, max: 0.1 },
            taxIncomePerMillionPerRate: positiveNumber,
            governmentCostPerMillion: { type: 'number', min: 0 },
            armyCostPerThousandSoldiers: { type: 'number', min: 0 },
            infrastructureCostPerArea: { type: 'number', min: 0 }
          }
        },
        buildings: {
          type: 'array',
          minLength: 1,
          items: {
            type: 'object',
            allowUnknown: false,
            fields: {
              id: idField,
              name: nameField,
              // 'military' buildings are infrastructure only — no resource
              // output yet (the military directive); omitted → economic.
              kind: { type: 'optional', inner: { type: 'enum', values: ['economic', 'military'] } },
              resource: { type: 'optional', inner: idField },
              output: { type: 'number', min: 0 },
              cost: { type: 'number', min: 0 },
              // ONE-TIME construction materials (industrial units, §4).
              materials: { type: 'number', min: 0 },
              // Workforce capacity held while building (§4).
              workforce: { type: 'number', min: 0 },
              // Finite extraction reserve (§8); 0 = inexhaustible.
              reserveUnits: { type: 'number', min: 0 },
              buildMonths: { type: 'number', min: 1, max: 60, integer: true }
            }
          }
        },
        construction: {
          type: 'object',
          allowUnknown: false,
          fields: {
            maxProjects: { type: 'number', min: 1, max: 20, integer: true },
            workforceBase: { type: 'number', min: 0 },
            workforcePerMillion: { type: 'number', min: 0 }
          }
        },
        // Per-region quality thresholds → Persian labels (§3).
        cellQuality: {
          type: 'object',
          allowUnknown: false,
          fields: {
            excellent: { type: 'number', min: 0, max: 1 },
            good: { type: 'number', min: 0, max: 1 },
            fair: { type: 'number', min: 0, max: 1 }
          }
        },
        // Diminishing returns per building type (§7).
        diminishingReturns: {
          type: 'object',
          allowUnknown: false,
          fields: {
            step: { type: 'number', min: 0, max: 1 },
            min: { type: 'number', min: 0, max: 1 }
          }
        },
        safetyBuffer: {
          type: 'object',
          allowUnknown: false,
          fields: {
            foodMonths: { type: 'number', min: 0, max: 24 },
            reserveMonths: { type: 'number', min: 0, max: 24 }
          }
        },
        displayStatus: {
          type: 'object',
          allowUnknown: false,
          fields: {
            surplusBufferMonths: { type: 'number', min: 0, max: 24 },
            minSurplusShare: { type: 'number', min: 0, max: 1 }
          }
        },
        startingStock: {
          type: 'object',
          allowUnknown: false,
          fields: {
            // Months of the country's own consumption per good (§10).
            months: { type: 'record', values: { type: 'number', min: 0, max: 24 } },
            // Absolute floor per good for tiny countries (§10).
            floor: { type: 'record', values: { type: 'number', min: 0 } },
            // Profile multipliers by specialization rank (§1).
            flavorByRank: {
              type: 'array',
              minLength: 1,
              items: { type: 'number', min: 0, max: 3 }
            }
          }
        },
        militaryMaterials: { type: 'record', values: { type: 'number', min: 0 } },
        domesticBaseline: {
          type: 'object',
          allowUnknown: false,
          fields: {
            cityTermScale: { type: 'number', min: 0, max: 10 },
            cityTermMaxCities: { type: 'number', min: 0, max: 1000, integer: true },
            biomeWeight: { type: 'number', min: 0, max: 1 },
            terrainWeight: { type: 'number', min: 0, max: 1 },
            resources: {
              type: 'record',
              values: {
                type: 'object',
                allowUnknown: false,
                fields: {
                  base: positiveNumber,
                  biomes: { type: 'optional', inner: { type: 'record', values: { type: 'number', min: 0, max: 1 } } },
                  biomeNeutral: { type: 'optional', inner: { type: 'number', min: 0, max: 1 } },
                  terrain: { type: 'optional', inner: { type: 'record', values: { type: 'number', min: 0, max: 1 } } },
                  terrainNeutral: { type: 'optional', inner: { type: 'number', min: 0, max: 1 } },
                  cityFactor: { type: 'optional', inner: { type: 'number', min: 0, max: 10 } }
                }
              }
            }
          }
        },
        resources: {
          type: 'array',
          minLength: 1,
          items: {
            type: 'object',
            fields: { id: idField, name: nameField, price: { type: 'number', min: 0 } }
          }
        },
        consumption: {
          type: 'record',
          values: {
            type: 'object',
            allowUnknown: false,
            fields: {
              perMillionPopulation: { type: 'optional', inner: { type: 'number', min: 0 } },
              perMilitaryUnit: { type: 'optional', inner: { type: 'number', min: 0 } }
            }
          }
        }
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
    provinceSelectColor: colorField,
    provinceSelectOpacity: { type: 'number', min: 0, max: 1 },
    coastStroke: colorField,
    countryBorderStroke: colorField,
    provinceBorderStroke: colorField,
    provinceBorderOpacity: { type: 'number', min: 0, max: 1 },
    cityAreaStroke: colorField,
    cityAreaOpacity: { type: 'number', min: 0, max: 1 },
    cityLinkRoad: colorField,
    cityLinkCrossProvince: colorField,
    cityLinkRailway: colorField,
    cityLinkOpacity: { type: 'number', min: 0, max: 1 },
    cityLinkRoadWidth: { type: 'number', min: 0.05, max: 5 },
    cityLinkCrossProvinceWidth: { type: 'number', min: 0.05, max: 5 },
    cityLinkRailwayWidth: { type: 'number', min: 0.05, max: 5 },
    cityHighlightColor: colorField,
    cityHighlightOpacity: { type: 'number', min: 0, max: 1 },
    capitalHighlightColor: colorField,
    capitalHighlightOpacity: { type: 'number', min: 0, max: 1 },
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
        minReadablePx: { type: 'number', min: 5, max: 40 },
        tiers: {
          type: 'object',
          allowUnknown: false,
          fields: {
            country: LABEL_TIER_SCHEMA,
            province: LABEL_TIER_SCHEMA,
            capital: LABEL_TIER_SCHEMA,
            majorCity: LABEL_TIER_SCHEMA,
            city: LABEL_TIER_SCHEMA,
            settlement: LABEL_TIER_SCHEMA,
            grid: LABEL_TIER_SCHEMA
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
        terrainRamp: {
          type: 'array',
          minLength: 2,
          items: {
            type: 'object',
            allowUnknown: false,
            fields: {
              at: { type: 'number', min: 0, max: 1 },
              color: colorField
            }
          }
        },
        elevationLegend: {
          type: 'object',
          allowUnknown: false,
          fields: {
            lowLabel: { type: 'string', minLength: 1 },
            highLabel: { type: 'string', minLength: 1 },
            samples: { type: 'number', min: 2, max: 256 }
          }
        },
        tintFillOpacity: { type: 'number', min: 0, max: 1 },
        economyFillOpacity: { type: 'number', min: 0, max: 1 },
        populationLow: colorField,
        populationHigh: colorField,
        economyBuildingColors: { type: 'record', values: colorField },
        strategicLow: colorField,
        strategicHigh: colorField,
        riverStroke: colorField,
        riverOpacity: { type: 'number', min: 0, max: 1 },
        lakeFill: colorField,
        lakeOpacity: { type: 'number', min: 0, max: 1 },
        riverWidth: {
          type: 'object',
          allowUnknown: false,
          fields: {
            source: { type: 'number', min: 0.05, max: 10 },
            perCell: { type: 'number', min: 0, max: 5 },
            max: { type: 'number', min: 0.1, max: 20 }
          }
        },
        roadColors: {
          type: 'object',
          allowUnknown: false,
          fields: {
            highway: colorField,
            secondary: colorField,
            dirt: colorField
          }
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
            lumber: colorField,
            airbase: colorField,
            base: colorField
          }
        },
        siteOpacity: { type: 'number', min: 0, max: 1 },
        gridColor: colorField,
        gridOpacity: { type: 'number', min: 0, max: 1 },
        gridSelectColor: colorField,
        gridSelectOpacity: { type: 'number', min: 0, max: 1 },
        gridSelectOutlineColor: colorField,
        gridHoverColor: colorField,
        gridHoverOpacity: { type: 'number', min: 0, max: 1 },
        buildingColors: {
          type: 'object',
          allowUnknown: false,
          fields: {
            residential: colorField,
            industrial: colorField,
            commercial: colorField,
            government: colorField,
            hospital: colorField,
            militaryBase: colorField,
            airport: colorField,
            port: colorField,
            railwayStation: colorField,
            power: colorField
          }
        },
        buildingOpacity: { type: 'number', min: 0, max: 1 }
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

// ———————————————————————————————————————————— Phase 2 — government content ——

const EFFECT_CONDITION_SCHEMA: FieldSchema = {
  type: 'object',
  allowUnknown: false,
  fields: {
    metric: { type: 'string', minLength: 1 },
    op: { type: 'enum', values: ['gte', 'lte', 'gt', 'lt'] },
    value: { type: 'number' }
  }
};

const EFFECT_SCHEMA: FieldSchema = {
  type: 'object',
  allowUnknown: false,
  fields: {
    target: { type: 'string', minLength: 1 },
    mode: { type: 'enum', values: ['add', 'mul'] },
    value: { type: 'number' },
    durationMonths: { type: 'optional', inner: { type: 'number', min: 1, max: 600, integer: true } }
  }
};

export const PARTY_TEMPLATE_SCHEMA: FieldSchema = {
  type: 'object',
  allowUnknown: false,
  fields: {
    id: idField,
    name: nameField,
    ideology: { type: 'enum', values: ['centrist', 'progressive', 'conservative', 'socialist', 'liberal'] },
    baseSupport: { type: 'number', min: 0.01, max: 10 }
  }
};

export const MINISTRY_TEMPLATE_SCHEMA: FieldSchema = {
  type: 'object',
  allowUnknown: false,
  fields: {
    id: idField,
    name: nameField,
    portfolio: {
      type: 'enum',
      values: ['military', 'healthcare', 'education', 'infrastructure', 'welfare', 'government', 'other']
    },
    focus: { type: 'string', minLength: 1 }
  }
};

export const DECISION_DEF_SCHEMA: FieldSchema = {
  type: 'object',
  allowUnknown: false,
  fields: {
    id: idField,
    name: nameField,
    description: nameField,
    category: { type: 'enum', values: ['economic', 'political', 'social', 'military'] },
    cost: {
      type: 'object',
      allowUnknown: false,
      fields: { treasury: { type: 'optional', inner: { type: 'number', min: 0 } } }
    },
    preconditions: { type: 'array', items: EFFECT_CONDITION_SCHEMA },
    effects: { type: 'array', minLength: 1, items: EFFECT_SCHEMA },
    durationMonths: { type: 'number', min: 0, max: 120, integer: true },
    cooldownMonths: { type: 'number', min: 0, max: 600, integer: true }
  }
};

export const EVENT_DEF_SCHEMA: FieldSchema = {
  type: 'object',
  allowUnknown: false,
  fields: {
    id: idField,
    title: nameField,
    description: nameField,
    category: { type: 'enum', values: ['economic', 'political', 'social'] },
    weight: { type: 'number', min: 0, max: 1000 },
    conditions: { type: 'array', items: EFFECT_CONDITION_SCHEMA },
    cooldownMonths: { type: 'number', min: 0, max: 600, integer: true },
    once: { type: 'boolean' },
    expireMonths: { type: 'number', min: 1, max: 24, integer: true },
    choices: {
      type: 'array',
      minLength: 1,
      items: {
        type: 'object',
        allowUnknown: false,
        fields: {
          id: idField,
          text: nameField,
          effects: { type: 'array', minLength: 1, items: EFFECT_SCHEMA }
        }
      }
    }
  }
};
