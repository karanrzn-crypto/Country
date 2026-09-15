/**
 * Raw world description as loaded from JSON (src/data/worlds/*.json).
 * Referential integrity is validated when the initial state is built.
 */

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
