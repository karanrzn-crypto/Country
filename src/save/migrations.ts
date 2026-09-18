import { SaveError } from '../utils/errors';
import { createDefaultMapSlice } from '../state/slices/mapSlice';
import { buildCountrySlice } from '../state/slices/countrySlice';
import { buildGovernmentSlice } from '../state/slices/governmentSlice';
import { createCityAreasSlice } from '../state/slices/cityAreasSlice';

import { generateStrategicMap } from '../world/map/MapGenerator';
import { DEFAULT_CONFIG } from '../config/configTypes';
import { Random } from '../utils/Random';
import countriesJson from '../data/countries.json';
import partiesJson from '../data/government/parties.json';
import ministriesJson from '../data/government/ministries.json';
import type { CountryProfileJson } from '../data/types';
import type { PartyTemplate, MinistryTemplate } from '../state/slices/governmentSlice';

/**
 * Save migration framework. When SAVE_VERSION bumps, register a migration
 * stepping (from → to). Loading applies the chain in order and fails loudly
 * when a path is missing — old saves never load silently wrong.
 */
export interface SaveMigration {
  readonly from: number;
  readonly to: number;
  readonly migrate: (data: unknown) => unknown;
}

/**
 * Built-in migration chain (registered once at module load).
 *
 * v1 → v2: the strategic map slice (Part 1) was added to GameState.
 * Old saves carry no `state.map`; inject the documented default so the
 * schema validation and slice restore keep working unchanged.
 *
 * v2 → v3: the country data slice (Part 2) was added to GameState. The slice
 * is rebuilt from the static profiles + the default-config map (deterministic);
 * the session then re-syncs capital joins against its live map model on load
 * (Game.applyLoadedSnapshot), so this remains correct for any map config.
 */
