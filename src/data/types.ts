/**
 * Raw world description as loaded from JSON (src/data/worlds/*.json).
 * Referential integrity is validated when the initial state is built.
 */

export type FlagLayout = 'solid' | 'horizontal-stripes' | 'vertical-stripes' | 'canton';

export type FlagEmblem = 'none' | 'star' | 'circle' | 'crescent' | 'sun' | 'cross';

/**
 * Data-driven flag specification (Part 2). Deliberately small and abstract:
 * the UI renders it as a tiny generated SVG today and can swap in real
 * texture assets later without touching any caller.
 */
export interface FlagDataJson {
  readonly layout: FlagLayout;
  /** 1–4 stripe/field colors, first is the dominant field color. */
  readonly colors: readonly string[];
  readonly emblem: FlagEmblem;
  readonly emblemColor: string;
}

export type ResourceAmountJson = Readonly<Record<string, number>>;

/**
 * Static, data-driven country profile (Part 2) — the Country Data Foundation.
 * Lives in src/data/countries.json, validated by COUNTRY_PROFILES_SCHEMA and
 * joined with the generated map by id. ids must match the map generator's
 * stable ids (country_0 … country_N).
 */
export interface CountryProfileJson {
  readonly id: string;
  readonly name: string;
  readonly flag: FlagDataJson;
  readonly population: number;
  readonly economy: {
    readonly gdp: number;
    readonly treasury: number;
    readonly income: number;
    readonly expenses: number;
  };
  /** Extensible resource map: resource id → amount (new ids need no code change). */
  readonly resources: ResourceAmountJson;
  readonly military: {
    readonly manpower: number;
    readonly armySize: number;
    readonly equipment: number;
    readonly aircraft: number;
    readonly navy: number;
  };
  /**
   * Foreign relations seed, keyed by OTHER country id.
   * Scale is fixed: -100 = hostile, 0 = neutral, +100 = friendly.
   * The builder symmetrizes each pair (A→B implies B→A).
   */
  readonly foreignRelations: Readonly<Record<string, number>>;
}

export interface CountryDataJson {
  readonly id: string;
  readonly name: string;
}

export interface ProvinceDataJson {
  readonly id: string;
  readonly name: string;
  readonly countryId: string;
}

export interface CityDataJson {
  readonly id: string;
  readonly name: string;
  readonly provinceId: string;
  readonly population: number;
}

export interface RegionDataJson {
  readonly id: string;
  readonly name: string;
  readonly provinceId: string;
  readonly capitalCityId?: string;
  readonly gridX: number;
  readonly gridZ: number;
  readonly chunkCountX: number;
  readonly chunkCountZ: number;
  readonly infrastructure: number;
  readonly population: number;
  readonly neighbors: readonly string[];
}

export interface FactoryPlacementJson {
  readonly id: string;
  readonly typeId: string;
  readonly regionId: string;
}

export interface StartingUnitJson {
  readonly typeId: string;
  readonly countryId: string;
  readonly regionId: string;
}

export interface StartingCharacterJson {
  readonly id: string;
  readonly name: string;
  readonly role: 'leader' | 'commander' | 'soldier' | 'civilian';
  readonly countryId: string;
}

export interface RelationJson {
  readonly a: string;
  readonly b: string;
  readonly value: number;
}

export interface WorldDataJson {
  readonly id: string;
  readonly name: string;
  readonly countries: readonly CountryDataJson[];
  readonly provinces: readonly ProvinceDataJson[];
  readonly cities: readonly CityDataJson[];
  readonly regions: readonly RegionDataJson[];
  readonly factories: readonly FactoryPlacementJson[];
  readonly startingUnits: readonly StartingUnitJson[];
  readonly startingCharacters: readonly StartingCharacterJson[];
  readonly relations: readonly RelationJson[];
  readonly startingStockpiles: {
    readonly resources: Readonly<Record<string, number>>;
    readonly equipment: Readonly<Record<string, number>>;
  };
}

