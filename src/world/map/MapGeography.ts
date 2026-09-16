/**
 * MapGeography — the Part-3 structured-geography builder.
 *
 * Turns the generated political/physical map into a STRUCTURED world:
 *
 *   - Geographic grid: every country gets its own A/B/C… × 1/2/3… grid over
 *     its cells. Grid ids are COUNTRY-LOCAL ("A3" can exist in every
 *     country); the canonical cell id is `gridCellKey(countryId, gridId)`,
 *     so the same label never conflicts across countries.
 *   - Population tree: Country → Province → City, distributed from the
 *     DECLARED country population with exact integer largest-remainder
 *     splits — Σ cities = province, Σ provinces = country (no conflicts).
 *   - Provinces: capital, population, area, terrain, resources, buildings,
 *     neighbors (structural), infrastructure, development, control/security,
 *     production capacity, strategic value, grid ids.
 *   - Cities: grid id, type (capital/major/medium/small/settlement),
 *     importance, buildings, resources, industries, infrastructure,
 *     strategic value, riverside relation.
 *   - Buildings & deposits: located facilities and resource deposits built
 *     from the feature sites (DATA ONLY — no construction simulation).
 *   - Water enrichment: rivers gain provinces/cities, lakes gain
 *     provinces/lakeside cities.
 *   - Water safety: city positions are validated against lakes and river
 *     centerlines (the generator places cities water-aware; these pure
 *     helpers are the shared contract + test oracle + defensive heal).
 *
 * Pure TypeScript: no Three.js, no DOM. Fully deterministic (hash-based).
 */

import type {
  CityInfrastructure,
  CityType,
  MapBuilding,
  MapLake,
  MapPoint,
  MapResourceDeposit,
  MapRiver,
  ProvinceInfrastructure,
  TerrainId
} from './MapTypes';
import { gridCellKey, gridColumnLetter } from './MapTypes';

// ———————————————————— deterministic hashing ————————————————————

/** FNV-1a 32-bit hash of a string (stable across processes). */
export function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Deterministic [0,1) from a string seed. */
export function hash01(text: string): number {
  return hashString(text) / 0x100000000;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

// ———————————————————— geographic grid ————————————————————

/**
 * Assigns country-local grid ids to every land cell. Each country's grid is
 * anchored at ITS OWN cells: the country's distinct cell columns become the
 * letter sequence A, B, C… (left→right) and its distinct cell rows the
 * numbers 1, 2, 3… (top→bottom) — RANK-based, so "A1" always exists and no
 * column/row gaps appear even for L-shaped countries. The same grid id
 * therefore exists in every country — `gridCellKey` namespaces it. Ocean
 * cells map to null.
 */
export function buildCountryGrids(
  countryCellIds: readonly (readonly number[])[],
  columns: number,
  rows: number,
  cellCount: number
): readonly (string | null)[] {
  void rows;
  const gridIds: (string | null)[] = new Array(cellCount).fill(null);
  for (const cells of countryCellIds) {
    if (cells.length === 0) continue;
    const columnRank = new Map<number, number>();
    const rowRank = new Map<number, number>();
    for (const cellIndex of cells) {
      columnRank.set(cellIndex % columns, 0);
      rowRank.set(Math.floor(cellIndex / columns), 0);
    }
    [...columnRank.keys()].sort((a, b) => a - b).forEach((cx, rank) => columnRank.set(cx, rank));
    [...rowRank.keys()].sort((a, b) => a - b).forEach((cz, rank) => rowRank.set(cz, rank));
    for (const cellIndex of cells) {
      const column = columnRank.get(cellIndex % columns) as number;
      const row = rowRank.get(Math.floor(cellIndex / columns)) as number;
      gridIds[cellIndex] = `${gridColumnLetter(column)}${row + 1}`;
    }
  }
  return gridIds;
}

export { gridCellKey };

/** Cell → province id (null on ocean) from the dense partition. Shared by
 *  the generator (deposits) and buildGeography — ONE formula, no drift. */
export function computeProvinceOfCells(
  provincePartition: Int32Array,
  provinceIdByIndex: readonly string[],
  cellCount: number
): readonly (string | null)[] {
  const provinceOf: (string | null)[] = new Array(cellCount).fill(null);
  for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
    const denseIndex = provincePartition[cellIndex];
    if (denseIndex >= 0) provinceOf[cellIndex] = provinceIdByIndex[denseIndex] ?? null;
  }
  return provinceOf;
}

// ———————————————————— population tree ————————————————————

