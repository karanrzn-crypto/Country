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
  readonly stats: MapStats;
}
