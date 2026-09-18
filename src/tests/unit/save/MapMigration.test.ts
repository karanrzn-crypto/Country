import { describe, it, expect } from 'vitest';
import { Game } from '../../../core/Game';
import { MemorySaveStorage } from '../../../save/SaveStorage';
import { applyMigrations } from '../../../save/migrations';
import { SAVE_VERSION } from '../../../save/SaveTypes';
import { fnv1a32, stableStringify } from '../../../utils/hash';
import { pickAt } from '../../../world/map/MapQueries';
import { DEFAULT_CONFIG } from '../../../config/configTypes';

/**
 * Save migrations:
 * - v1 → v2: strategic map slice (Part 1)
 * - v2 → v3: country data slice (Part 2)
 * - v3 → v4: country-selection flow (Part 3)
 * - v4 → v5: minute-resolution clock (time v2) — ticks ×15 (15-min → 1-min)
 * - v5 → v6: shared feature selection fields (Part 3.5)
 * - v6 → v7: Phase 2 — government + cityAreas + macro economy
 * - v7 → v8: city-network connection selection field (City Areas view)
 * - v8 → v9: region-selection mode field (province/country land-click pick)
 * - v9 → v10: strategic resource economy (economy.resources record)
 * - v10 → v11: Urban+Roads layer merge; supplier lists
 * - v11 → v12: GLOBAL trade network — policies/pins removed, supplier
 *   amounts, unfilledShortage
 * - v12 → v13: 100% budget pool (economic/military shares) + 4-level tax —
 * - v13 → v14: the light resource economy — macro dies, finance/mines/
 *   research/construction/plants appear, resources gain stock/emergencyImports,
 *   legacy taxRates stripped, shares derived from the saved spending mix
 * - v14 → v15: construction escrow — `paid` becomes `secured`, projects gain
 * - v15 → v16: the SIMPLE economy — 3 resources, money construction, the
 *   transparent cycle; mines/research/plants die, the money scale converts
 *   the waiting/building states (one-time costs, spec §5/§6)
 * - v16 → v17: the WIDER simple economy — buildings anchor to grid cells
 *   (cityId kept for the session heal), the factory money line dies, the
 *   economy-level record appears
 * Old saves must keep loading; nothing is destroyed.
 */