export interface PopulationTreeInput {
  /** Declared (authoritative) population per country id. */
  readonly countryPopulations: Readonly<Record<string, number>>;
  readonly countryOrder: readonly string[];
  readonly provinces: readonly {
    readonly id: string;
    readonly countryId: string;
    /** Area hint (cells) — bigger provinces carry more people. */
    readonly weight: number;
    readonly cityIds: readonly string[];
  }[];
  readonly cities: readonly { readonly id: string; readonly provinceId: string; readonly isCapital: boolean }[];
}

export interface PopulationTree {
  readonly provinces: Readonly<Record<string, number>>;
  readonly cities: Readonly<Record<string, number>>;
}

/**
 * Exact integer distribution with largest-remainder rounding. Splits
 * `total` by `weights` so the parts sum EXACTLY to total; a part never
 * drops below `minPart` when the total allows it.
 */
function distributeExact(
  total: number,
  keys: readonly string[],
  weights: readonly number[],
  minPart: number
): Record<string, number> {
  const result: Record<string, number> = {};
  const count = keys.length;
  if (count === 0) return result;
  const weightSum = weights.reduce((a, b) => a + b, 0) || 1;
  const usableTotal = Math.max(count * minPart, total);
  const scaled = weights.map((weight) => (weight / weightSum) * usableTotal);
  const base = scaled.map((value) => Math.floor(value));
  let remainder = usableTotal - base.reduce((a, b) => a + b, 0);
  const order = keys
    .map((key, index) => ({ key, fraction: scaled[index] - base[index], index }))
    .sort((a, b) => b.fraction - a.fraction || (a.key < b.key ? -1 : 1));
  for (const entry of order) {
    if (remainder <= 0) break;
    base[entry.index] += 1;
    remainder -= 1;
  }
  keys.forEach((key, index) => {
    result[key] = Math.max(minPart, base[index]);
  });
  return result;
}

/**
 * Builds the Country → Province → City population tree. The DECLARED
 * country population is authoritative; provinces split it by area-weighted
 * deterministic weights; cities split their province by capital/size
 * weights. Every level sums EXACTLY to its parent (largest-remainder).
 */
export function buildPopulationTree(input: PopulationTreeInput): PopulationTree {
  const provinceIds = input.provinces.map((province) => province.id);
  const provinceWeights = input.provinces.map(
    (province) => Math.max(1, province.weight) * (0.72 + 0.56 * hash01(`pop:${province.id}`))
  );

  // Country → provinces (only provinces of that country participate).
  const provincePopulations: Record<string, number> = {};
  const cityPopulations: Record<string, number> = {};
  for (const countryId of input.countryOrder) {
    const declared = input.countryPopulations[countryId];
    if (declared === undefined || declared <= 0) continue;
    const members = input.provinces.filter((province) => province.countryId === countryId);
    if (members.length === 0) continue;
    const localIds = members.map((province) => province.id);
    const localWeights = members.map((province) => provinceWeights[provinceIds.indexOf(province.id)]);
    const distributed = distributeExact(declared, localIds, localWeights, 5_000);
    Object.assign(provincePopulations, distributed);

    // Province → cities (capital cities weigh several times more).
    for (const province of members) {
      const provinceTotal = distributed[province.id];
      if (province.cityIds.length === 0) continue;
      const cityWeights = province.cityIds.map((cityId) => {
        const city = input.cities.find((candidate) => candidate.id === cityId);
        const capitalBonus = city?.isCapital === true ? 3.2 : 1;
        return capitalBonus * (0.55 + 1.65 * hash01(`citypop:${cityId}`));
      });
      const citySplit = distributeExact(provinceTotal, [...province.cityIds], cityWeights, 1_000);
      Object.assign(cityPopulations, citySplit);
    }
  }
  return { provinces: provincePopulations, cities: cityPopulations };
}

// ———————————————————— city types & importance ————————————————————

/** Data-driven city classification thresholds (population). */
export const CITY_TYPE_THRESHOLDS = {
  major: 900_000,
  medium: 400_000,
  small: 120_000
} as const;

export function classifyCityType(population: number, isCapital: boolean): CityType {
  if (isCapital) return 'capital';
  if (population >= CITY_TYPE_THRESHOLDS.major) return 'major';
  if (population >= CITY_TYPE_THRESHOLDS.medium) return 'medium';
  if (population >= CITY_TYPE_THRESHOLDS.small) return 'small';
  return 'settlement';
}

// ———————————————————— water safety ————————————————————

/** City ↔ river-centerline minimum distance, as a fraction of cellSize. */
export const WATER_CLEARANCE_FRACTION = 0.45;
/** Distance band in which a city counts as deliberately riverside. */
export const RIVERSIDE_BAND_FRACTION = 1.2;

