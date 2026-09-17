/**
 * Strategic political-map domain types (Part 1).
 *
 * THE core geometric contract of the whole map:
 *
 *   lattice points (shared, jittered)
 *     → cells (quads referencing 4 lattice points)
 *     → cell partitions (provinces ⊂ countries)
 *     → shared edge registry (ONE polyline per boundary edge)
 *     → country / province rings (ordered references to shared edges)
 *
 * Because every border is stored exactly once as a shared edge polyline,
 * neighboring countries can never drift apart: no gaps, no overlaps, no
 * double-drawn borders and zoom-stable coordinates — by construction, not by
 * careful drawing.
 *
 * This module is a LEAF: it must never import game logic or Three.js.
 */

import type { CountryId, ProvinceId, CityId } from '../types';

export interface MapPoint {
  readonly x: number;
  readonly z: number;
}

export interface MapBounds {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

/** Canonical undirected edge id: "minLatticeIndex|maxLatticeIndex". */
export type EdgeKey = string;

/** Border classification derived from the two cells sharing an edge. */
export type EdgeKind =
  | 'coast' // land on one side, ocean on the other
  | 'country' // land on both sides, different countries
  | 'province' // same country, different provinces
  | 'interior'; // same province (city-district rings may reference it)

/**
 * A shared boundary edge. `polyline` is the SINGLE source of geometry for
 * this border stretch: every ring that references it concatenates this exact
 * polyline (reversed when traversed against canonical direction), so both
 * neighbors render the identical line.
 */
export interface MapEdge {
  readonly key: EdgeKey;
  /** Canonical endpoint order: a < b (lattice indices). */
  readonly a: number;
  readonly b: number;
  readonly kind: EdgeKind;
  /** Subdivided natural border, first point == lattice[a], last == lattice[b]. */
  readonly polyline: readonly MapPoint[];
}

/** One directed traversal of a shared edge while walking a ring boundary. */
export interface RingSegment {
  readonly key: EdgeKey;
  /** true → traverse polyline a→b; false → traverse b→a. */
  readonly forward: boolean;
}

/** A closed boundary ring: ordered shared-edge traversals + flattened points. */
export interface MapRing {
  readonly segments: readonly RingSegment[];
  /**
   * Flattened outline points (implicit closure — the last point is NOT a
   * copy of the first). Built purely from the shared edge polylines.
   */
  readonly points: readonly MapPoint[];
}

export interface MapCountry {
  readonly id: CountryId;
  readonly name: string;
  /** Outer boundary (single 4-connected region → single ring). */
  readonly ring: MapRing;
  /** Member cell indices (the partition ground truth). */
  readonly cellIds: readonly number[];
  readonly provinceIds: readonly ProvinceId[];
  readonly cityIds: readonly CityId[];
  readonly capitalCityId: CityId;
  /** Structurally derived from shared 'country' edges — never hand-maintained. */
  readonly neighborIds: readonly CountryId[];
  /** True when at least one border edge is a coast. */
  readonly coastal: boolean;
  /** Stable palette index (rendering only). */
  readonly colorIndex: number;
  /** Interior anchor point for the label (deep inside the ring). */
  readonly labelPoint: MapPoint;
}

export interface CityInfrastructure {
  /** Road line ids (features.lines) touching this city. */
  readonly roadIds: readonly string[];
  /** Railway line ids ending at this city. */
  readonly railwayIds: readonly string[];
  /** Airport building id when the city has one. */
  readonly airportId: string | null;
  /** Port building id when the city has one. */
  readonly portId: string | null;
  readonly hasHospital: boolean;
  readonly hasPower: boolean;
  /** Military site ids (features.sites) hosted by the city. */
  readonly militarySiteIds: readonly string[];
}

export interface ProvinceInfrastructure {
  /** Road lines with at least one endpoint city in the province. */
  readonly roads: number;
  readonly railways: number;
  readonly airports: number;
  readonly ports: number;
  /** Power / utility buildings. */
  readonly utilities: number;
}

export interface MapProvince {
  readonly id: ProvinceId;
  readonly name: string;
  readonly countryId: CountryId;
  readonly ring: MapRing;
  readonly cellIds: readonly number[];
  readonly cityIds: readonly CityId[];
  readonly labelPoint: MapPoint;
  // ——— Part 3 — structured geography ———
  /** Provincial capital: the most important city of the province. */
  readonly capitalCityId: CityId | null;
  /** EXACTLY the sum of member city populations (Part 3 invariant). */
  readonly population: number;
  /** Member cell count (the partition ground truth — area in cells). */
  readonly areaCells: number;
  /** Area in world units² (cells × cellSize²). */
  readonly area: number;
  /** Dominant terrain class of the member cells. */
  readonly terrainType: TerrainId;
  /** Resource ids present at located deposits inside the province. */
  readonly resourceIds: readonly string[];
  /** Building ids (features.buildings) inside the province. */
  readonly buildingIds: readonly string[];
  /** Structurally derived from cell adjacency across province borders. */
  readonly neighborProvinceIds: readonly ProvinceId[];
  readonly infrastructure: ProvinceInfrastructure;
  /** 0..1 — derived from infrastructure, urbanization and resources. */
  readonly developmentLevel: number;
  /** 0..1 — initial control (1 = fully controlled; future systems mutate a
   *  runtime copy, the model keeps the START condition). */
  readonly control: number;
  /** 0..1 — initial security level (same policy as control). */
  readonly security: number;
  /** Deterministic production-capacity estimate (population × industry). */
  readonly productionCapacity: number;
  /** 0..100 — see computeStrategicValue (MapGeography). */
  readonly strategicValue: number;
  /** Grid ids ("A3"-style, country-local) of the member cells. */
  readonly gridIds: readonly string[];
}

/** City classification driving label tiers, markers and future systems. */
export type CityType = 'capital' | 'major' | 'medium' | 'small' | 'settlement';

export interface MapCity {
  readonly id: CityId;
  readonly name: string;
  readonly countryId: CountryId;
  readonly provinceId: ProvinceId;
  readonly position: MapPoint;
  readonly isCapital: boolean;
  /**
   * City population. Part 3: assigned by the population tree — the sum over
   * a province's cities equals the province population exactly, and the sum
   * over a country's provinces equals the declared country population.
   */
  readonly population: number;
  /**
   * District boundary — a closed ring built from the SAME shared lattice
   * geometry (province cells partitioned among their cities). A future real
   * city polygon can replace it without touching renderer or state: this
   * ring IS the renderer-facing contract.
   */
  readonly areaRing: MapRing;
  // ——— Part 3 — structured geography ———
  /** Country-local grid id of the host cell (e.g. "A3"). */
  readonly gridId: string;
  readonly type: CityType;
  /** 0..1 importance (capital/port/airport/population blend). */
  readonly importance: number;
  /** Building ids (features.buildings) inside the city. */
  readonly buildingIds: readonly string[];
  /** Resource ids reachable from the city (host cell + direct neighbors). */
  readonly resourceIds: readonly string[];
  /** Industrial building ids — the city's industries. */
  readonly industries: readonly string[];
  readonly infrastructure: CityInfrastructure;
  /** 0..100 — see computeStrategicValue (MapGeography). */
  readonly strategicValue: number;
  /** River ids within the riverside band of the city. */
  readonly riverIds: readonly string[];
  /** True when the city deliberately sits in the riverside band. */
  readonly isRiverine: boolean;
}

// ———————————————————— geographic features (Part 3 layers) ————————————————————

/** Land biome classification per cell (data-driven display via theme). */
export type BiomeId =
  | 'ocean'
  | 'forest'
  | 'grassland'
  | 'desert'
  | 'tundra'
  | 'drylands'
  | 'jungle';

/**
 * Terrain class per cell — a data-driven description of the land's SHAPE
 * (elevation band + local ruggedness), independent from the biome layer so
 * the two can be toggled and combined freely (mountain+forest, plains+
 * grassland, lowland+wetland …). `plateau` marks elevated-but-flat ground;
 * `highMountain` the distinct highest, snow-prone band.
 */
export type TerrainId =
  | 'lowland'
  | 'valley'
  | 'plains'
  | 'plateau'
  | 'hills'
  | 'mountain'
  | 'highMountain';

/**
 * A river in the Part-3 water network: ONE continuous path from a source to
 * a mouth, descending monotonically (flow direction is consistent with the
 * elevation field by construction). Tributaries join a parent river at the
 * parent's own polyline point — confluences are geometrically continuous.
 */
export interface MapRiver {
  readonly id: string;
  readonly name: string;
  /** Cell indices from source to mouth (source first), 4-adjacent chain. */
  readonly cells: readonly number[];
  /** World-space polyline (jittered cell centroids), ≥ 2 points, continuous:
   *  a tributary's last point IS the parent's point at the confluence cell. */
  readonly polyline: readonly MapPoint[];
  readonly sourceCell: number;
  /** Last cell of the path for 'ocean'/'lake' mouths; the confluence cell
   *  (on the PARENT's path) for 'river' mouths; null for truncated paths. */
  readonly mouthCell: number | null;
  readonly mouthType: 'ocean' | 'lake' | 'river';
  /** Parent river when this is a tributary (mouthType 'river'). */
  readonly parentRiverId: string | null;
  /** Tributaries joining THIS river (filled after the network is built). */
  readonly tributaryIds: readonly string[];
  /** Elevation (normalized 0..1) per polyline point — non-increasing. */
  readonly elevations: readonly number[];
  /** Path length in world units. */
  readonly length: number;
  /** Provinces the path passes through (filled by MapGeography). */
  readonly provinceIds: readonly ProvinceId[];
  /** Cities within the riverside band (filled by MapGeography). */
  readonly cityIds: readonly CityId[];
  /** Long, wide rivers are navigable (data field for future transport). */
  readonly navigable: boolean;
  /** 0..1 — length/flow based geographic-economic importance. */
  readonly importance: number;
}

/** A real inland water body: a depression (basin) holding standing water. */
export interface MapLake {
  readonly id: string;
  readonly name: string;
  /** Member cell indices (all land-mask cells — lakes sit ON land). */
  readonly cells: readonly number[];
  /** Centroid of the member cells (label / query anchor). */
  readonly position: MapPoint;
  readonly areaCells: number;
  /** 0..1 approximate depth (elevation-derived, deterministic). */
  readonly depth: number;
  /** Rivers ending inside the lake. */
  readonly inflowRiverIds: readonly string[];
  /** Rivers whose source is a lake cell (outflow). */
  readonly outflowRiverIds: readonly string[];
  /** Adjacent provinces (filled by MapGeography). */
  readonly provinceIds: readonly ProvinceId[];
  /** Lakeside cities ON LAND at the margin (never inside the surface). */
  readonly cityIds: readonly CityId[];
  /** 0..1 geographic importance (area-based). */
  readonly importance: number;
}

/** Buildings / facilities — DATA MODEL ONLY in Part 3 (no construction sim). */
export type BuildingKind =
  | 'residential'
  | 'industrial'
  | 'commercial'
  | 'government'
  | 'hospital'
  | 'militaryBase'
  | 'airport'
  | 'port'
  | 'railwayStation'
  | 'power';

export interface MapBuilding {
  readonly id: string;
  readonly kind: BuildingKind;
  readonly countryId: CountryId;
  readonly provinceId: ProvinceId;
  /** Host city when the building is urban; null for rural facilities. */
  readonly cityId: CityId | null;
  readonly position: MapPoint;
  /** 1..5 facility level (deterministic start values). */
  readonly level: number;
}

/** A located natural-resource deposit (never a location-less number). */
export interface MapResourceDeposit {
  readonly id: string;
  readonly resourceId: string;
  readonly countryId: CountryId;
  readonly provinceId: ProvinceId;
  readonly cellIndex: number;
  readonly position: MapPoint;
  /** Extractive/production site (features.sites) working the deposit. */
  readonly siteId: string | null;
  /** Deterministic 1..100 abundance. */
  readonly quantity: number;
}

/**
 * A transport / maritime line feature. Polyline is generated data (seeded),
 * NOT hand-tuned geometry — a future real-network dataset can replace the
 * generator without touching renderer or state (same contract as city rings).
 */
export type MapLineKind = 'highway' | 'secondary' | 'dirt' | 'railway' | 'seaRoute';

export interface MapLineFeature {
  readonly id: string;
  readonly kind: MapLineKind;
  /** City ids when the line links two settlements (null for future data). */
  readonly cityA: CityId | null;
  readonly cityB: CityId | null;
  readonly polyline: readonly MapPoint[];
}

/**
 * A point site on the map (production / resource / military / port).
 * Positions are validated interior points of their country ring.
 */
export type MapSiteKind =
  | 'port'
  | 'farm'
  | 'factory'
  | 'mine'
  | 'oil'
  | 'lumber'
  | 'airbase'
  | 'base';

export interface MapSite {
  readonly id: string;
  readonly kind: MapSiteKind;
  /** Resource id for extractive/production sites (iron/coal/copper/gold/oil/wood), else null. */
  readonly resourceId: string | null;
  readonly countryId: CountryId;
  readonly cityId: CityId | null;
  readonly cellIndex: number;
  readonly position: MapPoint;
}

/**
 * Static geographic features of the map — generated ONCE per seed together
 * with the political layer, deterministic and JSON-safe. This is the single
 * source of truth for every information layer (biomes, terrain, rivers,
 * roads, sites, …): renderer, future simulations and tests all read here.
 */
export interface MapFeatures {
  /** Per-cell biome (index = cz * columns + cx, 'ocean' for water cells). */
  readonly biomes: readonly BiomeId[];
  /** Per-cell normalized elevation 0..1 (ocean cells included). */
  readonly elevation: readonly number[];
  /** Per-cell normalized temperature 0..1 (weather-layer hook). */
  readonly temperature: readonly number[];
  /** Per-cell normalized moisture 0..1 (future precipitation / vegetation
   *  hook — the SAME field classifyBiome consumed, now persisted so future
   *  systems never need to re-derive it). */
  readonly moisture: readonly number[];
  /** Per-cell terrain class ('valley' is used for ocean cells too). */
  readonly terrain: readonly TerrainId[];
  /** Per-cell country owner index (−1 for ocean) — the ground truth for
   *  country-tinted overlays (economy/population) and future systems. */
  readonly cellOwner: readonly number[];
  /** Per-cell province id (null for ocean) — province overlays, grid and
   *  strategic-value tinting read here (single geometric truth). */
  readonly provinceOf: readonly (ProvinceId | null)[];
  /** Per-cell country-local grid id ("A3"-style) — null for ocean cells. */
  readonly gridIds: readonly (string | null)[];
  readonly rivers: readonly MapRiver[];
  /** Real inland water bodies (depression basins) — see MapLake. */
  readonly lakes: readonly MapLake[];
  readonly lines: readonly MapLineFeature[];
  readonly sites: readonly MapSite[];
  /** Located resource deposits (Part 3 — never location-less numbers). */
  readonly deposits: readonly MapResourceDeposit[];
  /** Buildings / facilities (Part 3 — data model + geography only). */
  readonly buildings: readonly MapBuilding[];
}

/**
 * Canonical internal id of a grid cell: `countryId + gridId`. The SAME grid
 * id ("A3") can exist in many countries without conflict — the country id
 * namespaces it. Pure function (data format contract).
 */
export function gridCellKey(countryId: CountryId, gridId: string): string {
  return `${countryId}#${gridId}`;
}

/** Splits a canonical grid-cell key back into its parts (tests / UI). */
export function splitGridCellKey(key: string): { countryId: CountryId; gridId: string } {
  const separator = key.indexOf('#');
  if (separator <= 0) throw new Error(`Malformed grid cell key "${key}"`);
  return { countryId: key.slice(0, separator) as CountryId, gridId: key.slice(separator + 1) };
}

/** Column letters of the geographic grid: A, B, …, Z, AA, AB, … */
export function gridColumnLetter(column: number): string {
  let n = column;
  let letters = '';
  do {
    letters = String.fromCharCode(65 + (n % 26)) + letters;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return letters;
}

export interface MapStats {
  readonly countries: number;
  readonly provinces: number;
  readonly cities: number;
  readonly capitals: number;
  readonly coastalCountries: number;
  readonly landlockedCountries: number;
  readonly landCells: number;
  readonly peninsulaCells: number;
  readonly bayCells: number;
  /** Total number of shared (non-interior) boundary edges. */
  readonly boundaryEdges: number;
}

/**
 * The complete static political map. Immutable after generation; pure data
 * (JSON-safe) so it can be hashed for determinism checks. Lives OUTSIDE
 * GameState (like config/static data): geography is fixed for a seed, only
 * selection/camera/layer state is dynamic (see state/slices/mapSlice).
 */
export interface StrategicMapModel {
  readonly seed: number;
  readonly continentName: string;
  readonly bounds: MapBounds;
  readonly countries: Readonly<Record<CountryId, MapCountry>>;
  readonly provinces: Readonly<Record<ProvinceId, MapProvince>>;
  readonly cities: Readonly<Record<CityId, MapCity>>;
  /** Stable insertion order (palette assignment, UI lists, hashing). */
  readonly countryOrder: readonly CountryId[];
  /** All shared boundary edges (coast/country/province AND interior — the
   *  interior ones are referenced by city-district rings) keyed by EdgeKey. */
  readonly edges: Readonly<Record<EdgeKey, MapEdge>>;
  /** Jittered lattice points by index (geometry provenance / tests). */
  readonly lattice: readonly MapPoint[];
  /** Static geographic features (biomes/terrain/rivers/roads/sites) — see MapFeatures. */
  readonly features: MapFeatures;
  readonly stats: MapStats;
}
