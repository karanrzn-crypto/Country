import { generateStrategicMap } from '../src/world/map/MapGenerator';
import { DEFAULT_MAP_CONFIG } from '../src/tests/helpers/mapTestConfig';

const { model, warnings } = generateStrategicMap(DEFAULT_MAP_CONFIG, {
  countryPopulations: { country_0: 7400000, country_1: 4400000, country_2: 10200000, country_3: 7100000, country_4: 9300000, country_5: 4800000, country_6: 5900000, country_7: 4100000, country_8: 5200000, country_9: 9000000 }
});
console.log('warnings:', warnings);
for (const river of model.features.rivers) {
  console.log(`${river.id} "${river.name}" cells=${river.cells.length} mouth=${river.mouthType} parent=${river.parentRiverId} trib=${river.tributaryIds.length} nav=${river.navigable} imp=${river.importance.toFixed(2)} len=${river.length.toFixed(1)}`);
}
console.log('lakes:', model.features.lakes.map((l) => `${l.id} cells=${l.cells.length} inflow=${l.inflowRiverIds.length} outflow=${l.outflowRiverIds.length}`).join(' | '));
// population check
let ok = true;
for (const countryId of model.countryOrder) {
  const provinceIds = model.countries[countryId].provinceIds;
  const provinceSum = provinceIds.reduce((s, pid) => s + model.provinces[pid].population, 0);
  for (const pid of provinceIds) {
    const citySum = model.provinces[pid].cityIds.reduce((s, cid) => s + model.cities[cid].population, 0);
    if (citySum !== model.provinces[pid].population) { ok = false; console.log(`CITY SUM MISMATCH ${pid}: ${citySum} vs ${model.provinces[pid].population}`); }
  }
  console.log(`${countryId}: declared-vs-provinces ${provinceSum}`);
}
console.log('city sums ok:', ok);
// water safety spot check
const firstCity = Object.values(model.cities)[0];
console.log('sample city:', firstCity.name, firstCity.gridId, firstCity.type, 'imp', firstCity.importance.toFixed(2), 'strat', firstCity.strategicValue);
const prov = Object.values(model.provinces)[0];
console.log('sample province:', prov.name, 'pop', prov.population, 'neighbors', prov.neighborProvinceIds.length, 'strat', prov.strategicValue, 'grid', prov.gridIds.slice(0, 5).join(','));
console.log('buildings:', model.features.buildings.length, 'deposits:', model.features.deposits.length);
console.log('city types:', Object.values(model.cities).map((c) => c.type).join(','));
