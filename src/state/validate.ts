/**
 * Schema validation for the complete GameState. Used at state creation and
 * before/after every save-load roundtrip so corrupted or incompatible state
 * is rejected immediately (save robustness requirement).
 */

import type { FieldSchema } from '../utils/validation';
import { validate } from '../utils/validation';
import type { GameState } from './GameState';

const positiveNumber: FieldSchema = { type: 'number', min: 0 };
const stringRecord: FieldSchema = { type: 'record', values: { type: 'string' } };

const unitSchema: FieldSchema = {
  type: 'object',
  fields: {
    id: { type: 'string' },
    typeId: { type: 'string' },
    countryId: { type: 'string' },
    regionId: { type: 'union', options: [{ type: 'string' }, { type: 'null' }] },
    formationId: { type: 'union', options: [{ type: 'string' }, { type: 'null' }] },
    operationalState: { type: 'enum', values: ['idle', 'moving', 'inCombat', 'retreating', 'destroyed'] },
    soldiersCurrent: { type: 'number', min: 0 },
    soldiersMax: { type: 'number', min: 0 },
    organization: { type: 'number', min: 0 },
    equipment: { type: 'record', values: { type: 'number', min: 0 } }
  }
};

// ——————————————————————————— Phase 2 state schemas ——————————————————————

const pointSchema: FieldSchema = {
  type: 'object',
  fields: { x: { type: 'number' }, z: { type: 'number' } }
};

const sectorSchema: FieldSchema = {
  type: 'object',
  fields: {
    jobs: { type: 'number', min: 0 },
    capacityJobs: { type: 'number', min: 0 },
    productivity: positiveNumber,
    output: { type: 'number', min: 0 }
  }
};

export const MACRO_ECONOMY_SCHEMA: FieldSchema = {
  type: 'object',
  fields: {
    gdp: { type: 'number', min: 0 },
    gdpGrowth: { type: 'number', min: -0.5, max: 0.5 },
    inflation: { type: 'number', min: -0.2, max: 1 },
    unemployment: { type: 'number', min: 0, max: 1 },
    debt: { type: 'number', min: 0 },
    sectors: { type: 'record', values: sectorSchema },
    trade: {
      type: 'object',
      fields: {
        exports: { type: 'number', min: 0 },
        imports: { type: 'number', min: 0 },
        balance: { type: 'number' }
      }
    },
    lastRevenue: { type: 'number' },
    lastSpending: { type: 'number' },
    lastBalance: { type: 'number' },
    gdpPreviousMonth: { type: 'number', min: 0 }
  }
};

const partyStateSchema: FieldSchema = {
  type: 'object',
  fields: {
    id: { type: 'string' },
    name: { type: 'string' },
    ideology: { type: 'enum', values: ['centrist', 'progressive', 'conservative', 'socialist', 'liberal'] },
    support: { type: 'number', min: 0, max: 1 },
    seatShare: { type: 'number', min: 0, max: 1 },
    inGovernment: { type: 'boolean' }
  }
};

const ministryStateSchema: FieldSchema = {
  type: 'object',
  fields: {
    funding: { type: 'number', min: 0, max: 1 },
    efficiency: { type: 'number', min: 0, max: 1 }
  }
};

const activeModifierSchema: FieldSchema = {
  type: 'object',
  fields: {
    sourceId: { type: 'string' },
    target: { type: 'string' },
    mode: { type: 'enum', values: ['add', 'mul'] },
    value: { type: 'number' },
    monthsLeft: { type: 'number', min: 0, max: 600, integer: true }
  }
};

const pendingEventSchema: FieldSchema = {
  type: 'object',
  fields: {
    instanceId: { type: 'string' },
    eventId: { type: 'string' },
    firedMonth: { type: 'number', min: 0, integer: true },
    expiresMonth: { type: 'number', min: 0, integer: true }
  }
};