const BUILT_IN_MIGRATIONS: readonly SaveMigration[] = [
  {
    from: 1,
    to: 2,
    migrate: (data) => {
      if (data === null || typeof data !== 'object') {
        throw new SaveError('Migration v1→v2: save payload is not an object');
      }
      const source = data as { state?: Record<string, unknown> };
      if (source.state === undefined || typeof source.state !== 'object') {
        throw new SaveError('Migration v1→v2: save has no state object');
      }
      const clone = JSON.parse(JSON.stringify(data)) as { state: Record<string, unknown> };
      clone.state.map = createDefaultMapSlice();
      return clone;
    }
  },
  {
    from: 2,
    to: 3,
    migrate: (data) => {
      if (data === null || typeof data !== 'object') {
        throw new SaveError('Migration v2→v3: save payload is not an object');
      }
      const source = data as { state?: Record<string, unknown> };
      if (source.state === undefined || typeof source.state !== 'object') {
        throw new SaveError('Migration v2→v3: save has no state object');
      }
      const clone = JSON.parse(JSON.stringify(data)) as { state: Record<string, unknown> };
      if (clone.state.countries === undefined) {
        // Part 3: the regenerated model anchors its population tree on the
        // SAME declared profile populations the slice is built from.
        const declaredPopulations = Object.fromEntries(
          (countriesJson as unknown as readonly CountryProfileJson[]).map((profile) => [
            profile.id,
            profile.population
          ])
        );
        const mapModel = generateStrategicMap(DEFAULT_CONFIG.map, {
          countryPopulations: declaredPopulations
        }).model;
        clone.state.countries = buildCountrySlice(
          countriesJson as unknown as readonly CountryProfileJson[],
          mapModel
        );
      }
      return clone;
    }
  },
  {
    // v3 → v4: the country-selection flow (Part 3) added player.countryConfirmed.
    // Every pre-existing save represents an already-started campaign, so the
    // field is injected as true — the selection screen never blocks old saves.
    // New map layers need NO migration: layer visibility is a record and the
    // session merges registry defaults over whatever the save carries.
    from: 3,
    to: 4,
    migrate: (data) => {
      if (data === null || typeof data !== 'object') {
        throw new SaveError('Migration v3→v4: save payload is not an object');
      }
      const source = data as { state?: Record<string, unknown> };
      if (source.state === undefined || typeof source.state !== 'object') {
        throw new SaveError('Migration v3→v4: save has no state object');
      }
      const clone = JSON.parse(JSON.stringify(data)) as {
        state: { player?: Record<string, unknown> };
      };
      if (clone.state.player === undefined || typeof clone.state.player !== 'object') {
        clone.state.player = {};
      }
      clone.state.player.countryConfirmed = true;
      return clone;
    }
  },
  {
    // v4 → v5: the clock became MINUTE-resolution (time v2). Pre-v5 saves
    // store runtime.tick in 15-minute ticks (hoursPerTick 0.25); v5+ stores
    // 1-minute ticks, so the saved instant must scale by ×15 to preserve the
    // exact campaign moment across the upgrade.
    from: 4,
    to: 5,
    migrate: (data) => {
      if (data === null || typeof data !== 'object') {
        throw new SaveError('Migration v4→v5: save payload is not an object');
      }
      const clone = JSON.parse(JSON.stringify(data)) as {
        runtime?: { tick?: unknown };
      };
      const tick = clone.runtime?.tick;
      if (typeof tick !== 'number' || !Number.isFinite(tick) || tick < 0) {
        throw new SaveError('Migration v4→v5: save has no valid runtime.tick');
      }
      if (clone.runtime === undefined) {
        throw new SaveError('Migration v4→v5: save has no runtime object');
      }
      (clone.runtime as { tick: number }).tick = Math.floor(tick * 15);
      return clone;
    }
  },
  {
    from: 5,
    to: 6,
    migrate: (data) => {
      if (data === null || typeof data !== 'object') {
        throw new SaveError('Migration v5→v6: save payload is not an object');
      }
      // Part 3.5: the shared feature selection (grid cell / river / lake /
      // site / building) added five nullable fields to the map slice. Old
      // saves predate them — inject the documented nulls so schema
      // validation passes; actual selections are session-state only.
      const clone = JSON.parse(JSON.stringify(data)) as {
        state?: Record<string, unknown>;
      };
      const map = clone.state?.map as Record<string, unknown> | undefined;
      if (map !== undefined) {
        for (const key of [
          'selectedGridKey',
          'selectedRiverId',
          'selectedLakeId',
          'selectedSiteId',
          'selectedBuildingId'
        ]) {
          if (typeof map[key] !== 'string') map[key] = null;
        }
      }
      return clone;
    }
  },
  {
    // v6 → v7: Phase 2 added three state areas — (1) `government` slice
    // (presidency/parties/budget/decisions/events) per strategic country,
    // (2) `cityAreas` (urban/transport network generated from the map),
    // (3) `economy.macro` (national accounts) + strategic-country records in
    // `political.countries` + strategic-country treasuries. Everything is
    // rebuilt from the SAME deterministic map generation the campaign used
    // (DEFAULT_CONFIG + declared populations); the session re-syncs city
    // areas against the live model on load (Game.applyLoadedSnapshot).
    from: 6,
    to: 7,
    migrate: (data) => {
      if (data === null || typeof data !== 'object') {
        throw new SaveError('Migration v6→v7: save payload is not an object');
      }
      const source = data as { state?: Record<string, unknown> };
      if (source.state === undefined || typeof source.state !== 'object') {
        throw new SaveError('Migration v6→v7: save has no state object');
      }
      const clone = JSON.parse(JSON.stringify(data)) as {
        state: {
          economy?: Record<string, unknown>;
          political?: { countries?: Record<string, unknown> };
          countries?: { countries?: Record<string, { population?: number; economy?: { treasury?: number } }> };
          government?: unknown;
          cityAreas?: unknown;
        };
      };

      const declaredPopulations = Object.fromEntries(
        (countriesJson as unknown as readonly CountryProfileJson[]).map((profile) => [
          profile.id,
          profile.population
        ])
      );
      const mapGeneration = generateStrategicMap(DEFAULT_CONFIG.map, {
        countryPopulations: declaredPopulations
      });
      const model = mapGeneration.model;

      // (1) government slice
      if (clone.state.government === undefined) {
        const countryNames: Record<string, string> = {};
        for (const countryId of model.countryOrder) {
          countryNames[countryId] = model.countries[countryId].name;
        }
        clone.state.government = buildGovernmentSlice(
          model.countryOrder,
          countryNames,
          Object.values(partiesJson) as unknown as PartyTemplate[],
          Object.values(ministriesJson) as unknown as MinistryTemplate[],
          new Random((DEFAULT_CONFIG.map.seed ^ 0x9e3779b9) >>> 0)
        );
      }

      // (2) city areas
      if (clone.state.cityAreas === undefined) {
        clone.state.cityAreas = createCityAreasSlice(model, DEFAULT_CONFIG.map.columns);
      }

      // (3) macro economy + treasuries + political records. Conservative:
      // only touched when the parent objects already exist (real saves do);
      // the session's load heal fills any remaining gaps per live country.
      if (clone.state.economy !== undefined) {
        const economy = clone.state.economy as { finance?: Record<string, unknown>; treasury?: Record<string, number> };
        if (economy.finance === undefined) economy.finance = {};
        if (economy.treasury === undefined) economy.treasury = {};
        const profiles = countriesJson as unknown as readonly CountryProfileJson[];
        for (const countryId of model.countryOrder) {
          const profile = profiles.find((candidate) => candidate.id === countryId);
          if (economy.finance[countryId] === undefined) {
            economy.finance[countryId] = { lastTax: 0, lastCustoms: 0, lastExports: 0, lastRevenue: 0, lastSpending: 0, lastBalance: 0, outputGrowth: 1 };
          }
          if (economy.treasury[countryId] === undefined) {
            economy.treasury[countryId] = profile?.economy.treasury ?? DEFAULT_CONFIG.economy.startingTreasury;
          }
        }
      }
      if (clone.state.political?.countries !== undefined) {
        const political = clone.state.political as { countries: Record<string, unknown> };
        for (const countryId of model.countryOrder) {
          if (political.countries[countryId] === undefined) {
            political.countries[countryId] = { stability: 0.6, legitimacy: 0.7, warExhaustion: 0 };
          }
        }
      }
      return clone;
    }
  },
  {
    from: 7,
    to: 8,
    migrate: (data) => {
      if (data === null || typeof data !== 'object') {
        throw new SaveError('Migration v7→v8: save payload is not an object');
      }
      // City-network connection selection: one more nullable map-slice field
      // (selections are session-state only — old saves get the null default
      // so schema validation passes; the session heal drops stale ids).
      const clone = JSON.parse(JSON.stringify(data)) as {
        state?: { map?: Record<string, unknown> };
      };
      const map = clone.state?.map;
      if (map !== undefined && typeof map.selectedCityConnectionId !== 'string') {
        map.selectedCityConnectionId = null;
      }
      return clone;
    }
  },
  {
    from: 8,
    to: 9,
    migrate: (data) => {
      if (data === null || typeof data !== 'object') {
        throw new SaveError('Migration v8→v9: save payload is not an object');
      }
      // Region-selection mode (province/country land-click pick) added to
      // the map slice. Old saves predate the toggle — inject the documented
      // default ('country') so schema validation passes unchanged.
      const clone = JSON.parse(JSON.stringify(data)) as {
        state?: { map?: Record<string, unknown> };
      };
      const map = clone.state?.map;
      if (map !== undefined && map.selectionMode !== 'country' && map.selectionMode !== 'province') {
        map.selectionMode = 'country';
      }
      return clone;
    }
  },
  {
    from: 9,
    to: 10,
    migrate: (data) => {
      if (data === null || typeof data !== 'object') {
        throw new SaveError('Migration v9→v10: save payload is not an object');
      }
      // Strategic resource economy (economy.resources) added to the economy
      // slice. Old saves predate it — inject the empty record; the session
      // heal (healPhase2State) recomputes everything from the live map, so
      // the empty record is only a schema-valid placeholder.
      const clone = JSON.parse(JSON.stringify(data)) as {
        state?: { economy?: Record<string, unknown> };
      };
      const economy = clone.state?.economy;
      if (economy !== undefined && economy.resources === undefined) {
        economy.resources = {};
      }
      return clone;
    }
  },
  {
    from: 10,
    to: 11,
    migrate: (data) => {
      if (data === null || typeof data !== 'object') {
        throw new SaveError('Migration v10→v11: save payload is not an object');
      }
      // (1) Map layers: 'Urban Areas' + 'Roads' merged into the ONE
      // 'urbanRoads' toggle (spec). The saved value carries over as the AND
      // of the two old flags (an explicit hide wins), and the old keys are
      // dropped — the load heal fills registry defaults for anything missing.
      // (2) Resource trade: `suppliers` became a LIST per resource (the
      // market fills a deficit from several sellers) — convert the old
      // single-supplier strings/nulls so schema validation passes.
      const clone = JSON.parse(JSON.stringify(data)) as {
        state?: {
          map?: { layerVisibility?: Record<string, boolean> };
          economy?: { resources?: Record<string, Record<string, unknown>> };
        };
      };
      const visibility = clone.state?.map?.layerVisibility;
      if (visibility !== undefined) {
        const merged =
          visibility['cityAreas'] !== false && visibility['roads'] !== false;
        delete visibility['cityAreas'];
        delete visibility['roads'];
        visibility['urbanRoads'] = merged;
      }
      const resources = clone.state?.economy?.resources;
      if (resources !== undefined) {
        for (const record of Object.values(resources)) {
          const suppliers = record?.['suppliers'];
          if (suppliers === undefined || suppliers === null || typeof suppliers !== 'object') continue;
          const converted: Record<string, string[]> = {};
          for (const [resourceId, value] of Object.entries(suppliers as Record<string, unknown>)) {
            if (typeof value === 'string') converted[resourceId] = [value];
            else if (Array.isArray(value)) {
              converted[resourceId] = value.filter((entry): entry is string => typeof entry === 'string');
            }
            // null / anything else → no entry (no active suppliers).
          }
          record['suppliers'] = converted;
        }
      }
      return clone;
    }
  },
  {
    from: 11,
    to: 12,
    migrate: (data) => {
      if (data === null || typeof data !== 'object') {
        throw new SaveError('Migration v11→v12: save payload is not an object');
      }
      // The GLOBAL trade network (world-level matching) replaced the player
      // policy system: import/export policies + the pinned supplier are gone
      // (trade resolves automatically for EVERY country), `suppliers` became
      // a per-seller AMOUNT record (resourceId → sellerId → units), and the
      // world market reports its `unfilledShortage`. The session heal
      // recomputes all flows from the live map right after load.
      const clone = JSON.parse(JSON.stringify(data)) as {
        state?: { economy?: { resources?: Record<string, Record<string, unknown>> } };
      };
      const resources = clone.state?.economy?.resources;
      if (resources !== undefined) {
        for (const record of Object.values(resources)) {
          if (record === undefined || typeof record !== 'object') continue;
          delete record['importPolicy'];
          delete record['exportPolicy'];
          delete record['preferredSuppliers'];
          const suppliers = record['suppliers'];
          const converted: Record<string, Record<string, number>> = {};
          if (suppliers !== undefined && suppliers !== null && typeof suppliers === 'object') {
            for (const [resourceId, value] of Object.entries(suppliers as Record<string, unknown>)) {
              if (Array.isArray(value)) {
                // v11 list form: seller ids without stored amounts — the
                // amounts are re-derived by the post-load recompute.
                const bySeller: Record<string, number> = {};
                for (const sellerId of value) {
                  if (typeof sellerId === 'string') bySeller[sellerId] = 0;
                }
                if (Object.keys(bySeller).length > 0) converted[resourceId] = bySeller;
              } else if (value !== null && typeof value === 'object') {
                // Already the v12 record form — keep it (amounts ≥ 0).
                const bySeller: Record<string, number> = {};
                for (const [sellerId, amount] of Object.entries(value as Record<string, unknown>)) {
                  if (typeof amount === 'number' && Number.isFinite(amount) && amount >= 0) {
                    bySeller[sellerId] = amount;
                  }
                }
                if (Object.keys(bySeller).length > 0) converted[resourceId] = bySeller;
              }
              // null / anything else → no entry (no active import flow).
            }
          }
          record['suppliers'] = converted;
          if (record['unfilledShortage'] === undefined) record['unfilledShortage'] = {};
        }
      }
      return clone;
    }
  },
  {
    from: 12,
    to: 13,
    migrate: (data) => {
      if (data === null || typeof data !== 'object') {
        throw new SaveError('Migration v12→v13: save payload is not an object');
      }
      // The 100% budget pool + the 4-level tax replaced the three tax rates
      // and the independent GDP-share levers (spec §1/§4/§9):
      //  - `shares` derives from the OLD spending mix (the military fraction
      //    of total spending carries the saved posture over),
      //  - `tax` maps from the old combined rate burden (defaults → medium),
      //  - `taxRates` is deleted (the validator rejects unknown fields),
      //  - spendingShares stay (they become the derived money plumbing).
      const clone = JSON.parse(JSON.stringify(data)) as {
        state?: { government?: { countries?: Record<string, Record<string, unknown>> } };
      };
      const countries = clone.state?.government?.countries;
      if (countries !== undefined) {
        for (const record of Object.values(countries)) {
          const budget = record?.['budget'] as Record<string, unknown> | undefined;
          if (budget === undefined || typeof budget !== 'object') continue;
          // Records rebuilt mid-chain (v6→v7) already carry the new shape —
          // only migrate records that still carry the legacy `taxRates`.
          const rates = budget['taxRates'];
          if (rates === undefined || rates === null || typeof rates !== 'object') continue;
          const spending = (budget['spendingShares'] ?? {}) as Record<string, number>;
          let total = 0;
          let military = 0;
          for (const [category, share] of Object.entries(spending)) {
            if (typeof share !== 'number' || !Number.isFinite(share) || share < 0) continue;
            total += share;
            if (category === 'military') military = share;
          }
          const militaryFraction = total > 1e-9 ? Math.min(1, Math.max(0, military / total)) : 0.15;
          budget['shares'] = { economic: 1 - militaryFraction, military: militaryFraction };
          const typedRates = rates as Record<string, number>;
          const burden =
            (typeof typedRates.income === 'number' ? typedRates.income : 0) +
            (typeof typedRates.corporate === 'number' ? typedRates.corporate : 0) +
            (typeof typedRates.trade === 'number' ? typedRates.trade : 0);
          budget['tax'] = burden <= 0.36 ? 'low' : burden <= 0.55 ? 'medium' : burden <= 0.75 ? 'high' : 'max';
          delete budget['taxRates'];
        }
      }
      return clone;
    }
  },
  {
    from: 13,
    to: 14,
    migrate: (data) => {
      if (data === null || typeof data !== 'object') {
        throw new SaveError('Migration v13\u2192v14: save payload is not an object');
      }
      // The GDP/debt/inflation macro engine is REPLACED by the light resource
      // economy (spec \u00a710/\u00a720): `economy.macro` dies, and finance /
      // mines / research / construction / plants records appear. Resource
      // records gain `stock` + `emergencyImports` (the heal seeds the buffer),
      // and the country profiles' static gdp/income/expenses rows disappear.
      const clone = JSON.parse(JSON.stringify(data)) as {
        state?: {
          economy?: Record<string, unknown>;
          countries?: { countries?: Record<string, Record<string, unknown>> };
        };
      };
      const economy = clone.state?.economy;
      if (economy !== undefined) {
        delete economy['macro'];
        if (economy['finance'] === undefined) economy['finance'] = {};
        if (economy['mines'] === undefined) economy['mines'] = {};
        if (economy['research'] === undefined) economy['research'] = {};
        if (economy['construction'] === undefined) economy['construction'] = {};
        if (economy['plants'] === undefined) economy['plants'] = {};
        const resources = economy['resources'] as Record<string, Record<string, unknown>> | undefined;
        if (resources !== undefined) {
          for (const record of Object.values(resources)) {
            if (record['stock'] === undefined) record['stock'] = {};
            if (record['emergencyImports'] === undefined) record['emergencyImports'] = {};
          }
        }
      }
      const countries = clone.state?.countries?.countries;
      if (countries !== undefined) {
        for (const record of Object.values(countries)) {
          const economyProfile = record?.['economy'] as Record<string, unknown> | undefined;
          if (economyProfile === undefined) continue;
          economyProfile['treasury'] = economyProfile['treasury'] ?? 500;
          delete economyProfile['gdp'];
          delete economyProfile['income'];
          delete economyProfile['expenses'];
        }
      }
      return clone;
    }
  },
  {
    from: 14,
    to: 15,
    migrate: (data) => {
      if (data === null || typeof data !== 'object') {
        throw new SaveError('Migration v14\u2192v15: save payload is not an object');
      }
      // Construction became a ONE-TIME cost with RESERVED resources and the
      // waiting/building states (spec \u00a75/\u00a76): each project's monthly-paid
      // `paid` ledger becomes the `secured` escrow; a fully-paid project
      // flips to `building` (it still has its build time ahead of it), a
      // partially-paid one stays `waiting`.
      const clone = JSON.parse(JSON.stringify(data)) as {
        state?: { economy?: { construction?: Record<string, { projects?: Record<string, unknown>[] }> } };
      };
      const construction = clone.state?.economy?.construction;
      if (construction !== undefined) {
        for (const countryRecord of Object.values(construction)) {
          const projects = countryRecord?.['projects'];
          if (!Array.isArray(projects)) continue;
          for (const project of projects) {
            if (project === null || typeof project !== 'object') continue;
            const record = project as Record<string, unknown>;
            const paid = (record['paid'] ?? {}) as Record<string, number>;
            const secured: Record<string, number> = {};
            for (const [resourceId, amount] of Object.entries(paid)) {
              const units = typeof amount === 'number' && Number.isFinite(amount) ? Math.max(0, Math.round(amount)) : 0;
              secured[resourceId] = units;
            }
            // Costs come from the config via the typeId — the migration has
            // no config access, so fully-paid is judged by the OLD progress
            // value (Σ paid / Σ cost, exactly 1 for a fully-paid project).
            const progress = typeof record['progress'] === 'number' ? record['progress'] : 0;
            record['secured'] = secured;
            record['status'] = progress >= 1 ? 'building' : 'waiting';
            if (progress >= 1) record['progress'] = 0; // build time starts now
            delete record['paid'];
          }
        }
      }
      return clone;
    }
  },
  {
    // v15 → v16: the SIMPLE economy (spec §1-§14). Per country:
    //  - resources: keep the real stock; drop the tier-priced trade fields,
    //    the suppliers map, the unfilled/emergency records — the simple
    //    record is stock/production/consumption/trade/shortage;
    //  - finance: the THREE-line ledger (tax/trade/factories vs army/
    //    government/infrastructure) replaces Tax+Customs+Exports−pot;
    //    the old lastBalance converts at the money rescale below;
    //  - construction: escrow projects become money-paid projects —
    //    waiting projects are dismantled and their secured units refund
    //    to the stockpile, building projects keep their progress;
    //  - mines/research/plants are REMOVED (no levels, no research tree —
    //    pre-simple-economy plants are dismantled: the new building ids
    //    and effects differ);
    //  - the money scale converts M$ → units (×6, matching the new 12,000
    //    starting treasury against the old ~2,000 M$ scale);
    //  - the FOUR tax levels collapse to THREE (max → high).
    from: 15,
    to: 16,
    migrate: (data) => {
      if (data === null || typeof data !== 'object') {
        throw new SaveError('Migration v15\u2192v16: save payload is not an object');
      }
      const clone = JSON.parse(JSON.stringify(data)) as {
        state?: {
          economy?: {
            treasury?: Record<string, unknown>;
            resources?: Record<string, Record<string, unknown>>;
            finance?: Record<string, Record<string, unknown>>;
            construction?: Record<string, { projects?: unknown[] }>;
            mines?: unknown;
            research?: unknown;
            plants?: unknown;
            buildings?: Record<string, unknown>;
          };
          government?: { countries?: Record<string, { budget?: { tax?: unknown } }> };
        };
      };
      const economy = clone.state?.economy;
      if (economy !== undefined) {
        // Money scale: M$ → units (×6).
        const MONEY_SCALE = 6;
        const scale = (value: unknown): number =>
          typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value * MONEY_SCALE)) : 0;
        if (economy.treasury !== undefined && typeof economy.treasury === 'object') {
          for (const [key, value] of Object.entries(economy.treasury)) {
            economy.treasury[key] = scale(value);
          }
        }
        // Resources: keep the stock only; the heal reseeds the rest.
        if (economy.resources !== undefined && typeof economy.resources === 'object') {
          for (const record of Object.values(economy.resources)) {
            if (record === null || typeof record !== 'object') continue;
            const stock = (record['stock'] ?? {}) as Record<string, unknown>;
            const cleanStock: Record<string, number> = {};
            for (const [resourceId, amount] of Object.entries(stock)) {
              const units = typeof amount === 'number' && Number.isFinite(amount) ? Math.max(0, Math.round(amount)) : 0;
              if (units > 0) cleanStock[resourceId] = units;
            }
            const next = record as Record<string, unknown>;
            next['stock'] = cleanStock;
            next['production'] = {};
            next['consumption'] = {};
            next['imports'] = {};
            next['exports'] = {};
            next['shortage'] = {};
            next['tradeIncome'] = 0;
            next['tradeExpense'] = 0;
            delete next['suppliers'];
            delete next['unfilledShortage'];
            delete next['emergencyImports'];
            delete next['importCost'];
            delete next['exportIncome'];
          }
        }
        // Finance: the new simple ledger (balance converts at the new scale).
        if (economy.finance !== undefined && typeof economy.finance === 'object') {
          for (const record of Object.values(economy.finance)) {
            if (record === null || typeof record !== 'object') continue;
            const oldBalance = (record as Record<string, unknown>)['lastBalance'];
            const next = record as Record<string, unknown>;
            for (const key of Object.keys(next)) delete next[key];
            next['lastTaxIncome'] = 0;
            next['lastTradeIncome'] = 0;
            next['lastFactoryIncome'] = 0;
            next['lastArmyExpense'] = 0;
            next['lastGovernmentExpense'] = 0;
            next['lastInfrastructureExpense'] = 0;
            next['lastBalance'] =
              typeof oldBalance === 'number' && Number.isFinite(oldBalance)
                ? Math.round(oldBalance * MONEY_SCALE)
                : 0;
          }
        }
        // Construction: building projects keep progress; waiting projects
        // refund their secured escrow into the stockpile and disappear.
        if (economy.construction !== undefined && typeof economy.construction === 'object') {
          for (const [countryId, record] of Object.entries(economy.construction)) {
            if (record === null || typeof record !== 'object') continue;
            const projects = Array.isArray(record['projects']) ? record['projects'] : [];
            const kept: unknown[] = [];
            for (const project of projects) {
              if (project === null || typeof project !== 'object') continue;
              const entry = project as Record<string, unknown>;
              const status = entry['status'];
              const progress = typeof entry['progress'] === 'number' ? entry['progress'] : 0;
              if (status === 'building') {
                kept.push({
                  id: entry['id'],
                  typeId: entry['typeId'],
                  cityId: entry['cityId'],
                  startedMonth: entry['startedMonth'],
                  progress
                });
              } else if (countryId !== '' && entry['secured'] !== null && typeof entry['secured'] === 'object') {
                const stock = economy.resources?.[countryId]?.['stock'] as Record<string, unknown> | undefined;
                if (stock !== undefined) {
                  for (const [resourceId, amount] of Object.entries(entry['secured'] as Record<string, unknown>)) {
                    const units = typeof amount === 'number' && Number.isFinite(amount) ? Math.max(0, Math.round(amount)) : 0;
                    stock[resourceId] = Math.max(0, Math.round((typeof stock[resourceId] === 'number' ? stock[resourceId] : 0) + units));
                  }
                }
              }
            }
            record['projects'] = kept;
          }
        }
        // Levels, research and legacy plants are gone (one source of truth
        // for production: deposits + baseline + the new buildings).
        delete economy['mines'];
        delete economy['research'];
        delete economy['plants'];
        if (economy['buildings'] === undefined) economy['buildings'] = {};
      }
      // FOUR tax levels → THREE (max → high; the others pass through).
      const countries = clone.state?.government?.countries;
      if (countries !== undefined && typeof countries === 'object') {
        for (const government of Object.values(countries)) {
          const tax = government?.budget?.tax;
          if (government?.budget !== undefined && tax === 'max') {
            (government.budget as { tax?: unknown })['tax'] = 'high';
          }
        }
      }
      return clone;
    }
  },
  {
    // v16 → v17: the WIDER simple economy (spec §1-§9). Per country:
    //  - buildings/projects anchor to GRID CELLS: the migration keeps the
    //    legacy `cityId` next to a provisional `cellKey: ""` so the session
    //    heal can resolve the real cell from the LIVE map (the save has no
    //    map), then strips the stale field;
    //  - finance: `lastFactoryIncome` is GONE (buildings produce goods —
    //    no building prints money any more);
    //  - `economyLevel` is added (the heal fills the neutral config start).
    from: 16,
    to: 17,
    migrate: (data) => {
      if (data === null || typeof data !== 'object') {
        throw new SaveError('Migration v16\u2192v17: save payload is not an object');
      }
      const clone = JSON.parse(JSON.stringify(data)) as {
        state?: {
          economy?: {
            economyLevel?: Record<string, number>;
            finance?: Record<string, Record<string, unknown>>;
            construction?: Record<string, { projects?: unknown[] }>;
            buildings?: Record<string, Record<string, unknown>>;
          };
        };
      };
      const economy = clone.state?.economy;
      if (economy !== undefined) {
        if (economy.economyLevel === undefined) economy.economyLevel = {};
        if (economy.finance !== undefined && typeof economy.finance === 'object') {
          for (const record of Object.values(economy.finance)) {
            if (record === null || typeof record !== 'object') continue;
            delete record['lastFactoryIncome'];
          }
        }
        if (economy.buildings !== undefined && typeof economy.buildings === 'object') {
          for (const buildings of Object.values(economy.buildings)) {
            if (buildings === null || typeof buildings !== 'object') continue;
            for (const building of Object.values(buildings as Record<string, Record<string, unknown>>)) {
              if (building === null || typeof building !== 'object') continue;
              if (typeof building['cellKey'] !== 'string') building['cellKey'] = '';
            }
          }
        }
        if (economy.construction !== undefined && typeof economy.construction === 'object') {
          for (const record of Object.values(economy.construction)) {
            if (record === null || typeof record !== 'object') continue;
            const projects = Array.isArray(record['projects']) ? record['projects'] : [];
            for (const project of projects) {
              if (project === null || typeof project !== 'object') continue;
              const entry = project as Record<string, unknown>;
              if (typeof entry['cellKey'] !== 'string') entry['cellKey'] = '';
            }
          }
        }
      }
      return clone;
    }
  },
  {
    // v17 → v18: the HARD economy (spec §1-§24). The new fields are purely
    // additive and the session heal fills anything missing:
    //  - every resource record gains `shortageMonths: {}` (spec §13's
    //    shortage-duration tracking);
    //  - the map slice gains `buildPreview: null` (spec §21's confirm flow);
    //  - extractive buildings keep producing with their full reserve until
    //    the heal sizes it from the LIVE map (no map in the save payload).
    from: 17,
    to: 18,
    migrate: (data) => {
      if (data === null || typeof data !== 'object') {
        throw new SaveError('Migration v17\u2192v18: save payload is not an object');
      }
      const clone = JSON.parse(JSON.stringify(data)) as {
        state?: {
          economy?: {
            resources?: Record<string, Record<string, unknown>>;
          };
          map?: Record<string, unknown>;
        };
      };
      const economy = clone.state?.economy;
      if (economy?.resources !== undefined && typeof economy.resources === 'object') {
        for (const record of Object.values(economy.resources)) {
          if (record === null || typeof record !== 'object') continue;
          if (record['shortageMonths'] === undefined) record['shortageMonths'] = {};
        }
      }
      const map = clone.state?.map;
      if (map !== undefined && typeof map === 'object' && map['buildPreview'] === undefined) {
        map['buildPreview'] = null;
      }
      return clone;
    }
  }
];

const migrations: SaveMigration[] = [...BUILT_IN_MIGRATIONS];

export function registerMigration(migration: SaveMigration): void {
  migrations.push(migration);
}

export function clearMigrationsForTests(): void {
  migrations.length = 0;
}

/**
 * Applies migrations from `fromVersion` up to `targetVersion`.
 * Pure function over the provided list — unit-testable without globals.
 */
export function applyMigrations(
  rawData: unknown,
  fromVersion: number,
  targetVersion: number,
  chain: readonly SaveMigration[] = migrations
): { data: unknown; version: number } {
  if (fromVersion > targetVersion) {
    throw new SaveError(
      `Save was created by a newer version (${fromVersion} > ${targetVersion}) and cannot be loaded`
    );
  }
  let version = fromVersion;
  let data = rawData;
  while (version < targetVersion) {
    const step = chain.find((candidate) => candidate.from === version);
    if (step === undefined) {
      throw new SaveError(`No migration path from save version ${version} to ${targetVersion}`);
    }
    data = step.migrate(data);
    version = step.to;
  }
  return { data, version };
}
