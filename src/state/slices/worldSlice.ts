/**
 * World state slice — static geography: Country → Province → City → Region →
 * Chunk hierarchy plus derived indexes. Immutable after creation; dynamic
 * values (population, supply) live in their own slices.
 */

import type { CountryId, ProvinceId, CityId, RegionId, ChunkId } from '../../world/types';
import type { WorldDataJson } from '../../data/types';
import { StateError } from '../../utils/errors';

export interface CountryRecord {
  readonly id: CountryId;
  readonly name: string;
}

export interface ProvinceRecord {
  readonly id: ProvinceId;
  readonly name: string;
  readonly countryId: CountryId;
}

export interface CityRecord {
  readonly id: CityId;
  readonly name: string;
  readonly provinceId: ProvinceId;
  readonly population: number;
}

export interface RegionRecord {
  readonly id: RegionId;
  readonly name: string;
  readonly provinceId: ProvinceId;
  readonly capitalCityId: CityId | null;
  readonly gridX: number;
  readonly gridZ: number;
  readonly infrastructure: number;
  readonly basePopulation: number;
  readonly neighbors: readonly RegionId[];
  readonly chunkIds: readonly ChunkId[];
}

export interface ChunkRecord {
  readonly id: ChunkId;
  readonly regionId: RegionId;
  readonly gx: number;
  readonly gz: number;
}

export interface WorldSlice {
  readonly worldId: string;
  readonly name: string;
  readonly countries: Readonly<Record<CountryId, CountryRecord>>;
  readonly provinces: Readonly<Record<ProvinceId, ProvinceRecord>>;
  readonly cities: Readonly<Record<CityId, CityRecord>>;
  readonly regions: Readonly<Record<RegionId, RegionRecord>>;
  readonly chunks: Readonly<Record<ChunkId, ChunkRecord>>;
  /** Derived: region → owning country (via province). */
  readonly countryOfRegion: Readonly<Record<RegionId, CountryId>>;
  /** Grid stride between regions so chunk grid coordinates never overlap. */
  readonly regionGridStride: number;
}

/**
 * Grid stride between regions is computed per world as the largest region
 * chunk-count, so chunk grid coordinates never overlap between regions and
 * neighboring regions sit directly next to each other for streaming.
 */
export function computeRegionGridStride(data: WorldDataJson): number {
  let stride = 1;
  for (const region of data.regions) {
    stride = Math.max(stride, region.chunkCountX, region.chunkCountZ);
  }
  return stride;
}

export function chunkIdFor(regionId: string, cx: number, cz: number): ChunkId {
  return `${regionId}.c${cx}x${cz}`;
}

/** Builds the immutable world slice from validated world JSON. */
export function buildWorldSlice(data: WorldDataJson): WorldSlice {
  const issues: string[] = [];
  const provinces: Record<ProvinceId, ProvinceRecord> = {};
  const cities: Record<CityId, CityRecord> = {};
  const regions: Record<RegionId, RegionRecord> = {};
  const chunks: Record<ChunkId, ChunkRecord> = {};
  const stride = computeRegionGridStride(data);

  for (const province of data.provinces) {
    if (data.countries.find((c) => c.id === province.countryId) === undefined) {
      issues.push(`province "${province.id}" references unknown country "${province.countryId}"`);
    }
    provinces[province.id] = { ...province };
  }
  for (const city of data.cities) {
    if (provinces[city.provinceId] === undefined) {
      issues.push(`city "${city.id}" references unknown province "${city.provinceId}"`);
    }
    cities[city.id] = { ...city };
  }
  for (const region of data.regions) {
    if (provinces[region.provinceId] === undefined) {
      issues.push(`region "${region.id}" references unknown province "${region.provinceId}"`);
    }
    for (const neighborId of region.neighbors) {
      if (neighborId !== region.id && data.regions.find((r) => r.id === neighborId) === undefined) {
        issues.push(`region "${region.id}" references unknown neighbor "${neighborId}"`);
      }
      if (neighborId === region.id) {
        issues.push(`region "${region.id}" lists itself as neighbor`);
      }
    }
    if (region.capitalCityId !== undefined && cities[region.capitalCityId] === undefined) {
      issues.push(`region "${region.id}" references unknown capital city "${region.capitalCityId}"`);
    }
    const chunkIds: ChunkId[] = [];
    for (let cx = 0; cx < region.chunkCountX; cx++) {
      for (let cz = 0; cz < region.chunkCountZ; cz++) {
        const chunkId = chunkIdFor(region.id, cx, cz);
        const gx = region.gridX * stride + cx;
        const gz = region.gridZ * stride + cz;
        chunks[chunkId] = { id: chunkId, regionId: region.id, gx, gz };
        chunkIds.push(chunkId);
      }
    }
    regions[region.id] = {
      id: region.id,
      name: region.name,
      provinceId: region.provinceId,
      capitalCityId: region.capitalCityId ?? null,
      gridX: region.gridX,
      gridZ: region.gridZ,
      infrastructure: region.infrastructure,
      basePopulation: region.population,
      neighbors: [...region.neighbors],
      chunkIds
    };
  }

  const countryOfRegion: Record<RegionId, CountryId> = {};
  for (const region of Object.values(regions)) {
    const province = provinces[region.provinceId];
    if (province !== undefined) countryOfRegion[region.id] = province.countryId;
  }

  if (issues.length > 0) {
    throw new StateError(`World data "${data.id}" has referential issues: ${issues.join('; ')}`);
  }

  return {
    worldId: data.id,
    name: data.name,
    countries: Object.fromEntries(data.countries.map((c) => [c.id, { ...c }])),
    provinces,
    cities,
    regions,
    chunks,
    countryOfRegion,
    regionGridStride: stride
  };
}

export function chunksOfRegion(slice: WorldSlice, regionId: RegionId): ChunkRecord[] {
  const region = slice.regions[regionId];
  if (region === undefined) return [];
  return region.chunkIds.map((id) => slice.chunks[id]).filter((chunk) => chunk !== undefined);
}

export function regionsOfCountry(slice: WorldSlice, countryId: CountryId): RegionRecord[] {
  return Object.values(slice.regions).filter((region) => slice.countryOfRegion[region.id] === countryId);
}

/** First chunk of a region — used for focus and spawn operations. */
export function primaryChunkOfRegion(slice: WorldSlice, regionId: RegionId): ChunkId | null {
  const region = slice.regions[regionId];
  return region !== undefined && region.chunkIds.length > 0 ? region.chunkIds[0] : null;
}
