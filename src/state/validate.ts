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
        supply: { type: 'record', values: { type: 'number', min: 0, max: 1 } }
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
    }
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
