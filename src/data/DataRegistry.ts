import { DataValidationError } from '../utils/errors';
import type { Logger } from '../utils/Logger';
import { validateOrThrow } from '../utils/validation';
import type { FieldSchema } from '../utils/validation';
import { EQUIPMENT_SCHEMA, ECONOMY_SCHEMA, INPUT_BINDINGS_SCHEMA, PLAYER_MODE_SCHEMA, UNIT_TYPE_SCHEMA, AI_STRATEGY_SCHEMA, WORLD_SCHEMA, MAP_THEME_SCHEMA, COUNTRY_PROFILE_SCHEMA } from './schemas';
import type { WorldDataJson, CountryProfileJson } from './types';
import type { UnitTypeDef, EquipmentDef } from '../military/types';
import type { FactoryTypeDef, ResourceDef } from '../economy/types';
import type { AIStrategyDef } from '../ai/types';
import type { PlayerModeDef } from '../player/types';
import type { InputBindings } from '../input/InputTypes';
import type { MapThemeData } from './types';
import unitsJson from './units.json';
import equipmentJson from './equipment.json';
import economyJson from './economy.json';
import strategiesJson from './strategies.json';
import playerModesJson from './playerModes.json';
import inputBindingsJson from './inputBindings.json';
import mapThemeJson from './mapTheme.json';
import countriesJson from './countries.json';
import demoWorldJson from './worlds/demo-country.json';

export interface EconomyDataBundle {
  readonly resources: readonly ResourceDef[];
  readonly factoryTypes: readonly FactoryTypeDef[];
  readonly startingStockpiles: {
    readonly resources: Readonly<Record<string, number>>;
    readonly equipment: Readonly<Record<string, number>>;
  };
}

/**
 * Central registry of all static, data-driven game content.
 *
 * Content lives in JSON (units, weapons, strategies, player modes, worlds...)
 * — never hard-coded inside systems. Every file is schema-validated here and
 * cross-checked (unit equipment references, factory type references, mode
 * transitions) so invalid data fails fast at boot.
 */
export class DataRegistry {
  private readonly unitTypes: Readonly<Record<string, UnitTypeDef>>;
  private readonly equipmentDefs: Readonly<Record<string, EquipmentDef>>;
  private readonly economy: EconomyDataBundle;
  private readonly strategies: readonly AIStrategyDef[];
  private readonly playerModes: readonly PlayerModeDef[];
  private readonly bindings: InputBindings;
  private readonly theme: MapThemeData;
  private readonly countryProfiles: readonly CountryProfileJson[];
  private readonly worlds: Readonly<Record<string, WorldDataJson>>;

  constructor(private readonly logger?: Logger) {
    this.unitTypes = unitsJson as unknown as Record<string, UnitTypeDef>;
    this.equipmentDefs = equipmentJson as unknown as Record<string, EquipmentDef>;
    this.economy = economyJson as unknown as EconomyDataBundle;
    this.strategies = Object.values(strategiesJson) as unknown as AIStrategyDef[];
    this.playerModes = Object.values(playerModesJson) as unknown as PlayerModeDef[];
    this.bindings = inputBindingsJson as unknown as InputBindings;
    this.theme = mapThemeJson as unknown as MapThemeData;
    this.countryProfiles = countriesJson as unknown as readonly CountryProfileJson[];
    this.worlds = { 'demo-country': demoWorldJson as unknown as WorldDataJson };

    this.validateAll();
    this.logger?.debug(
      `DataRegistry loaded: ${Object.keys(this.unitTypes).length} unit types, ` +
        `${Object.keys(this.equipmentDefs).length} equipment defs, ` +
        `${this.strategies.length} strategies, ${Object.keys(this.worlds).length} worlds`
    );
  }

