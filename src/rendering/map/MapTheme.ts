/**
 * Strategic-map theme helpers. The raw theme data lives in
 * src/data/mapTheme.json (data layer); this module only adapts it for the
 * Three.js renderer (color parsing). All tuning stays in JSON.
 */

import type { MapThemeData } from '../../data/types';

export type MapTheme = MapThemeData;

export function themeColor(hex: string): { r: number; g: number; b: number } {
  const value = hex.replace('#', '');
  return {
    r: parseInt(value.slice(0, 2), 16) / 255,
    g: parseInt(value.slice(2, 4), 16) / 255,
    b: parseInt(value.slice(4, 6), 16) / 255
  };
}