function distancePointToSegment(point: MapPoint, a: MapPoint, b: MapPoint): number {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const lengthSquared = abx * abx + abz * abz;
  if (lengthSquared < 1e-12) return Math.hypot(point.x - a.x, point.z - a.z);
  let t = ((point.x - a.x) * abx + (point.z - a.z) * abz) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(point.x - (a.x + t * abx), point.z - (a.z + t * abz));
}

/** Distance from a point to a polyline (min over segments). */
export function distanceToPolyline(point: MapPoint, polyline: readonly MapPoint[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < polyline.length; i++) {
    const d = distancePointToSegment(point, polyline[i - 1], polyline[i]);
    if (d < best) best = d;
  }
  return polyline.length === 1 ? Math.hypot(point.x - polyline[0].x, point.z - polyline[0].z) : best;
}

/** Distance from a point to the nearest river centerline (POSITIVE_INFINITY without rivers). */
export function distanceToNearestRiver(point: MapPoint, rivers: readonly MapRiver[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const river of rivers) {
    const d = distanceToPolyline(point, river.polyline);
    if (d < best) best = d;
  }
  return best;
}

export interface WaterSafetyInput {
  readonly position: MapPoint;
  readonly hostCell: number;
  readonly cellSize: number;
  readonly rivers: readonly MapRiver[];
  readonly lakeCellSet: ReadonlySet<number>;
  /** River cells (owner map keys) — a city on one sits on the centerline. */
  readonly riverCellSet: ReadonlySet<number>;
}

export interface WaterSafetyVerdict {
  readonly safe: boolean;
  /** Human-readable violation (tests, logs, defensive heals). */
  readonly violation: 'ocean' | 'lake' | 'river' | null;
}

/**
 * THE water-placement contract (spec §4):
 * - a city never sits in a lake cell;
 * - a city never sits ON a river centerline (clearance from every river);
 * - riverside cities ARE allowed (deliberate, flagged isRiverine) — they
 *   keep the natural clearance from the centerline.
 */
export function checkWaterSafety(input: WaterSafetyInput): WaterSafetyVerdict {
  const clearance = input.cellSize * WATER_CLEARANCE_FRACTION;
  if (input.lakeCellSet.has(input.hostCell)) return { safe: false, violation: 'lake' };
  if (input.riverCellSet.has(input.hostCell)) {
    // On a river cell — acceptable ONLY if the actual position still keeps
    // the clearance from every centerline (e.g. cell corner away from the
    // jittered line).
    const distance = distanceToNearestRiver(input.position, input.rivers);
    if (distance < clearance) return { safe: false, violation: 'river' };
    return { safe: true, violation: null };
  }
  const distance = distanceToNearestRiver(input.position, input.rivers);
  if (distance < clearance) return { safe: false, violation: 'river' };
  return { safe: true, violation: null };
}

// ———————————————————— strategic value ————————————————————

export interface ProvinceStrategicInput {
  readonly population: number;
  readonly resourceKinds: number;
  readonly industrialBuildings: number;
  readonly infrastructure: ProvinceInfrastructure;
  readonly isCountryCapital: boolean;
  readonly hasPort: boolean;
  readonly hasAirport: boolean;
  readonly hasMilitary: boolean;
  readonly hasRiver: boolean;
}

/** Documented base weights (sum ≤ 100) — future war/economy systems extend this. */
export const STRATEGIC_WEIGHTS = {
  population: 30,
  resources: 15,
  industry: 15,
  infrastructure: 15,
  capital: 10,
  port: 5,
  airport: 5,
  military: 5,
  river: 5
} as const;

export function computeProvinceStrategicValue(input: ProvinceStrategicInput): number {
  const w = STRATEGIC_WEIGHTS;
  const infraScore =
    input.infrastructure.roads +
    2 * input.infrastructure.railways +
    3 * input.infrastructure.airports +
    3 * input.infrastructure.ports +
    2 * input.infrastructure.utilities;
  return Math.min(
    100,
    Math.round(
      clamp01(input.population / 2_500_000) * w.population +
        clamp01(input.resourceKinds / 5) * w.resources +
        clamp01(input.industrialBuildings / 4) * w.industry +
        clamp01(infraScore / 14) * w.infrastructure +
        (input.isCountryCapital ? w.capital : 0) +
        (input.hasPort ? w.port : 0) +
        (input.hasAirport ? w.airport : 0) +
        (input.hasMilitary ? w.military : 0) +
        (input.hasRiver ? w.river : 0)
    )
  );
}

export interface CityStrategicInput {
  readonly population: number;
  readonly isCapital: boolean;
  readonly hasPort: boolean;
  readonly hasAirport: boolean;
  readonly industries: number;
  readonly hasMilitary: boolean;
  readonly hasHospital: boolean;
  readonly hasPower: boolean;
  readonly roadCount: number;
  readonly hasRiver: boolean;
}

