/**
 * Flag asset pipeline (Part 2) — tiny generated SVG flags from data-driven
 * flag specs (src/data/countries.json). DOM-free: returns markup / data URLs
 * the UI can embed in <img> elements.
 *
 * Architecture: the renderer/UI only displays the flag asset attached to a
 * country — it knows nothing about country logic. When higher-quality real
 * flag textures arrive later, only this module (or an AssetManager loader
 * registered behind the same spec shape) changes; the data model stays.
 */

import type { FlagDataJson } from '../data/types';

/** Guards against malformed colors (specs are validated upstream; defense in depth). */
function safeColor(color: string, fallback = '#888888'): string {
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : fallback;
}

/** Renders the flag spec to a small SVG string (3:2 aspect, 60×40 units). */
export function flagSvg(flag: FlagDataJson): string {
  const colors = flag.colors.length > 0 ? flag.colors : ['#888888'];
  const shapes: string[] = [];

  switch (flag.layout) {
    case 'solid':
      shapes.push(`<rect width="60" height="40" fill="${safeColor(colors[0])}"/>`);
      break;
    case 'horizontal-stripes': {
      const bandHeight = 40 / colors.length;
      colors.forEach((rawColor, index) => {
        const color = safeColor(rawColor);
        shapes.push(`<rect x="0" y="${(index * bandHeight).toFixed(2)}" width="60" height="${bandHeight.toFixed(2)}" fill="${color}"/>`);
      });
      break;
    }
    case 'vertical-stripes': {
      const bandWidth = 60 / colors.length;
      colors.forEach((rawColor, index) => {
        const color = safeColor(rawColor);
        shapes.push(`<rect x="${(index * bandWidth).toFixed(2)}" y="0" width="${bandWidth.toFixed(2)}" height="40" fill="${color}"/>`);
      });
      break;
    }
    case 'canton': {
      shapes.push(`<rect width="60" height="40" fill="${safeColor(colors[0])}"/>`);
      if (colors.length > 2) {
        shapes.push(`<rect x="0" y="20" width="60" height="20" fill="${safeColor(colors[2])}"/>`);
      }
      shapes.push(`<rect x="0" y="0" width="26" height="20" fill="${safeColor(colors[1] ?? colors[0])}"/>`);
      break;
    }
  }

  const emblem = emblemSvg(flag.emblem, safeColor(flag.emblemColor), flag.layout === 'canton');
  if (emblem !== '') shapes.push(emblem);

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 40" width="60" height="40">` +
    shapes.join('') +
    `</svg>`
  );
}

function emblemSvg(emblem: string, color: string, canton: boolean): string {
  // Canton flags carry the emblem in the canton's center; others in the middle.
  const cx = canton ? 13 : 30;
  const cy = canton ? 10 : 20;
  const s = canton ? 0.55 : 1;
  switch (emblem) {
    case 'star': {
      // 5-point star centered at (cx, cy), outer radius 7.
      const points: string[] = [];
      for (let i = 0; i < 10; i++) {
        const radius = i % 2 === 0 ? 7 * s : 3 * s;
        const angle = -Math.PI / 2 + (i * Math.PI) / 5;
        points.push(`${(cx + radius * Math.cos(angle)).toFixed(2)},${(cy + radius * Math.sin(angle)).toFixed(2)}`);
      }
      return `<polygon points="${points.join(' ')}" fill="${color}"/>`;
    }
    case 'circle':
      return `<circle cx="${cx}" cy="${cy}" r="${(6 * s).toFixed(2)}" fill="${color}"/>`;
    case 'crescent':
      return (
        `<path d="M ${(cx + 4 * s).toFixed(2)} ${(cy - 7 * s).toFixed(2)} ` +
        `A ${(7 * s).toFixed(2)} ${(7 * s).toFixed(2)} 0 1 0 ${(cx + 4 * s).toFixed(2)} ${(cy + 7 * s).toFixed(2)} ` +
        `A ${(5.5 * s).toFixed(2)} ${(5.5 * s).toFixed(2)} 0 1 1 ${(cx + 4 * s).toFixed(2)} ${(cy - 7 * s).toFixed(2)} Z" fill="${color}"/>`
      );
    case 'sun': {
      const rays: string[] = [];
      for (let i = 0; i < 8; i++) {
        const angle = (i * Math.PI) / 4;
        const x1 = cx + 5 * s * Math.cos(angle);
        const y1 = cy + 5 * s * Math.sin(angle);
        const x2 = cx + 8 * s * Math.cos(angle);
        const y2 = cy + 8 * s * Math.sin(angle);
        rays.push(`<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="${color}" stroke-width="${(1.6 * s).toFixed(2)}"/>`);
      }
      return `<circle cx="${cx}" cy="${cy}" r="${(4 * s).toFixed(2)}" fill="${color}"/>` + rays.join('');
    }
    case 'cross':
      return (
        `<rect x="${(cx - 2 * s).toFixed(2)}" y="${(cy - 7 * s).toFixed(2)}" width="${(4 * s).toFixed(2)}" height="${(14 * s).toFixed(2)}" fill="${color}"/>` +
        `<rect x="${(cx - 7 * s).toFixed(2)}" y="${(cy - 2 * s).toFixed(2)}" width="${(14 * s).toFixed(2)}" height="${(4 * s).toFixed(2)}" fill="${color}"/>`
      );
    default:
      return '';
  }
}

/** Data-URL cache — flags are tiny, immutable per spec, requested repeatedly. */
const dataUrlCache = new Map<string, string>();

function cacheKey(flag: FlagDataJson): string {
  return `${flag.layout}|${flag.colors.join(',')}|${flag.emblem}|${flag.emblemColor}`;
}

/** Returns a cached `data:image/svg+xml` URL for the flag spec. */
export function flagDataUrl(flag: FlagDataJson): string {
  const key = cacheKey(flag);
  const cached = dataUrlCache.get(key);
  if (cached !== undefined) return cached;
  const url = `data:image/svg+xml;utf8,${encodeURIComponent(flagSvg(flag))}`;
  dataUrlCache.set(key, url);
  return url;
}

/** Test helper: clears the cache (isolation between tests). */
export function clearFlagCache(): void {
  dataUrlCache.clear();
}
