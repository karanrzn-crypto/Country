/**
 * Environment state slice — weather per region (deterministic via shared RNG).
 */

import type { WeatherType } from '../../world/types';

export interface EnvironmentSlice {
  weather: Record<string, WeatherType>;
}