export function computeCityStrategicValue(input: CityStrategicInput): number {
  return Math.min(
    100,
    Math.round(
      clamp01(input.population / 1_500_000) * 35 +
        (input.isCapital ? 20 : 0) +
        (input.hasPort ? 10 : 0) +
        (input.hasAirport ? 10 : 0) +
        clamp01(input.industries / 3) * 10 +
        (input.hasMilitary ? 5 : 0) +
        (input.hasHospital ? 5 : 0) +
        (input.hasPower ? 5 : 0) +
        (input.roadCount >= 3 ? 5 : 0) +
        (input.hasRiver ? 5 : 0)
    )
  );
}

// ———————————————————— buildings & deposits ————————————————————

export interface BuildingBuildInput {
  readonly sites: readonly {
    readonly id: string;
    readonly kind: string;
    readonly resourceId: string | null;
    readonly countryId: string;
    readonly cityId: string | null;
    readonly cellIndex: number;
    readonly position: MapPoint;
  }[];
  readonly cities: readonly {
    readonly id: string;
    readonly countryId: string;
    readonly provinceId: string;
    readonly position: MapPoint;
    readonly isCapital: boolean;
  }[];
  /** Road/railway line endpoints per city (railway stations). */
  readonly railwayCityIds: ReadonlySet<string>;
  readonly provinceOfCity: Readonly<Record<string, string>>;
}

/**
 * Derives the Part-3 BUILDING data model from feature sites + cities:
 * ports/airports/bases/factories come from sites; capitals get government
 * seats; bigger cities hospitals, commercial space and power; railway
 * endpoints get stations; smaller towns residential blocks.
 * Deterministic ordering: sites by index, then cities by id.
 */
export function buildBuildings(input: BuildingBuildInput): MapBuilding[] {
  const buildings: MapBuilding[] = [];
  const push = (
    kind: MapBuilding['kind'],
    countryId: string,
    provinceId: string,
    cityId: string | null,
    position: MapPoint
  ): void => {
    buildings.push({
      id: `bld_${buildings.length}`,
      kind,
      countryId,
      provinceId,
      cityId,
      position,
      level: 1 + Math.floor(hash01(`${kind}:${buildings.length}`) * 5)
    });
  };

  const cityById = new Map(input.cities.map((city) => [city.id, city]));
  for (const site of input.sites) {
    const city = site.cityId !== null ? cityById.get(site.cityId) : undefined;
    const provinceId = city !== undefined ? city.provinceId : input.provinceOfCity[site.cityId ?? ''];
    if (city === undefined && provinceId === undefined) continue;
    switch (site.kind) {
      case 'port':
        push('port', site.countryId, provinceId, site.cityId, site.position);
        break;
      case 'airbase':
        push('airport', site.countryId, provinceId, site.cityId, site.position);
        break;
      case 'base':
        push('militaryBase', site.countryId, provinceId, site.cityId, site.position);
        break;
      case 'factory':
        push('industrial', site.countryId, provinceId, site.cityId, site.position);
        break;
      default:
        break; // farms stay production sites (not in the Part-3 building kinds)
    }
  }

  const industrialByCity = new Set(
    buildings.filter((building) => building.kind === 'industrial').map((building) => building.cityId)
  );
  for (const city of [...input.cities].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (city.isCapital) push('government', city.countryId, city.provinceId, city.id, city.position);
    if (industrialByCity.has(city.id)) push('power', city.countryId, city.provinceId, city.id, city.position);
    if (input.railwayCityIds.has(city.id)) {
      push('railwayStation', city.countryId, city.provinceId, city.id, city.position);
    }
    push('residential', city.countryId, city.provinceId, city.id, city.position);
    if (hash01(`hospital:${city.id}`) < 0.6) {
      push('hospital', city.countryId, city.provinceId, city.id, city.position);
    }
    if (hash01(`commercial:${city.id}`) < 0.5) {
      push('commercial', city.countryId, city.provinceId, city.id, city.position);
    }
  }
  return buildings;
}

export interface DepositBuildInput {
  readonly sites: readonly {
    readonly id: string;
    readonly kind: string;
    readonly resourceId: string | null;
    readonly countryId: string;
    readonly cellIndex: number;
    readonly position: MapPoint;
  }[];
  readonly provinceOfCell: readonly (string | null)[];
}

/**
 * Located resource deposits: every mine/oil site becomes a deposit of its
 * resource; every farm becomes a FOOD deposit. Quantity is deterministic
 * (hash-based 1..100). Deposits are geography — never location-less.
 */
