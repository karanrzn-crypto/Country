import { generateStrategicMap } from '../src/world/map/MapGenerator';
import { DEFAULT_MAP_CONFIG } from '../src/tests/helpers/mapTestConfig';
// Instrument: monkey-patch console to add trace via global flag? Simpler: run and catch.
try {
  const { model } = generateStrategicMap(DEFAULT_MAP_CONFIG);
  console.log('rivers', model.features.rivers.length);
} catch (error) {
  console.log('CRASH:', (error as Error).message);
  console.log((error as Error).stack?.split('\n').slice(0, 4).join('\n'));
}