const governmentCountrySchema: FieldSchema = {
  type: 'object',
  fields: {
    president: {
      type: 'object',
      fields: {
        name: { type: 'string', minLength: 1 },
        partyId: { type: 'string' },
        termStartMonth: { type: 'number', min: 0, integer: true },
        termLengthMonths: { type: 'number', min: 1, max: 600, integer: true },
        termEndMonth: { type: 'number', min: 0, integer: true },
        approval: { type: 'number', min: 0, max: 1 },
        politicalSupport: { type: 'number', min: 0, max: 1 },
        executiveAuthority: { type: 'number', min: 0, max: 1 },
        termsServed: { type: 'number', min: 0, max: 100, integer: true }
      }
    },
    politics: {
      type: 'object',
      fields: {
        parties: { type: 'record', values: partyStateSchema },
        parliament: {
          type: 'object',
          fields: {
            seatsTotal: { type: 'number', min: 0, integer: true },
            seats: { type: 'record', values: { type: 'number', min: 0, integer: true } }
          }
        },
        coalition: { type: 'array', items: { type: 'string' } },
        corruption: { type: 'number', min: 0, max: 1 },
        publicTrust: { type: 'number', min: 0, max: 1 },
        protestPressure: { type: 'number', min: 0, max: 1 },
        protests: { type: 'enum', values: ['none', 'minor', 'significant', 'massive'] },
        strikePressure: { type: 'number', min: 0, max: 1 },
        generalStrikeUntilMonth: { type: 'union', options: [{ type: 'number', min: 0, integer: true }, { type: 'null' }] }
      }
    },
    elections: {
      type: 'object',
      fields: {
        phase: { type: 'enum', values: ['idle', 'campaigning'] },
        nextElectionMonth: { type: 'number', min: 0, integer: true },
        lastElectionMonth: { type: 'number', integer: true },
        campaignEffort: { type: 'record', values: { type: 'number', min: 0, max: 1 } },
        lastResults: { type: 'union', options: [{ type: 'record', values: { type: 'number', min: 0, max: 1 } }, { type: 'null' }] },
        lastWinnerId: { type: 'union', options: [{ type: 'string' }, { type: 'null' }] }
      }
    },
    ministries: { type: 'record', values: ministryStateSchema },
    budget: {
      type: 'object',
      fields: {
        taxRates: {
          type: 'object',
          fields: {
            income: { type: 'number', min: 0, max: 1 },
            corporate: { type: 'number', min: 0, max: 1 },
            trade: { type: 'number', min: 0, max: 1 }
          }
        },
        spendingShares: {
          type: 'object',
          fields: {
            military: { type: 'number', min: 0, max: 0.5 },
            healthcare: { type: 'number', min: 0, max: 0.5 },
            education: { type: 'number', min: 0, max: 0.5 },
            infrastructure: { type: 'number', min: 0, max: 0.5 },
            welfare: { type: 'number', min: 0, max: 0.5 },
            government: { type: 'number', min: 0, max: 0.5 },
            other: { type: 'number', min: 0, max: 0.5 }
          }
        }
      }
    },
    decisions: {
      type: 'object',
      fields: {
        active: { type: 'array', items: activeModifierSchema },
        cooldowns: { type: 'record', values: { type: 'number', min: 0, integer: true } },
        history: {
          type: 'array',
          items: {
            type: 'object',
            fields: { decisionId: { type: 'string' }, month: { type: 'number', min: 0, integer: true } }
          }
        }
      }
    },
    events: {
      type: 'object',
      fields: {
        pending: { type: 'array', items: pendingEventSchema },
        cooldowns: { type: 'record', values: { type: 'number', min: 0, integer: true } },
        fired: { type: 'array', items: { type: 'string' } }
      }
    },
    opinion: {
      type: 'object',
      fields: {
        topics: {
          type: 'object',
          fields: {
            economy: { type: 'number', min: -1, max: 1 },
            taxes: { type: 'number', min: -1, max: 1 },
            services: { type: 'number', min: -1, max: 1 },
            corruption: { type: 'number', min: -1, max: 1 },
            security: { type: 'number', min: -1, max: 1 }
          }
        }
      }
    },
    lastSimMonth: { type: 'number', min: 0, integer: true }
  }
};

export const GOVERNMENT_SLICE_SCHEMA: FieldSchema = {
  type: 'object',
  fields: {
    countries: { type: 'record', values: governmentCountrySchema }
  }
};

const cityAreaSchema: FieldSchema = {
  type: 'object',
  fields: {
    id: { type: 'string' },
    countryId: { type: 'string' },
    provinceId: { type: 'string' },
    cityId: { type: 'union', options: [{ type: 'string' }, { type: 'null' }] },
    name: { type: 'string' },
    type: {
      type: 'enum',
      values: ['urban_core', 'residential', 'commercial', 'industrial', 'suburban', 'agricultural', 'junction', 'port_area']
    },
    position: pointSchema,
    footprint: { type: 'array', minLength: 3, items: pointSchema },
    population: { type: 'number', min: 0 },
    capacity: { type: 'number', min: 0 },
    development: { type: 'number', min: 0, max: 1 },
    buildings: { type: 'array', items: { type: 'string' } },
    controlledBy: { type: 'string' },
    transportHub: { type: 'boolean' }
  }
};