export function buildDeposits(input: DepositBuildInput): MapResourceDeposit[] {
  const deposits: MapResourceDeposit[] = [];
  for (const site of input.sites) {
    let resourceId: string | null = null;
    if (site.kind === 'mine' || site.kind === 'oil') resourceId = site.resourceId;
    else if (site.kind === 'farm') resourceId = 'food';
    if (resourceId === null) continue;
    const provinceId = input.provinceOfCell[site.cellIndex];
    if (provinceId === undefined || provinceId === null) continue;
    deposits.push({
      id: `dep_${deposits.length}`,
      resourceId,
      countryId: site.countryId,
      provinceId,
      cellIndex: site.cellIndex,
      position: site.position,
      siteId: site.id,
      quantity: 1 + Math.floor(hash01(`dep:${site.id}`) * 100)
    });
  }
  return deposits;
}

// ———————————————————— enrichment wiring ————————————————————

export interface ProvinceEnrichment {
  readonly capitalCityId: string | null;
  readonly population: number;
  readonly areaCells: number;
  readonly area: number;
  readonly terrainType: TerrainId;
  readonly resourceIds: readonly string[];
  readonly buildingIds: readonly string[];
  readonly neighborProvinceIds: readonly string[];
  readonly infrastructure: ProvinceInfrastructure;
  readonly developmentLevel: number;
  readonly control: number;
  readonly security: number;
  readonly productionCapacity: number;
  readonly strategicValue: number;
  readonly gridIds: readonly string[];
}

export interface CityEnrichment {
  readonly population: number;
  readonly gridId: string;
  readonly type: CityType;
  readonly importance: number;
  readonly buildingIds: readonly string[];
  readonly resourceIds: readonly string[];
  readonly industries: readonly string[];
  readonly infrastructure: CityInfrastructure;
  readonly strategicValue: number;
  readonly riverIds: readonly string[];
  readonly isRiverine: boolean;
}

export interface GeographyBuildInput {
  readonly columns: number;
  readonly rows: number;
  readonly cellSize: number;
  readonly cellCount: number;
  /** Terrain class per cell (features.terrain). */
  readonly terrain: readonly TerrainId[];
  readonly countryPartition: Int32Array;
  /** Dense global province index per land cell (−1 ocean). */
  readonly provincePartition: Int32Array;
  /** Dense province index → province id. */
  readonly provinceIdByIndex: readonly string[];
  readonly countryOrder: readonly string[];
  readonly countries: Readonly<
    Record<string, { readonly capitalCityId: string; readonly provinceIds: readonly string[]; readonly cellIds: readonly number[] }>
  >;
  readonly provinces: Readonly<
    Record<string, { readonly countryId: string; readonly cellIds: readonly number[]; readonly cityIds: readonly string[] }>
  >;
  readonly cities: Readonly<
    Record<string, { readonly countryId: string; readonly provinceId: string; readonly position: MapPoint; readonly isCapital: boolean }>
  >;
  readonly hostCellOfCity: Readonly<Record<string, number>>;
  readonly rivers: readonly MapRiver[];
  readonly lakes: readonly MapLake[];
  readonly lines: readonly { readonly id: string; readonly kind: string; readonly cityA: string | null; readonly cityB: string | null }[];
  readonly sites: readonly {
    readonly id: string;
    readonly kind: string;
    readonly countryId: string;
    readonly cityId: string | null;
    readonly cellIndex: number;
  }[];
  readonly buildings: readonly MapBuilding[];
  readonly deposits: readonly MapResourceDeposit[];
  readonly countryPopulations: Readonly<Record<string, number>>;
}

export interface GeographyBuildResult {
  readonly gridIds: readonly (string | null)[];
  readonly provinceOf: readonly (string | null)[];
  readonly provinces: Readonly<Record<string, ProvinceEnrichment>>;
  readonly cities: Readonly<Record<string, CityEnrichment>>;
  readonly rivers: readonly MapRiver[];
  readonly lakes: readonly MapLake[];
}

/**
 * Builds ALL Part-3 enrichment in one deterministic pass over the assembled
 * political map. Pure function: every output is derived, never random.
 */