describe('save migrations (v1 → … → v17)', () => {
  const v1 = {
    state: {
      world: { worldId: 'demo-country' },
      player: { countryId: 'republic', mode: null, focusChunkId: null, selection: [] },
      economy: { treasury: { republic: 10_000 } }
    },
    runtime: { tick: 12, rngState: 99, ids: { counters: {} } }
  };

  it('v1 → current injects the default map slice AND the country slice', () => {
    const { data, version } = applyMigrations(v1, 1, SAVE_VERSION);
    expect(version).toBe(SAVE_VERSION);
    const migrated = data as typeof v1 & {
      state: { map?: Record<string, unknown>; countries?: Record<string, unknown> };
    };
    expect(migrated.state.map).toBeDefined();
    expect(migrated.state.map?.selectedCountryId).toBeNull();
    expect(migrated.state.map?.layerVisibility).toBeDefined();
    expect(migrated.state.map?.camera).toBeDefined();
    // Part 2: country slice present with complete per-country data.
    expect(migrated.state.countries).toBeDefined();
    const countries = migrated.state.countries?.countries as Record<string, Record<string, unknown>>;
    expect(Object.keys(countries).length).toBeGreaterThanOrEqual(10);
    for (const state of Object.values(countries)) {
      expect(state.population).toBeGreaterThanOrEqual(0);
      expect(state.economy).toBeDefined();
      expect(state.military).toBeDefined();
      expect(state.flag).toBeDefined();
    }
    // Original fields untouched (no destructive migration).
    expect(migrated.state.player.countryId).toBe('republic');
    // Part 3: migrated saves are already-started campaigns.
    expect((migrated.state.player as Record<string, unknown>).countryConfirmed).toBe(true);
    // v4→v5 converted 15-minute ticks to 1-minute ticks: 12 × 15 = 180.
    expect(migrated.runtime.tick).toBe(180);
    // v6→v7: Phase 2 slices exist for every strategic country.
    const stateMap = migrated.state as unknown as Record<string, Record<string, unknown>>;
    const government = stateMap.government as { countries: Record<string, unknown> };
    const cityAreas = stateMap.cityAreas as { network: { areas: Record<string, unknown>; links: Record<string, unknown> } };
    expect(Object.keys(government.countries).length).toBeGreaterThanOrEqual(10);
    expect(Object.keys(cityAreas.network.areas).length).toBeGreaterThan(0);
    expect(Object.keys(cityAreas.network.links).length).toBeGreaterThan(0);
    const finance = (stateMap.economy as { finance: Record<string, unknown> }).finance;
    expect(Object.keys(finance).length).toBeGreaterThanOrEqual(10);
    // v13→v14: the macro engine is gone from migrated saves entirely.
    expect((stateMap.economy as Record<string, unknown>).macro).toBeUndefined();
  });

  it('v2 → v3 injects only the country slice (map state untouched)', () => {
    const v2 = {
      state: {
        a: 1,
        map: { selectedCountryId: 'country_3', camera: { x: 1, z: 2, viewHeight: 50 } }
      },
      runtime: { tick: 5 }
    };
    const { data, version } = applyMigrations(v2, 2, SAVE_VERSION);
    expect(version).toBe(SAVE_VERSION);
    const migrated = data as { state: Record<string, unknown> };
    expect(migrated.state.a).toBe(1);
    expect((migrated.state.map as Record<string, unknown>).selectedCountryId).toBe('country_3');
    expect(migrated.state.countries).toBeDefined();
    // v3→v4 added player.countryConfirmed without touching anything else.
    // v6→v7 added the government + cityAreas slices (no economy on this payload).
    expect(Object.keys(migrated.state).sort()).toEqual(
      ['a', 'cityAreas', 'countries', 'government', 'map', 'player'].sort()
    );
    expect((migrated.state.player as Record<string, unknown>).countryConfirmed).toBe(true);
  });

  it('v3 → v4 marks the campaign as confirmed (selection never blocks old saves)', () => {
    const v3 = {
      state: {
        player: { countryId: 'country_2', mode: 'president', focusChunkId: null, selection: [] }
      },
      runtime: { tick: 77 }
    };
    const { data, version } = applyMigrations(v3, 3, SAVE_VERSION);
    expect(version).toBe(SAVE_VERSION);
    const migrated = data as { state: { player: Record<string, unknown> } };
    expect(migrated.state.player.countryConfirmed).toBe(true);
    expect(migrated.state.player.countryId).toBe('country_2');
    // v4→v5: 77 × 15 = 1155 game-minutes — the exact saved instant.
    expect((data as typeof v3).runtime.tick).toBe(1155);
  });

  it('v4 → v5 scales runtime.tick ×15 (15-minute ticks → 1-minute ticks)', () => {
    const v4 = {
      state: { player: { countryConfirmed: true } },
      runtime: { tick: 100, rngState: 7, ids: { counters: {} } }
    };
    const { data, version } = applyMigrations(v4, 4, SAVE_VERSION);
    expect(version).toBe(SAVE_VERSION);
    expect((data as typeof v4).runtime.tick).toBe(1500);
  });

  it('v4 → v5 fails loudly on a save without a valid runtime.tick', () => {
    const broken = { state: {}, runtime: {} };
    expect(() => applyMigrations(broken, 4, SAVE_VERSION)).toThrow();
  });

  it('v5 → v6 injects the Part 3.5 feature-selection fields (nulls)', () => {
    const v5 = {
      state: {
        map: {
          selectedCountryId: 'country_1',
          selectedProvinceId: null,
          selectedCityId: null,
          layerVisibility: {},
          camera: { x: 0, z: 0, viewHeight: 200 },
          viewport: { width: 1280, height: 720 }
        }
      },
      runtime: { tick: 10, rngState: 1, ids: { counters: {} } }
    };
    const { data, version } = applyMigrations(v5, 5, SAVE_VERSION);
    expect(version).toBe(SAVE_VERSION);
    const map = (data as typeof v5).state.map as Record<string, unknown>;
    for (const key of [
      'selectedGridKey',
      'selectedRiverId',
      'selectedLakeId',
      'selectedSiteId',
      'selectedBuildingId',
      'selectedCityConnectionId'
    ]) {
      expect(map[key]).toBeNull();
    }
    // Existing selection state is untouched.
    expect(map.selectedCountryId).toBe('country_1');
  });

  it('v8 → v9 injects the region-selection mode default', () => {
    const v8 = {
      state: {
        map: {
          selectedCountryId: 'country_2',
          selectedProvinceId: null,
          selectedCityId: null,
          layerVisibility: {},
          camera: { x: 0, z: 0, viewHeight: 200 },
          viewport: { width: 1280, height: 720 }
        }
      },
      runtime: { tick: 10, rngState: 1, ids: { counters: {} } }
    };
    const { data, version } = applyMigrations(v8, 8, SAVE_VERSION);
    expect(version).toBe(SAVE_VERSION);
    const map = (data as typeof v8).state.map as Record<string, unknown>;
    expect(map.selectionMode).toBe('country');
    // Existing selection state is untouched.
    expect(map.selectedCountryId).toBe('country_2');
  });

  it('v9 → v10 injects the empty strategic-resource economy record', () => {
    const v9 = {
      state: {
        economy: {
          treasury: { country_0: 500 },
          macro: { country_0: { gdp: 1 } }
        },
        map: { selectionMode: 'country' }
      },
      runtime: { tick: 10, rngState: 1, ids: { counters: {} } }
    };
    const { data, version } = applyMigrations(v9, 9, SAVE_VERSION);
    expect(version).toBe(SAVE_VERSION);
    const economy = (data as typeof v9).state.economy as Record<string, unknown>;
    // The empty record passes schema validation; the session heal recomputes
    // everything from the live map, so nothing else is injected here.
    expect(economy.resources).toEqual({});
    // The v13→v14 tail of the chain removed the macro engine; the light
    // finance record container exists (per-country rows come from the heal,
    // which runs with the live map model).
    expect(economy.macro).toBeUndefined();
    expect(economy.finance).toBeDefined();
  });

  it('pre-v11 saves without layers/suppliers gain the v12 trade record shape', () => {
    const v10 = {
      state: { economy: { resources: { country_0: { production: { oil: 4 } } } } },
      runtime: { tick: 10, rngState: 1, ids: { counters: {} } }
    };
    const { data, version } = applyMigrations(v10, 10, 15);
    expect(version).toBe(15);
    const economy = (data as typeof v10).state.economy as Record<string, unknown>;
    expect(economy.resources).toEqual({
      country_0: {
        production: { oil: 4 },
        suppliers: {},
        unfilledShortage: {},
        stock: {},
        emergencyImports: {}
      }
    });
  });

  it('v10→v11: layers merge into urbanRoads; single suppliers become lists (then amounts)', () => {
    const v10 = {
      state: {
        map: { layerVisibility: { cityAreas: true, roads: false, railways: true } },
        economy: {
          resources: {
            country_0: {
              production: { oil: 4 },
              suppliers: { oil: 'country_2', wood: null, iron: ['country_1'] }
            }
          }
        }
      },
      runtime: { tick: 10, rngState: 1, ids: { counters: {} } }
    };
    const { data, version } = applyMigrations(v10, 10, 15);
    expect(version).toBe(15);
    const migrated = data as typeof v10;
    // Visibility: the merged toggle carries the AND of the two old flags
    // (an explicit hide wins); the old keys are gone.
    const visibility = migrated.state.map!.layerVisibility as Record<string, boolean>;
    expect(visibility.urbanRoads).toBe(false); // roads was explicitly OFF
    expect('cityAreas' in visibility).toBe(false);
    expect('roads' in visibility).toBe(false);
    expect(visibility.railways).toBe(true);
    // Suppliers: string → [string] → { seller: amount }; null → dropped.
    const suppliers = (migrated.state.economy!.resources as Record<string, any>).country_0
      .suppliers as Record<string, unknown>;
    expect(suppliers.oil).toEqual({ country_2: 0 });
    expect('wood' in suppliers).toBe(false);
    expect(suppliers.iron).toEqual({ country_1: 0 });
  });

  it('v11→v12: policies and pins are stripped, suppliers become amounts, unfilled is added', () => {
    const v11 = {
      state: {
        economy: {
          resources: {
            country_0: {
              production: { oil: 4 },
              consumption: { oil: 2 },
              imports: { oil: 0 },
              exports: { oil: 0 },
              importPolicy: { oil: true },
              exportPolicy: {},
              suppliers: { oil: ['country_1', 'country_2'] },
              preferredSuppliers: { oil: 'country_1' },
              importCost: 5,
              exportIncome: 0
            }
          }
        }
      },
      runtime: { tick: 10, rngState: 1, ids: { counters: {} } }
    };
    const { data, version } = applyMigrations(v11, 11, 15);
    expect(version).toBe(15);
    const record = (data as typeof v11).state.economy!.resources!.country_0 as Record<string, unknown>;
    // The policy system is GONE (the world market decides for everyone).
    expect('importPolicy' in record).toBe(false);
    expect('exportPolicy' in record).toBe(false);
    expect('preferredSuppliers' in record).toBe(false);
    // Suppliers became per-seller amounts (amounts re-derived on load heal).
    expect(record.suppliers).toEqual({ oil: { country_1: 0, country_2: 0 } });
    expect(record.unfilledShortage).toEqual({});
    // Money and flows pass through untouched.
    expect(record.importCost).toBe(5);
    expect(record.production).toEqual({ oil: 4 });
  });

  it('v12→v13: taxRates become the 100% pool split + a tax level (posture carried over)', () => {
    const v12 = {
      state: {
        government: {
          countries: {
            country_0: {
              president: { name: 'A' },
              politics: {},
              elections: {},
              ministries: {},
              budget: {
                taxRates: { income: 0.22, corporate: 0.19, trade: 0.08 },
                spendingShares: {
                  military: 0.018, healthcare: 0.02, education: 0.018,
                  infrastructure: 0.016, welfare: 0.02, government: 0.024, other: 0.004
                }
              },
              decisions: {},
              events: {},
              opinion: {},
              lastSimMonth: 3
            }
          }
        }
      },
      runtime: { tick: 10, rngState: 1, ids: { counters: {} } }
    };
    const { data, version } = applyMigrations(v12, 12, 15);
    expect(version).toBe(15);
    const record = (data as typeof v12).state.government!.countries!.country_0 as Record<string, unknown>;
    const budget = record.budget as Record<string, unknown>;
    // The legacy rate record is GONE; the pool split + level are present.
    expect('taxRates' in budget).toBe(false);
    // Default burden 0.49 → MEDIUM; military 0.018/0.12 → 15% → economic 85%.
    expect(budget.tax).toBe('medium');
    const shares = budget.shares as Record<string, number>;
    expect(shares.economic).toBeCloseTo(0.85, 12);
    expect(shares.military).toBeCloseTo(0.15, 12);
    expect(shares.economic + shares.military).toBeCloseTo(1, 12);
    // Everything else untouched.
    expect(record.lastSimMonth).toBe(3);
    expect(budget.spendingShares).toEqual({
      military: 0.018, healthcare: 0.02, education: 0.018,
      infrastructure: 0.016, welfare: 0.02, government: 0.024, other: 0.004
    });
  });

  it('v13→v14: the macro engine dies; finance/mines/research/construction/plants are born', () => {
    const v13 = {
      state: {
        economy: {
          treasury: { country_0: 500 },
          macro: { country_0: { gdp: 42, debt: 7, inflation: 0.03 } },
          resources: {
            country_0: {
              production: { iron: 40 },
              consumption: { iron: 30 },
              imports: {},
              exports: {},
              suppliers: {},
              unfilledShortage: {},
              importCost: 0,
              exportIncome: 0
            }
          },
          stockpiles: { republic: { food: 10 } },
          factories: {}
        },
        countries: {
          countries: {
            country_0: {
              economy: { gdp: 25, treasury: 500, income: 12, expenses: 10 }
            }
          }
        }
      },
      runtime: { tick: 10, rngState: 1, ids: { counters: {} } }
    };
    const { data, version } = applyMigrations(v13, 13, 15);
    expect(version).toBe(15);
    const economy = (data as typeof v13).state.economy as Record<string, unknown>;
    // The GDP/debt/inflation engine is GONE.
    expect(economy.macro).toBeUndefined();
    // The new records exist (finance zeroed for countries; mines empty —
    // level defaults are implicit).
    const finance = economy.finance as Record<string, Record<string, unknown>>;
    // No map model in this fixture → the zeroed per-country rows come from
    // the load heal; here only the container must exist.
    expect(finance).toEqual({});
    expect(economy.mines).toEqual({});
    expect(economy.research).toEqual({});
    expect(economy.construction).toEqual({});
    expect(economy.plants).toEqual({});
    // Resource records gained stock + emergencyImports (the heal seeds stock).
    const record = (economy.resources as Record<string, Record<string, unknown>>).country_0!;
    expect(record.stock).toEqual({});
    expect(record.emergencyImports).toEqual({});
    expect(record.production).toEqual({ iron: 40 });
    // The legacy demo-world fields survive untouched.
    expect(economy.stockpiles).toEqual({ republic: { food: 10 } });
    // The country profile's static gdp/income/expenses rows are gone.
    const country = ((data as typeof v13).state.countries!.countries!.country_0) as Record<string, unknown>;
    expect(country.economy).toEqual({ treasury: 500 });
  });

  it('v14→v15: construction projects gain the escrow (paid→secured, waiting/building)', () => {
    const v14 = {
      state: {
        economy: {
          treasury: { country_0: 500 },
          resources: {},
          construction: {
            country_0: {
              projects: [
                {
                  id: 'p1',
                  typeId: 'iron_works',
                  cityId: 'city_0',
                  startedMonth: 3,
                  progress: 1,
                  paid: { iron: 1000, coal: 400 }
                },
                {
                  id: 'p2',
                  typeId: 'oil_refinery',
                  cityId: 'city_0',
                  startedMonth: 5,
                  progress: 0.35,
                  paid: { iron: 280, oil: 0 }
                }
              ]
            }
          }
        }
      },
      runtime: { tick: 10, rngState: 1, ids: { counters: {} } }
    };
    const { data, version } = applyMigrations(v14, 14, 15);
    expect(version).toBe(15);
    const economy = (data as { state: { economy: Record<string, Record<string, { projects: Record<string, unknown>[] }>> } }).state.economy;
    const projects = economy.construction.country_0!.projects;
    // The fully-paid project becomes BUILDING with a full escrow (its build
    // time starts fresh).
    const fullyPaid = projects[0]!;
    expect(fullyPaid['secured']).toEqual({ iron: 1000, coal: 400 });
    expect(fullyPaid['status']).toBe('building');
    expect(fullyPaid['progress']).toBe(0);
    expect(fullyPaid['paid']).toBeUndefined();
    // The partially-paid project stays WAITING with its escrow kept.
    const partial = projects[1]!;
    expect(partial['secured']).toEqual({ iron: 280, oil: 0 });
    expect(partial['status']).toBe('waiting');
    expect(partial['paid']).toBeUndefined();
  });

  it('v15→v16: the SIMPLE economy — money ×6, stock kept, escrow refunded, mines/research/plants die, max→high', () => {
    const v15 = {
      state: {
        economy: {
          treasury: { country_0: 2000 },
          resources: {
            country_0: {
              stock: { food: 800, iron: 900 },
              production: { food: 300 },
              consumption: { food: 200 },
              imports: { food: 10 },
              exports: {},
              suppliers: { food: { country_1: 10 } },
              unfilledShortage: {},
              emergencyImports: { food: 5 },
              importCost: 3,
              exportIncome: 4
            }
          },
          finance: { country_0: { lastTax: 90, lastCustoms: 5, lastExports: 10, lastRevenue: 105, lastSpending: 80, lastBalance: 25, outputGrowth: 1.05 } },
          mines: { dep_0: 2 },
          research: { country_0: { mineLevels: { iron: 2 } } },
          construction: {
            country_0: {
              projects: [
                { id: 'p1', typeId: 'iron_works', cityId: 'city_0', startedMonth: 3, status: 'building', progress: 0.5, secured: { iron: 400 } },
                { id: 'p2', typeId: 'coal_plant', cityId: 'city_0', startedMonth: 5, status: 'waiting', progress: 0.2, secured: { iron: 120, wood: 0 } }
              ]
            }
          },
          plants: { country_0: { plant_1: { id: 'plant_1', typeId: 'iron_works', cityId: 'city_0' } } }
        },
        government: {
          countries: {
            country_0: { budget: { tax: 'max' } },
            country_1: { budget: { tax: 'high' } }
          }
        }
      },
      runtime: { tick: 10, rngState: 1, ids: { counters: {} } }
    };
    const { data, version } = applyMigrations(v15, 15, SAVE_VERSION);
    expect(version).toBe(SAVE_VERSION);
    const economy = (data as { state: { economy: Record<string, unknown> } }).state.economy as Record<string, any>;

    // Money scale: 2,000 M$ → 12,000 units (×6).
    expect(economy.treasury.country_0).toBe(12000);
    // Resources: the REAL stock survives; every tier-priced field is gone.
    const record = economy.resources.country_0;
    expect(record.stock).toEqual({ food: 800, iron: 1020, wood: 0 }); // +120 refunded escrow, wood:0 refunded
    expect(record).not.toHaveProperty('suppliers');
    expect(record).not.toHaveProperty('unfilledShortage');
    expect(record).not.toHaveProperty('emergencyImports');
    expect(record).not.toHaveProperty('importCost');
    expect(record).not.toHaveProperty('exportIncome');
    expect(record.shortage).toEqual({});
    expect(record.tradeIncome).toBe(0);
    // Finance: the new three-against-three ledger; the old balance converts.
    expect(economy.finance.country_0.lastBalance).toBe(150);
    expect(economy.finance.country_0).not.toHaveProperty('lastTax');
    // Mines/research/plants are REMOVED; the empty buildings record exists.
    expect(economy).not.toHaveProperty('mines');
    expect(economy).not.toHaveProperty('research');
    expect(economy).not.toHaveProperty('plants');
    expect(economy.buildings).toEqual({});
    // Construction: the building project keeps its progress; the waiting
    // project refunds its escrow into the stockpile and disappears.
    const projects = economy.construction.country_0.projects;
    expect(projects.length).toBe(1);
    expect(projects[0].id).toBe('p1');
    expect(projects[0].progress).toBe(0.5);
    expect(projects[0]).not.toHaveProperty('status');
    expect(projects[0]).not.toHaveProperty('secured');
    expect(record.stock.iron).toBe(1020); // the refunded escrow
    // FOUR tax levels → THREE: max becomes high, high stays high.
    const government = (data as { state: { government: { countries: Record<string, { budget: { tax: string } }> } } }).state.government.countries;
    expect(government.country_0.budget.tax).toBe('high');
    expect(government.country_1.budget.tax).toBe('high');
  });

  it('v16→v17: cell anchors appear (legacy cityId kept for the heal), factory income line dies, economyLevel appears', () => {
    const v16 = {
      state: {
        economy: {
          treasury: { country_0: 5000 },
          resources: { country_0: { stock: { food: 900 }, production: {}, consumption: {}, imports: {}, exports: {}, shortage: {}, tradeIncome: 0, tradeExpense: 0 } },
          finance: { country_0: { lastTaxIncome: 90, lastTradeIncome: 0, lastFactoryIncome: 60, lastArmyExpense: 10, lastGovernmentExpense: 5, lastInfrastructureExpense: 2, lastBalance: 133 } },
          construction: { country_0: { projects: [{ id: 'p1', typeId: 'farm', cityId: 'city_0', startedMonth: 3, progress: 0.25 }] } },
          buildings: { country_0: { b1: { id: 'b1', typeId: 'farm', cityId: 'city_1' } } }
        }
      },
      runtime: { tick: 10, rngState: 1, ids: { counters: {} } }
    };
    const { data, version } = applyMigrations(v16, 16, SAVE_VERSION);
    expect(version).toBe(SAVE_VERSION);
    const economy = (data as { state: { economy: Record<string, any> } }).state.economy;
    // Finance: the factory income line is GONE (buildings produce goods).
    expect(economy.finance.country_0).not.toHaveProperty('lastFactoryIncome');
    expect(economy.finance.country_0.lastBalance).toBe(133);
    // Buildings/projects carry a provisional empty cellKey; the legacy
    // cityId stays so the session heal can resolve the real cell.
    expect(economy.buildings.country_0.b1).toMatchObject({ id: 'b1', typeId: 'farm', cellKey: '' });
    expect(economy.buildings.country_0.b1.cityId).toBe('city_1');
    expect(economy.construction.country_0.projects[0]).toMatchObject({ id: 'p1', cellKey: '' });
    // The economy level record appears (the heal fills the neutral start).
    expect(economy.economyLevel).toEqual({});
  });

  it('a migrated v1 state gains a schema-valid map slice (explicit v1→v2 stop)', () => {
    const { data } = applyMigrations(v1, 1, 2);
    const migrated = data as { state: Record<string, unknown> };
    expect(migrated.state.map).toBeDefined();
    const map = migrated.state.map as Record<string, unknown>;
    expect(Object.keys(map).sort()).toEqual(
      [
        'buildMode',
        'camera',
        'layerVisibility',
        'selectedBuildingId',
        'selectedCityConnectionId',
        'selectedCityId',
        'selectedCountryId',
        'selectedGridKey',
        'selectedLakeId',
        'selectedProvinceId',
        'selectedRiverId',
        'selectedSiteId',
        'selectionMode',
        'viewport'
      ].sort()
    );
    expect(() => fnv1a32(stableStringify(migrated))).not.toThrow();
  });

  it('current-version saves load with full map selection + country data', () => {
    const storage = new MemorySaveStorage();
    const game = new Game({ seed: 31337, saveStorage: storage });
    game.init();
    const countryId = game.strategicMap.countryOrder[0];
    game.commandBus.send({ type: 'map.select', countryId });
    game.commandBus.send({ type: 'map.setCamera', x: 100, z: 80, viewHeight: 55 });
    game.commandBus.flush();
    game.saveToSlot('v3-slot');

    const game2 = new Game({ seed: 1, saveStorage: storage });
    game2.init();
    game2.loadFromSlot('v3-slot');
    expect(game2.gameState.map.selectedCountryId).toBe(countryId);
    expect(game2.gameState.map.camera.viewHeight).toBeCloseTo(55, 6);
    // Camera clamped to bounds.
    const bounds = game2.strategicMap.bounds;
    expect(game2.gameState.map.camera.x).toBeGreaterThanOrEqual(bounds.minX - 10);
    // Country data survived the roundtrip, capitals re-joined to live map.
    const loaded = game2.gameState.countries.countries[countryId];
    expect(loaded).toBeDefined();
    expect(loaded.capitalId).toBe(game2.strategicMap.countries[countryId].capitalCityId);
    expect(loaded.population).toBeGreaterThan(0);
    game.dispose();
    game2.dispose();
  });

  it('Part 3: save/load preserves geographic layer toggles + regenerated model without loss', () => {
    const seed = 2024;
    const storage = new MemorySaveStorage();
    const game = new Game({ seed, saveStorage: storage });
    game.init();

    // Toggle a spread of Part-3 layers to NON-default values.
    game.mapSetLayerVisible('grid', true);
    game.mapSetLayerVisible('resources', true);
    game.mapSetLayerVisible('industry', true);
    game.mapSetLayerVisible('railways', true);
    game.mapSetLayerVisible('population', true);
    game.mapSetLayerVisible('biomes', true); // exclusive group: terrain forced off

    // Select a country capital so selection survival is exercised too.
    const countryId = game.strategicMap.countryOrder[0];
    const capitalId = game.strategicMap.countries[countryId].capitalCityId;
    game.mapSelect({ countryId, cityId: capitalId });
    game.saveToSlot('part3-slot');

    // Same seed → the load regenerates the SAME deterministic geography.
    const game2 = new Game({ seed, saveStorage: storage });
    game2.init();
    game2.loadFromSlot('part3-slot');

    // 1) Every layer toggle survives the roundtrip exactly.
    const savedVisibility = game.gameState.map.layerVisibility;
    for (const layer of Object.keys(savedVisibility) as (keyof typeof savedVisibility)[]) {
      expect(game2.gameState.map.layerVisibility[layer]).toBe(savedVisibility[layer]);
    }
    // 2) The regenerated Part-3 model is IDENTICAL to the saved one.
    expect(stableStringify(game2.strategicMap)).toBe(stableStringify(game.strategicMap));
    // 3) Selection survives (ids exist in the same-seed model).
    expect(game2.gameState.map.selectedCountryId).toBe(countryId);
    expect(game2.gameState.map.selectedCityId).toBe(capitalId);
    // 4) Population tree invariants hold on the LOADED model:
    //    Σ city populations = province population, and Σ provinces = declared.
    const model = game2.strategicMap;
    let checkedProvinces = 0;
    for (const province of Object.values(model.provinces)) {
      const citySum = province.cityIds.reduce((sum, id) => sum + model.cities[id].population, 0);
      expect(citySum).toBe(province.population);
      checkedProvinces++;
    }
    expect(checkedProvinces).toBeGreaterThan(0);
    const declared = game2.gameState.countries.countries[countryId].population;
    const provinceSum = model.countries[countryId].provinceIds.reduce(
      (sum, id) => sum + model.provinces[id].population,
      0
    );
    expect(provinceSum).toBe(declared);
    // 5) Part-3 feature payload is present after load (no silent empty fields).
    expect(model.features.gridIds.filter((id) => id !== null).length).toBeGreaterThan(0);
    expect(model.features.rivers.length).toBeGreaterThan(0);
    expect(model.features.deposits.length).toBeGreaterThan(0);
    expect(model.features.buildings.length).toBeGreaterThan(0);
    game.dispose();
    game2.dispose();
  });

  it('Part 3.5: a grid-cell selection survives the save/load roundtrip', () => {
    const seed = 2025;
    const storage = new MemorySaveStorage();
    const game = new Game({ seed, saveStorage: storage });
    game.init();
    // Enable the grid layer, then pick a land cell by world position. The
    // cell must be FREE of higher-priority features (city/river/lake) so the
    // pick really lands on the grid cell — found with the same pure pickAt
    // the game uses, mirroring Game.pickOptions eligibility.
    game.mapSetLayerVisible('grid', true);
    const model = game.strategicMap;
    const cellSize = DEFAULT_CONFIG.map.cellSize;
    const columns = DEFAULT_CONFIG.map.columns;
    const rows = DEFAULT_CONFIG.map.rows;
    const pickRadius = DEFAULT_CONFIG.map.pickRadiusFraction * 200;
    const pickOptions = {
      pickRadius,
      riverPickDistance: Math.max(pickRadius, cellSize * 0.35),
      columns,
      rows,
      cellSize,
      eligibility: { grid: true, rivers: true, lakes: true, sites: false, buildings: false }
    };
    let target: { x: number; z: number; cellIndex: number } | null = null;
    for (let index = 0; index < model.features.gridIds.length; index++) {
      if (model.features.cellOwner[index] < 0 || model.features.gridIds[index] === null) continue;
      const cx = index % columns;
      const cz = Math.floor(index / columns);
      const point = { x: (cx + 0.5) * cellSize, z: (cz + 0.5) * cellSize };
      const probe = pickAt(model, point, pickOptions);
      if (probe.gridCellKey !== null && probe.cityId === null && probe.riverId === null && probe.lakeId === null) {
        target = { x: point.x, z: point.z, cellIndex: index };
        break;
      }
    }
    expect(target).not.toBeNull();
    const { x, z, cellIndex } = target as { x: number; z: number; cellIndex: number };
    game.commandBus.send({ type: 'map.pick', x, z });
    game.commandBus.flush();
    expect(game.gameState.map.selectedGridKey).toBe(
      `${model.countryOrder[model.features.cellOwner[cellIndex]]}#${model.features.gridIds[cellIndex]}`
    );
    game.saveToSlot('grid-slot');

    const game2 = new Game({ seed, saveStorage: storage });
    game2.init();
    game2.loadFromSlot('grid-slot');
    expect(game2.gameState.map.selectedGridKey).toBe(game.gameState.map.selectedGridKey);
    // The hierarchy stays clear — one coherent selection kind.
    expect(game2.gameState.map.selectedCountryId).toBeNull();
    game.dispose();
    game2.dispose();
  });

  it('heals map selections that reference ids missing from the live map (generation drift)', () => {
    const storage = new MemorySaveStorage();
    const game = new Game({ seed: 4242, saveStorage: storage });
    game.init();
    const countryId = game.strategicMap.countryOrder[0];
    game.commandBus.send({ type: 'map.select', countryId });
    game.commandBus.flush();
    game.saveToSlot('drift-slot');

    // Simulate an older save whose generated city/province/country ids no
    // longer exist after a map-generation change (config/seed drift).
    const raw = JSON.parse(storage.load('drift-slot') as string) as {
      meta: { checksum: number };
      data: { state: { map: Record<string, unknown> } };
    };
    raw.data.state.map.selectedCountryId = 'country_does_not_exist';
    raw.data.state.map.selectedProvinceId = 'prov_does_not_exist';
    raw.data.state.map.selectedCityId = 'city_does_not_exist';
    // Re-seal the tampered payload with a VALID checksum: the save must be
    // structurally fine — only the referenced ids are stale.
    raw.meta.checksum = fnv1a32(stableStringify(raw.data));
    storage.save('drift-slot', JSON.stringify(raw));

    const game2 = new Game({ seed: 1, saveStorage: storage });
    game2.init();
    expect(() => game2.loadFromSlot('drift-slot')).not.toThrow();
    expect(game2.gameState.map.selectedCountryId).toBeNull();
    expect(game2.gameState.map.selectedProvinceId).toBeNull();
    expect(game2.gameState.map.selectedCityId).toBeNull();
    // The rest of the slice survives the heal.
    expect(game2.gameState.map.camera).toBeDefined();
    expect(game2.gameState.map.layerVisibility).toBeDefined();
    game.dispose();
    game2.dispose();
  });
});