const cityAreaLinkSchema: FieldSchema = {
  type: 'object',
  fields: {
    id: { type: 'string' },
    kind: { type: 'enum', values: ['road', 'railway', 'sea'] },
    a: { type: 'string' },
    b: { type: 'string' },
    path: { type: 'array', minLength: 2, items: pointSchema },
    length: { type: 'number', min: 0 },
    capacity: { type: 'number', min: 0 },
    condition: { type: 'number', min: 0, max: 1 }
  }
};

export const CITY_AREAS_SLICE_SCHEMA: FieldSchema = {
  type: 'object',
  fields: {
    network: {
      type: 'object',
      fields: {
        areas: { type: 'record', values: cityAreaSchema },
        links: { type: 'record', values: cityAreaLinkSchema }
      }
    }
  }
};

export const GAME_STATE_SCHEMA: FieldSchema = {
  type: 'object',
  allowUnknown: false,
  fields: {
    world: {
      type: 'object',
      fields: {
        worldId: { type: 'string' },
        name: { type: 'string' },
        countries: { type: 'record', values: { type: 'object', fields: { id: { type: 'string' }, name: { type: 'string' } } } },
        provinces: { type: 'record', values: { type: 'object', fields: { id: { type: 'string' }, name: { type: 'string' }, countryId: { type: 'string' } } } },
        cities: {
          type: 'record',
          values: {
            type: 'object',
            fields: { id: { type: 'string' }, name: { type: 'string' }, provinceId: { type: 'string' }, population: positiveNumber }
          }
        },
        regions: {
          type: 'record',
          values: {
            type: 'object',
            fields: {
              id: { type: 'string' },
              name: { type: 'string' },
              provinceId: { type: 'string' },
              capitalCityId: { type: 'union', options: [{ type: 'string' }, { type: 'null' }] },
              gridX: { type: 'number' },
              gridZ: { type: 'number' },
              infrastructure: { type: 'number', min: 0, max: 5 },
              basePopulation: positiveNumber,
              neighbors: { type: 'array', items: { type: 'string' } },
              chunkIds: { type: 'array', items: { type: 'string' } }
            }
          }
        },
        chunks: {
          type: 'record',
          values: {
            type: 'object',
            fields: { id: { type: 'string' }, regionId: { type: 'string' }, gx: { type: 'number' }, gz: { type: 'number' } }
          }
        },
        countryOfRegion: stringRecord,
        regionGridStride: { type: 'number', min: 1 }
      }
    },
    economy: {
      type: 'object',
      fields: {
        treasury: { type: 'record', values: { type: 'number' } },
        stockpiles: { type: 'record', values: { type: 'record', values: { type: 'number' } } },
        factories: {
          type: 'record',
          values: {
            type: 'object',
            fields: {
              id: { type: 'string' },
              typeId: { type: 'string' },
              regionId: { type: 'string' },
              ownerId: { type: 'string' },
              active: { type: 'boolean' },
              lastOutputAmount: { type: 'number' }
            }
          }
        },
        supply: { type: 'record', values: { type: 'number', min: 0, max: 1 } },
        macro: { type: 'record', values: MACRO_ECONOMY_SCHEMA }
      }
    },
    military: {
      type: 'object',
      fields: {
        units: { type: 'record', values: unitSchema },
        formations: {
          type: 'record',
          values: {
            type: 'object',
            fields: {
              id: { type: 'string' },
              name: { type: 'string' },
              level: { type: 'enum', values: ['army', 'corps', 'division', 'brigade', 'battalion'] },
              countryId: { type: 'string' },
              parentId: { type: 'union', options: [{ type: 'string' }, { type: 'null' }] },
              commanderId: { type: 'union', options: [{ type: 'string' }, { type: 'null' }] }
            }
          }
        },
        strengthCache: { type: 'record', values: { type: 'number' } }
      }
    },
    equipment: {
      type: 'object',
      fields: { stockpiles: { type: 'record', values: { type: 'record', values: { type: 'number' } } } }
    },
    characters: {
      type: 'object',
      fields: {
        characters: {
          type: 'record',
          values: {
            type: 'object',
            fields: {
              id: { type: 'string' },
              name: { type: 'string' },
              role: { type: 'enum', values: ['leader', 'commander', 'soldier', 'civilian'] },
              countryId: { type: 'union', options: [{ type: 'string' }, { type: 'null' }] },
              traits: { type: 'array', items: { type: 'string' } }
            }
          }
        }
      }
    },
    population: {
      type: 'object',
      fields: {
        regions: {
          type: 'record',
          values: {
            type: 'object',
            fields: { population: positiveNumber, capacity: positiveNumber, lastGrowth: { type: 'number' } }
          }
        }
      }
    },
    political: {
      type: 'object',
      fields: {
        countries: {
          type: 'record',
          values: {
            type: 'object',
            fields: {
              stability: { type: 'number', min: 0, max: 1 },
              legitimacy: { type: 'number', min: 0, max: 1 },
              warExhaustion: positiveNumber
            }
          }
        }
      }
    },
    diplomacy: {
      type: 'object',
      fields: { relations: { type: 'record', values: { type: 'record', values: { type: 'number', min: -100, max: 100 } } } }
    },
    war: {
      type: 'object',
      fields: {
        wars: {
          type: 'record',
          values: {
            type: 'object',
            fields: {
              id: { type: 'string' },
              attackers: { type: 'array', items: { type: 'string' } },
              defenders: { type: 'array', items: { type: 'string' } },
              startedTick: { type: 'number', min: 0 },
              exhaustionPerDay: positiveNumber
            }
          }
        }
      }
    },
    environment: {
      type: 'object',
      fields: {
        weather: {
          type: 'record',
          values: { type: 'enum', values: ['clear', 'cloudy', 'rain', 'storm'] }
        }
      }
    },
    player: {
      type: 'object',
      fields: {
        countryId: { type: 'string' },
        countryConfirmed: { type: 'boolean' },
        mode: { type: 'union', options: [{ type: 'enum', values: ['president', 'commander', 'soldier', 'aircraft'] }, { type: 'null' }] },
        focusChunkId: { type: 'union', options: [{ type: 'string' }, { type: 'null' }] },
        selection: { type: 'array', items: { type: 'string' } }
      }
    },
    map: {
      type: 'object',
      fields: {
        selectedCountryId: { type: 'union', options: [{ type: 'string' }, { type: 'null' }] },
        selectedProvinceId: { type: 'union', options: [{ type: 'string' }, { type: 'null' }] },
        selectedCityId: { type: 'union', options: [{ type: 'string' }, { type: 'null' }] },
        selectedGridKey: { type: 'union', options: [{ type: 'string' }, { type: 'null' }] },
        selectedRiverId: { type: 'union', options: [{ type: 'string' }, { type: 'null' }] },
        selectedLakeId: { type: 'union', options: [{ type: 'string' }, { type: 'null' }] },
        selectedSiteId: { type: 'union', options: [{ type: 'string' }, { type: 'null' }] },
        selectedBuildingId: { type: 'union', options: [{ type: 'string' }, { type: 'null' }] },
        selectedCityConnectionId: { type: 'union', options: [{ type: 'string' }, { type: 'null' }] },
        layerVisibility: { type: 'record', values: { type: 'boolean' } },
        camera: {
          type: 'object',
          fields: {
            x: { type: 'number' },
            z: { type: 'number' },
            viewHeight: { type: 'number', min: 0.0001 }
          }
        },
        viewport: {
          type: 'object',
          fields: {
            width: { type: 'number', min: 1 },
            height: { type: 'number', min: 1 }
          }
        }
      }
    },
    countries: {
      type: 'object',
      fields: {
        countries: {
          type: 'record',
          values: {
            type: 'object',
            fields: {
              id: { type: 'string' },
              name: { type: 'string', minLength: 1 },
              flag: {
                type: 'object',
                fields: {
                  layout: { type: 'enum', values: ['solid', 'horizontal-stripes', 'vertical-stripes', 'canton'] },
                  colors: { type: 'array', minLength: 1, items: { type: 'string' } },
                  emblem: { type: 'enum', values: ['none', 'star', 'circle', 'crescent', 'sun', 'cross'] },
                  emblemColor: { type: 'string' }
                }
              },
              capitalId: { type: 'union', options: [{ type: 'string' }, { type: 'null' }] },
              population: positiveNumber,
              economy: {
                type: 'object',
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
                fields: {
                  manpower: positiveNumber,
                  armySize: positiveNumber,
                  equipment: positiveNumber,
                  aircraft: positiveNumber,
                  navy: positiveNumber
                }
              },
              foreignRelations: { type: 'record', values: { type: 'number', min: -100, max: 100 } }
            }
          }
        }
      }
    },
    government: GOVERNMENT_SLICE_SCHEMA,
    cityAreas: CITY_AREAS_SLICE_SCHEMA
  }
};

export function validateGameState(state: GameState): ReturnType<typeof validate> {
  return validate(state, GAME_STATE_SCHEMA, 'gameState');
}

/** Throws DataValidationError listing every issue when state is invalid. */
export function validateGameStateOrThrow(state: GameState): void {
  const result = validateGameState(state);
  if (!result.valid) {
    const summary = result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
    throw new Error(`Invalid game state (${result.issues.length} issue(s)): ${summary}`);
  }
}