export function buildGeography(input: GeographyBuildInput): GeographyBuildResult {
  const { columns, rows, cellSize } = input;

  // —— grid (country-local "A3"-style ids) ——
  const countryCellLists = input.countryOrder.map((countryId) => input.countries[countryId].cellIds);
  const gridIds = buildCountryGrids(countryCellLists, columns, rows, input.cellCount);

  // —— cell → province id ——
  const provinceOf = computeProvinceOfCells(input.provincePartition, input.provinceIdByIndex, input.cellCount);

  // —— province neighbors (structural, from cell adjacency) ——
  const neighborSets = new Map<string, Set<string>>();
  for (const provinceId of input.provinceIdByIndex) neighborSets.set(provinceId, new Set());
  for (let cz = 0; cz < rows; cz++) {
    for (let cx = 0; cx < columns; cx++) {
      const cellIndex = cz * columns + cx;
      const provinceId = provinceOf[cellIndex];
      if (provinceId === null) continue;
      const neighbors = [
        cx > 0 ? cellIndex - 1 : -1,
        cx < columns - 1 ? cellIndex + 1 : -1,
        cz > 0 ? cellIndex - columns : -1,
        cz < rows - 1 ? cellIndex + columns : -1
      ];
      for (const neighbor of neighbors) {
        if (neighbor < 0) continue;
        const other = provinceOf[neighbor];
        if (other !== null && other !== provinceId) {
          neighborSets.get(provinceId)?.add(other);
          neighborSets.get(other)?.add(provinceId);
        }
      }
    }
  }

  // —— population tree ——
  const tree = buildPopulationTree({
    countryPopulations: input.countryPopulations,
    countryOrder: input.countryOrder,
    provinces: input.provinceIdByIndex.map((id) => ({
      id,
      countryId: input.provinces[id].countryId,
      weight: input.provinces[id].cellIds.length,
      cityIds: input.provinces[id].cityIds
    })),
    cities: Object.entries(input.cities).map(([id, city]) => ({
      id,
      provinceId: city.provinceId,
      isCapital: city.isCapital
    }))
  });

  // —— water relation: blocked cells + river/lake bands ——
  const lakeCellSet = new Set<number>();
  for (const lake of input.lakes) for (const cellIndex of lake.cells) lakeCellSet.add(cellIndex);
  const riversideBand = cellSize * RIVERSIDE_BAND_FRACTION;

  // —— province enrichment ——
  const TERRAIN_ORDER: readonly TerrainId[] = [
    'lowland',
    'valley',
    'plains',
    'plateau',
    'hills',
    'mountain',
    'highMountain'
  ];
  const provinceEnrichment: Record<string, ProvinceEnrichment> = {};
  const depositsByProvince = new Map<string, MapResourceDeposit[]>();
  for (const deposit of input.deposits) {
    const list = depositsByProvince.get(deposit.provinceId) ?? [];
    list.push(deposit);
    depositsByProvince.set(deposit.provinceId, list);
  }
  const buildingsByProvince = new Map<string, MapBuilding[]>();
  for (const building of input.buildings) {
    const list = buildingsByProvince.get(building.provinceId) ?? [];
    list.push(building);
    buildingsByProvince.set(building.provinceId, list);
  }

  for (const provinceId of input.provinceIdByIndex) {
    const province = input.provinces[provinceId];
    const cells = province.cellIds;
    const provinceBuildings = buildingsByProvince.get(provinceId) ?? [];
    const provinceDeposits = depositsByProvince.get(provinceId) ?? [];

    // Dominant terrain (max count; ties by TERRAIN_ORDER — deterministic).
    const terrainCounts = new Map<TerrainId, number>();
    for (const cellIndex of cells) {
      const terrainId = input.terrain[cellIndex];
      terrainCounts.set(terrainId, (terrainCounts.get(terrainId) ?? 0) + 1);
    }
    let terrainType: TerrainId = 'plains';
    let bestCount = -1;
    for (const terrainId of TERRAIN_ORDER) {
      const count = terrainCounts.get(terrainId) ?? 0;
      if (count > bestCount) {
        bestCount = count;
        terrainType = terrainId;
      }
    }

    // Provincial capital: highest-population member city (falls back to the
    // country capital when it belongs to this province, else first city).
    let capitalCityId: string | null = null;
    let capitalPopulation = -1;
    for (const cityId of province.cityIds) {
      const population = tree.cities[cityId] ?? 0;
      if (population > capitalPopulation) {
        capitalPopulation = population;
        capitalCityId = cityId;
      }
    }

    const resourceIds = [...new Set(provinceDeposits.map((deposit) => deposit.resourceId))].sort();
    const industrialBuildings = provinceBuildings.filter((building) => building.kind === 'industrial').length;
    const airportBuildings = provinceBuildings.filter((building) => building.kind === 'airport').length;
    const portBuildings = provinceBuildings.filter((building) => building.kind === 'port').length;
    const powerBuildings = provinceBuildings.filter((building) => building.kind === 'power').length;
    const militaryBuildings = provinceBuildings.filter((building) => building.kind === 'militaryBase').length;

    const provinceCityIds = new Set(province.cityIds);
    const roads = input.lines.filter(
      (line) =>
        line.kind !== 'railway' &&
        line.kind !== 'seaRoute' &&
        ((line.cityA !== null && provinceCityIds.has(line.cityA)) ||
          (line.cityB !== null && provinceCityIds.has(line.cityB)))
    ).length;
    const railways = input.lines.filter(
      (line) =>
        line.kind === 'railway' &&
        ((line.cityA !== null && provinceCityIds.has(line.cityA)) ||
          (line.cityB !== null && provinceCityIds.has(line.cityB)))
    ).length;

    const infrastructure: ProvinceInfrastructure = {
      roads,
      railways,
      airports: airportBuildings,
      ports: portBuildings,
      utilities: powerBuildings
    };

    const population = tree.provinces[provinceId] ?? 0;
    const isCountryCapital = capitalCityId !== null && input.countries[province.countryId].capitalCityId === capitalCityId;
    const hasRiver = input.rivers.some((river) =>
      river.cells.some((cellIndex) => provinceOf[cellIndex] === provinceId)
    );

    const infraScore =
      roads + 2 * railways + 3 * airportBuildings + 3 * portBuildings + 2 * powerBuildings;
    const developmentLevel = clamp01(
      0.45 * clamp01(infraScore / 12) +
        0.3 * clamp01(population / 3_000_000) +
        0.25 * clamp01(resourceIds.length / 4)
    );
    const productionCapacity = Math.round(
      population * (0.4 + 0.6 * developmentLevel) +
        industrialBuildings * 50_000 +
        (provinceDeposits.filter((deposit) => deposit.resourceId === 'food').length * 30_000)
    );

    provinceEnrichment[provinceId] = {
      capitalCityId,
      population,
      areaCells: cells.length,
      area: Math.round(cells.length * cellSize * cellSize),
      terrainType,
      resourceIds,
      buildingIds: provinceBuildings.map((building) => building.id),
      neighborProvinceIds: [...(neighborSets.get(provinceId) ?? [])].sort(),
      infrastructure,
      developmentLevel,
      control: 1,
      security: 1,
      productionCapacity,
      strategicValue: computeProvinceStrategicValue({
        population,
        resourceKinds: resourceIds.length,
        industrialBuildings,
        infrastructure,
        isCountryCapital,
        hasPort: portBuildings > 0,
        hasAirport: airportBuildings > 0,
        hasMilitary: militaryBuildings > 0,
        hasRiver
      }),
      gridIds: cells.map((cellIndex) => gridIds[cellIndex] ?? '').filter((gridId) => gridId !== '')
    };
  }

  // —— city enrichment ——
  const buildingsByCity = new Map<string, MapBuilding[]>();
  for (const building of input.buildings) {
    if (building.cityId === null) continue;
    const list = buildingsByCity.get(building.cityId) ?? [];
    list.push(building);
    buildingsByCity.set(building.cityId, list);
  }
  const depositsByCell = new Map<number, MapResourceDeposit[]>();
  for (const deposit of input.deposits) {
    const list = depositsByCell.get(deposit.cellIndex) ?? [];
    list.push(deposit);
    depositsByCell.set(deposit.cellIndex, list);
  }

  const cityEnrichment: Record<string, CityEnrichment> = {};
  for (const [cityId, city] of Object.entries(input.cities)) {
    const cityBuildings = buildingsByCity.get(cityId) ?? [];
    const population = tree.cities[cityId] ?? 0;
    const hostCell = input.hostCellOfCity[cityId] ?? 0;

    // Deposits in the host cell + its direct neighbors (reachable resources).
    const hostCx = hostCell % columns;
    const hostCz = Math.floor(hostCell / columns);
    const nearbyCells = [
      hostCell,
      hostCx > 0 ? hostCell - 1 : -1,
      hostCx < columns - 1 ? hostCell + 1 : -1,
      hostCz > 0 ? hostCell - columns : -1,
      hostCz < rows - 1 ? hostCell + columns : -1
    ].filter((cellIndex) => cellIndex >= 0);
    const cityDeposits = nearbyCells.flatMap((cellIndex) => depositsByCell.get(cellIndex) ?? []);
    const resourceIds = [...new Set(cityDeposits.map((deposit) => deposit.resourceId))].sort();

    const roadIds = input.lines
      .filter((line) => line.kind !== 'railway' && line.kind !== 'seaRoute' && (line.cityA === cityId || line.cityB === cityId))
      .map((line) => line.id);
    const railwayIds = input.lines
      .filter((line) => line.kind === 'railway' && (line.cityA === cityId || line.cityB === cityId))
      .map((line) => line.id);
    const airport = cityBuildings.find((building) => building.kind === 'airport');
    const port = cityBuildings.find((building) => building.kind === 'port');
    const industries = cityBuildings
      .filter((building) => building.kind === 'industrial')
      .map((building) => building.id);
    const militarySiteIds = input.sites
      .filter((site) => site.cityId === cityId && (site.kind === 'base' || site.kind === 'airbase'))
      .map((site) => site.id);

    const infrastructure: CityInfrastructure = {
      roadIds,
      railwayIds,
      airportId: airport?.id ?? null,
      portId: port?.id ?? null,
      hasHospital: cityBuildings.some((building) => building.kind === 'hospital'),
      hasPower: cityBuildings.some((building) => building.kind === 'power'),
      militarySiteIds
    };

    // Riverside relation: rivers within the natural band (never ON water).
    const riverIds = input.rivers
      .filter((river) => distanceToPolyline(city.position, river.polyline) <= riversideBand)
      .map((river) => river.id);
    const isRiverine = riverIds.length > 0;

    const type = classifyCityType(population, city.isCapital);
    const importance = Math.min(
      1,
      (city.isCapital ? 0.35 : 0) +
        0.4 * clamp01(population / 1_500_000) +
        (port !== undefined ? 0.1 : 0) +
        (airport !== undefined ? 0.1 : 0) +
        (industries.length > 0 ? 0.05 : 0)
    );

    cityEnrichment[cityId] = {
      population,
      gridId: gridIds[hostCell] ?? '',
      type,
      importance,
      buildingIds: cityBuildings.map((building) => building.id),
      resourceIds,
      industries,
      infrastructure,
      strategicValue: computeCityStrategicValue({
        population,
        isCapital: city.isCapital,
        hasPort: port !== undefined,
        hasAirport: airport !== undefined,
        industries: industries.length,
        hasMilitary: militarySiteIds.length > 0,
        hasHospital: infrastructure.hasHospital,
        hasPower: infrastructure.hasPower,
        roadCount: roadIds.length,
        hasRiver: isRiverine
      }),
      riverIds,
      isRiverine
    };
  }

  // —— river / lake enrichment (provinces, cities) ——
  const rivers: MapRiver[] = input.rivers.map((river) => {
    const provinceIds = [...new Set(river.cells.map((cellIndex) => provinceOf[cellIndex]).filter((id): id is string => id !== null))].sort();
    const cityIds = Object.entries(input.cities)
      .filter(([, city]) => distanceToPolyline(city.position, river.polyline) <= riversideBand)
      .map(([id]) => id)
      .sort();
    return { ...river, provinceIds, cityIds };
  });
  const lakes: MapLake[] = input.lakes.map((lake) => {
    const lakeCellSetLocal = new Set(lake.cells);
    const adjacentProvinces = new Set<string>();
    const cityIds: string[] = [];
    for (const cellIndex of lake.cells) {
      const cx = cellIndex % columns;
      const cz = Math.floor(cellIndex / columns);
      for (const neighbor of [
        cx > 0 ? cellIndex - 1 : -1,
        cx < columns - 1 ? cellIndex + 1 : -1,
        cz > 0 ? cellIndex - columns : -1,
        cz < rows - 1 ? cellIndex + columns : -1
      ]) {
        if (neighbor < 0 || lakeCellSetLocal.has(neighbor)) continue;
        const provinceId = provinceOf[neighbor];
        if (provinceId !== null) adjacentProvinces.add(provinceId);
      }
    }
    for (const [cityId, city] of Object.entries(input.cities)) {
      const hostCell = input.hostCellOfCity[cityId] ?? -1;
      if (lakeCellSetLocal.has(hostCell)) continue; // never inside the surface
      const cx = hostCell % columns;
      const cz = Math.floor(hostCell / columns);
      const touchesLake = [
        cx > 0 ? hostCell - 1 : -1,
        cx < columns - 1 ? hostCell + 1 : -1,
        cz > 0 ? hostCell - columns : -1,
        cz < rows - 1 ? hostCell + columns : -1
      ].some((neighbor) => neighbor >= 0 && lakeCellSetLocal.has(neighbor));
      if (touchesLake || Math.hypot(city.position.x - lake.position.x, city.position.z - lake.position.z) <= riversideBand * 2) {
        cityIds.push(cityId);
      }
    }
    return {
      ...lake,
      provinceIds: [...adjacentProvinces].sort(),
      cityIds: cityIds.sort()
    };
  });

  void gridCellKey; // re-exported above — keeps the canonical id format beside the grid builder
  return { gridIds, provinceOf, provinces: provinceEnrichment, cities: cityEnrichment, rivers, lakes };
}