/**
 * Zoom-tier configuration for one label class (data-driven LOD).
 * `maxViewHeight` is the fully-visible threshold: labels fade in as the view
 * height drops below it and are invisible at or above it (null = always).
 * Fading spans `fadeSpanViewHeight` so labels never pop.
 */
export interface MapLabelTierData {
  /** Visible below this view height; null = visible at every zoom. */
  readonly maxViewHeight: number | null;
  /** City labels additionally require at least this population. */
  readonly minPopulation: number;
  /** Higher priority wins label collision + the visibility cap. */
  readonly priority: number;
  /** Label height in screen pixels (screen-constant size). */
  readonly screenPx: number;
}

export interface MapLabelsThemeData {
  /** View-height span over which a label fades in/out (no popping). */
  readonly fadeSpanViewHeight: number;
  /** Alpha easing speed (per second). */
  readonly fadeRatePerSecond: number;
  /** Hard cap on simultaneously rendered labels (scalability guard). */
  readonly maxVisible: number;
  /** Extra padding (px) added around labels for collision tests. */
  readonly collisionPaddingPx: number;
  /** Vertical offset (px) between a city marker and its label. */
  readonly labelOffsetPx: number;
  readonly tiers: Readonly<Record<'country' | 'province' | 'capital' | 'majorCity' | 'city', MapLabelTierData>>;
}

/** Data-driven colors for the Part-3 information layers (see mapTheme.json). */
export interface MapLayerColorsData {
  readonly biomeFillOpacity: number;
  readonly biomes: Readonly<Record<'forest' | 'grassland' | 'desert' | 'tundra' | 'drylands' | 'jungle', string>>;
  readonly terrainFillOpacity: number;
  readonly terrain: Readonly<Record<'mountain' | 'hills' | 'plains' | 'valley', string>>;
  readonly tintFillOpacity: number;
  readonly populationLow: string;
  readonly populationHigh: string;
  readonly economyLow: string;
  readonly economyHigh: string;
  readonly riverStroke: string;
  readonly riverOpacity: number;
  readonly lakeFill: string;
  readonly lakeOpacity: number;
  readonly roadColors: Readonly<Record<'highway' | 'secondary' | 'dirt', string>>;
  readonly roadOpacity: number;
  readonly railwayStroke: string;
  readonly railwayOpacity: number;
  readonly seaRouteStroke: string;
  readonly seaRouteOpacity: number;
  readonly siteColors: Readonly<
    Record<'port' | 'farm' | 'factory' | 'mine' | 'oil' | 'airbase' | 'base', string>
  >;
  readonly siteOpacity: number;
}

/**
 * Visual theme of the strategic political map (colors + marker sizes).
 * Data-driven: lives in src/data/mapTheme.json, validated by MAP_THEME_SCHEMA.
 */
export interface MapThemeData {
  readonly oceanColor: string;
  readonly oceanTone: string;
  readonly landColor: string;
  readonly countryPalette: readonly string[];
  readonly selectedTint: string;
  readonly selectedOpacity: number;
  readonly provinceFill: string;
  readonly provinceFillOpacity: number;
  readonly coastStroke: string;
  readonly countryBorderStroke: string;
  readonly provinceBorderStroke: string;
  readonly provinceBorderOpacity: number;
  /** City-district boundary line (subtle — must not read as a country border). */
  readonly cityAreaStroke: string;
  readonly cityAreaOpacity: number;
  readonly cityFill: string;
  readonly cityStroke: string;
  readonly capitalFill: string;
  readonly capitalStroke: string;
  readonly cityRadius: number;
  readonly capitalRadius: number;
  readonly cityHitRadius: number;
  readonly labelColor: string;
  readonly labelHaloColor: string;
  readonly labels: MapLabelsThemeData;
  readonly selectionRingColor: string;
  readonly selectionRingColorAlt: string;
  /** Player-country outline color (Part 3 selection flow). */
  readonly playerOutlineColor: string;
  /** Information-layer colors (Part 3 map layers). */
  readonly layerColors: MapLayerColorsData;
}