  private validateAll(): void {
    const issues: string[] = [];
    const check = (fn: () => void, label: string): void => {
      try {
        fn();
      } catch (error) {
        issues.push(error instanceof Error ? `${label}: ${error.message}` : String(label));
      }
    };

    check(() => validateOrThrow(this.unitTypes, recordSchema(UNIT_TYPE_SCHEMA), 'units'), 'units');
    check(() => validateOrThrow(this.equipmentDefs, recordSchema(EQUIPMENT_SCHEMA), 'equipment'), 'equipment');
    check(() => validateOrThrow(this.economy, ECONOMY_SCHEMA, 'economy'), 'economy');
    check(
      () => validateOrThrow(this.strategies, { type: 'array', items: AI_STRATEGY_SCHEMA }, 'strategies'),
      'strategies'
    );
    check(
      () => validateOrThrow(this.playerModes, { type: 'array', items: PLAYER_MODE_SCHEMA }, 'playerModes'),
      'playerModes'
    );
    check(() => validateOrThrow(this.bindings, INPUT_BINDINGS_SCHEMA, 'inputBindings'), 'inputBindings');
    check(() => validateOrThrow(this.theme, MAP_THEME_SCHEMA, 'mapTheme'), 'mapTheme');
    check(
      () => validateOrThrow(this.countryProfiles, { type: 'array', minLength: 1, items: COUNTRY_PROFILE_SCHEMA }, 'countries'),
      'countries'
    );
    for (const [worldId, world] of Object.entries(this.worlds)) {
      check(() => validateOrThrow(world, WORLD_SCHEMA, `worlds.${worldId}`), `worlds.${worldId}`);
    }

    // Cross-file referential checks (shape-independent).
    for (const [unitId, unit] of Object.entries(this.unitTypes)) {
      for (const equipmentId of Object.keys(unit.equipment)) {
        if (this.equipmentDefs[equipmentId] === undefined) {
          issues.push(`units.${unitId}: unknown equipment "${equipmentId}"`);
        }
      }
    }
    const resourceIds = new Set(this.economy.resources.map((resource) => resource.id));
    for (const factoryType of this.economy.factoryTypes) {
      for (const id of [...Object.keys(factoryType.inputs), ...Object.keys(factoryType.outputs)]) {
        if (!resourceIds.has(id)) {
          issues.push(`economy.factoryTypes.${factoryType.id}: unknown resource "${id}"`);
        }
      }
    }
    for (const strategy of this.strategies) {
      for (const condition of strategy.conditions) {
        if (!KNOWN_METRICS.has(condition.metric)) {
          issues.push(`strategies.${strategy.id}: unknown metric "${condition.metric}"`);
        }
      }
    }
    for (const mode of this.playerModes) {
      for (const transition of mode.transitions) {
        if (!this.playerModes.some((m) => m.id === transition)) {
          issues.push(`playerModes.${mode.id}: unknown transition target "${transition}"`);
        }
      }
    }

    // Country profiles: unique ids + relations must reference existing ids.
    const profileIds = new Set(this.countryProfiles.map((profile) => profile.id));
    if (profileIds.size !== this.countryProfiles.length) {
      issues.push('countries: duplicate country ids');
    }
    for (const profile of this.countryProfiles) {
      for (const [otherId, value] of Object.entries(profile.foreignRelations)) {
        if (otherId === profile.id) {
          issues.push(`countries.${profile.id}: relation to itself`);
        } else if (!profileIds.has(otherId)) {
          issues.push(`countries.${profile.id}: relation references unknown country "${otherId}"`);
        }
        if (value < -100 || value > 100) {
          issues.push(`countries.${profile.id}: relation to "${otherId}" outside [-100, +100]`);
        }
      }
    }

    if (issues.length > 0) {
      throw new DataValidationError(`Static game data invalid (${issues.length} issue(s)): ${issues.join('; ')}`);
    }
  }

  unitType(id: string): UnitTypeDef {
    const def = this.unitTypes[id];
    if (def === undefined) throw new DataValidationError(`Unknown unit type "${id}"`);
    return def;
  }

  get unitTypeList(): readonly UnitTypeDef[] {
    return Object.values(this.unitTypes);
  }

  equipment(id: string): EquipmentDef {
    const def = this.equipmentDefs[id];
    if (def === undefined) throw new DataValidationError(`Unknown equipment "${id}"`);
    return def;
  }

  get equipmentList(): readonly EquipmentDef[] {
    return Object.values(this.equipmentDefs);
  }

  get economyData(): EconomyDataBundle {
    return this.economy;
  }

  get strategyList(): readonly AIStrategyDef[] {
    return this.strategies;
  }

  get playerModeList(): readonly PlayerModeDef[] {
    return this.playerModes;
  }

  get inputBindings(): InputBindings {
    return this.bindings;
  }

  /** Visual theme of the strategic map (colors, sizes — data-driven). */
  get mapTheme(): MapThemeData {
    return this.theme;
  }

  /** Static country profiles (Part 2), keyed implicitly by `id`. */
  get countryProfileList(): readonly CountryProfileJson[] {
    return this.countryProfiles;
  }

  countryProfile(id: string): CountryProfileJson {
    const profile = this.countryProfiles.find((candidate) => candidate.id === id);
    if (profile === undefined) throw new DataValidationError(`Unknown country profile "${id}"`);
    return profile;
  }

  world(id: string): WorldDataJson {
    const world = this.worlds[id];
    if (world === undefined) throw new DataValidationError(`Unknown world "${id}"`);
    return world;
  }

  get worldIds(): readonly string[] {
    return Object.keys(this.worlds);
  }
}

function recordSchema(values: FieldSchema): FieldSchema {
  return { type: 'record', values };
}

/**
 * Metrics the AI condition evaluator may reference. Registering the metric
 * vocabulary here keeps strategy JSON honest: unknown metrics fail at load,
 * not mid-campaign.
 */
export const KNOWN_METRICS: ReadonlySet<string> = new Set([
  'strength_ratio',
  'supply_ratio',
  'mobility_ratio',
  'industrial_ratio',
  'air_superiority',
  'reserve_ratio',
  'under_threat'
]);
