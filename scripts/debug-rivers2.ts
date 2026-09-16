import { generateStrategicMap } from '../src/world/map/MapGenerator';
import { buildClimateFields } from '../src/world/map/MapFeatures';
import { DEFAULT_MAP_CONFIG } from '../src/tests/helpers/mapTestConfig';

const config = DEFAULT_MAP_CONFIG;
const { model } = generateStrategicMap(config);
const seed = config.seed >>> 0;
const columns = config.columns;
const rows = config.rows;
const fields = buildClimateFields(seed, columns, rows);
const land: boolean[] = model.features.cellOwner.map((owner) => owner >= 0);
const cellCount = columns * rows;
const elevation = fields.elevation;

// Reproduce the river system internals inline:
const neighborsOf = (cellIndex: number): number[] => {
  const cx = cellIndex % columns;
  const cz = Math.floor(cellIndex / columns);
  return [
    cx > 0 ? cellIndex - 1 : -1,
    cx < columns - 1 ? cellIndex + 1 : -1,
    cz > 0 ? cellIndex - columns : -1,
    cz < rows - 1 ? cellIndex + columns : -1
  ].filter((n) => n >= 0);
};
const isOceanNeighbor = (c: number) => neighborsOf(c).some((n) => !land[n]);
const down = new Int32Array(cellCount);
for (let c = 0; c < cellCount; c++) {
  if (!land[c]) { down[c] = -3; continue; }
  if (isOceanNeighbor(c)) { down[c] = -2; continue; }
  let best = -1;
  let bestE = elevation[c];
  for (const n of neighborsOf(c)) {
    if (!land[n]) continue;
    if (elevation[n] < bestE - 1e-9) { bestE = elevation[n]; best = n; }
  }
  down[c] = best;
}
const order = Array.from({ length: cellCount }, (_, i) => i).filter((c) => land[c]);
order.sort((a, b) => elevation[b] - elevation[a] || a - b);
const acc = new Float64Array(cellCount);
for (let i = 0; i < cellCount; i++) if (land[i]) acc[i] = 1;
for (const c of order) {
  const t = down[c];
  if (t >= 0) acc[t] += acc[c];
}
const channelThreshold = Math.max(6, Math.round(order.length * 0.02));
console.log('threshold:', channelThreshold);
const channels = order.filter((c) => acc[c] >= channelThreshold);
console.log('channel cells:', channels.length);
const sources = order.filter(
  (c) =>
    acc[c] >= channelThreshold &&
    elevation[c] >= 0.55 &&
    !neighborsOf(c).some((n) => land[n] && down[n] === c && acc[n] >= channelThreshold)
);
console.log('sources (elev>=0.55):', sources.length);
const sourcesNoElev = order.filter(
  (c) =>
    acc[c] >= channelThreshold &&
    !neighborsOf(c).some((n) => land[n] && down[n] === c && acc[n] >= channelThreshold)
);
console.log('sources (any elev):', sourcesNoElev.length);
if (sourcesNoElev.length > 0) {
  console.log('source elevations:', sourcesNoElev.slice(0, 12).map((c) => elevation[c].toFixed(3)).join(', '));
}
// check top accumulation cells elevations
const topAcc = [...order].sort((a, b) => acc[b] - acc[a]).slice(0, 10);
console.log('top-acc cells elev:', topAcc.map((c) => `${acc[c]}@${elevation[c].toFixed(2)}`).join(' '));
