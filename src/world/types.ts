/**
 * World / geography type primitives. Leaf module — imported by state slices,
 * event types and managers; must not import game logic.
 */

export type CountryId = string;
export type ProvinceId = string;
export type CityId = string;
export type RegionId = string;
export type ChunkId = string;

/**
 * Chunk streaming states:
 * - 'unloaded'  — not in memory, no simulation, no rendering.
 * - 'simulated' — lightweight/abstract simulation only, no 3D representation.
 * - 'active'    — full detail simulation + 3D representation.
 */
export type ChunkState = 'unloaded' | 'simulated' | 'active';

/** Rendering detail level for active chunks (0 = nearest / most detailed). */
export type LODLevel = 0 | 1 | 2;

export type WeatherType = 'clear' | 'cloudy' | 'rain' | 'storm';
