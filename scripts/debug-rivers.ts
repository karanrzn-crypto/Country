import { generateStrategicMap } from '../src/world/map/MapGenerator';
import { buildClimateFields } from '../src/world/map/MapFeatures';
import { buildRiverSystem } from '../src/world/map/MapRivers';
import { buildLattice, buildCells } from '../src/world/map/MapGeometry';
import { DEFAULT_MAP_CONFIG } from '../src/tests/helpers/mapTestConfig';

const config = DEFAULT_MAP_CONFIG;
const { model } = generateStrategicMap(config);
console.log('rivers:', model.features.rivers.length);
console.log('lakes:', model.features.lakes.length);

// Rebuild pieces for diagnosis
const seed = config.seed >>> 0;
const columns = config.columns;
const rows = config.rows;
const lattice = buildLattice(columns, rows, config.cellSize, config.jitterAmplitude, { next: () => 0.5 } as never);
void lattice;
const fields = buildClimateFields(seed, columns, rows);
const cells = buildCells(columns, rows);
const centroids = cells.map((cell) => {
  const pts = cell.corners;
  void pts;
  return { x: 0, z: 0 };
});
void centroids;

// Land mask from the model: cellOwner >= 0
const land: boolean[] = model.features.cellOwner.map((owner) => owner >= 0);
const landCells = land.filter(Boolean).length;
console.log('land cells:', landCells);

const riverSystem = buildRiverSystem({
  seed,
  columns,
  rows,
  cellSize: config.cellSize,
  land,
  elevation: fields.elevation,
  centroids: model.lattice.length > 0 ? cells.map((cell, i) => {
    // centroid from lattice corners
    const cs = cell.corners;
    let x = 0, z = 0;
    for (const idx of cs) { x += model.lattice[idx].x; z += model.lattice[idx].z; }
    void i;
    return { x: x / 4, z: z / 4 };
  }) : []
});
console.log('system rivers:', riverSystem.rivers.length);
console.log('system lakes:', riverSystem.lakes.length);
const elevationStats = fields.elevation.filter((_, i) => land[i]);
elevationStats.sort((a, b) => b - a);
console.log('elev max:', elevationStats[0], 'p90:', elevationStats[Math.floor(elevationStats.length * 0.1)], 'median:', elevationStats[Math.floor(elevationStats.length / 2)]);
