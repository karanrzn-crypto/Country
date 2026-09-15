/**
 * Deterministic fictional name generator for the strategic map (countries,
 * provinces, cities, the continent). Syllable-combination based with a
 * uniqueness guard — no external data required, fully seeded.
 */

import type { Random } from '../../utils/Random';

const ONSET = [
  'Ar', 'Bel', 'Cor', 'Dan', 'El', 'Fen', 'Gal', 'Hal', 'Isk', 'Kar',
  'Lor', 'Mar', 'Nor', 'Or', 'Pel', 'Qar', 'Ros', 'Sar', 'Tor', 'Ur',
  'Ves', 'Yar', 'Zel', 'Ad', 'Bren', 'Cal', 'Dor', 'Er', 'Fal', 'Grum'
];

const NUCLEUS = ['a', 'e', 'i', 'o', 'u', 'ae', 'ia', 'au', 'ei', 'ou'];

const CODA = ['n', 'r', 'l', 'm', 's', 'th', 'nd', 'st', 'rn', 'ss', '', '', ''];

const COUNTRY_SUFFIX = ['ia', 'land', 'mark', 'stan', 'ora', 'eth', 'gard', 'heim', 'ium', 'ova'];

const CITY_SUFFIX = ['burg', 'port', 'field', 'haven', 'minster', 'grad', 'vik', 'ford', 'holm', 'cester'];

const CONTINENT_SUFFIX = ['ia', 'ara', 'essa', 'otha', 'oria', 'antha'];

function syllable(rng: Random): string {
  return ONSET[rng.int(ONSET.length)] + NUCLEUS[rng.int(NUCLEUS.length)] + CODA[rng.int(CODA.length)];
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Generates a unique name from the given suffix pool. */
export function generateName(
  rng: Random,
  suffixes: readonly string[],
  used: Set<string>,
  attemptLimit = 64
): string {
  for (let attempt = 0; attempt < attemptLimit; attempt++) {
    let root = syllable(rng);
    if (rng.chance(0.45)) root += syllable(rng).toLowerCase();
    const name = capitalize(root) + suffixes[rng.int(suffixes.length)];
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
  }
  // Deterministic fallback: numbered suffix guarantees uniqueness.
  let counter = 2;
  let base = syllable(rng) + suffixes[rng.int(suffixes.length)];
  base = capitalize(base);
  while (used.has(base)) {
    base = capitalize(base.replace(/\s?\d+$/, '')) + counter;
    counter++;
  }
  used.add(base);
  return base;
}

export function generateCountryName(rng: Random, used: Set<string>): string {
  return generateName(rng, COUNTRY_SUFFIX, used);
}

export function generateProvinceName(rng: Random, used: Set<string>): string {
  // Provinces use the country pool shape but their own uniqueness set.
  return generateName(rng, COUNTRY_SUFFIX, used);
}

export function generateCityName(rng: Random, used: Set<string>): string {
  return generateName(rng, CITY_SUFFIX, used);
}

export function generateContinentName(rng: Random): string {
  const used = new Set<string>();
  return generateName(rng, CONTINENT_SUFFIX, used);
}
