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

export interface MapProvince {
  readonly id: ProvinceId;
  readonly name: string;
  readonly countryId: CountryId;
  readonly ring: MapRing;
  readonly cellIds: readonly number[];
  readonly cityIds: readonly CityId[];
  readonly labelPoint: MapPoint;
}

export interface MapCity {
  readonly id: CityId;
  readonly name: string;
  readonly countryId: CountryId;
  readonly provinceId: ProvinceId;
  readonly position: MapPoint;
  readonly isCapital: boolean;
  /** Light display-only value (no economy system in Part 1). */
  readonly population: number;
  /**
   * District boundary — a closed ring built from the SAME shared lattice
   * geometry (province cells partitioned among their cities). A future real
   * city polygon can replace it without touching renderer or state: this
   * ring IS the renderer-facing contract.
   */
  readonly areaRing: MapRing;
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

/** Terrain class per cell derived from elevation quantiles. */
export type TerrainId = 'mountain' | 'hills' | 'plains' | 'valley';

/** A river: seeded at a high cell, descending to a coast or an inland basin. */
export interface MapRiver {
  readonly id: string;
  readonly name: string;
  /** Cell indices from source to mouth (source first). */
  readonly cells: readonly number[];
  /** World-space polyline (jittered cell centroids), ≥ 2 points. */
  readonly polyline: readonly MapPoint[];
  /** Mouth cell when the river reached the ocean; null when it ended inland. */
  readonly mouthCell: number | null;
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
  | 'airbase'
  | 'base';

export interface MapSite {
  readonly id: string;
  readonly kind: MapSiteKind;
  /** Resource id for extractive sites (iron/coal/gold/oil), else null. */
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
  readonly rivers: readonly MapRiver[];
  /** Inland basin cells where rivers ended (drawn as small lakes). */
  readonly lakeCells: readonly number[];
  readonly lines: readonly MapLineFeature[];
  readonly sites: readonly MapSite[];
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
