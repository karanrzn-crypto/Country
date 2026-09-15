import { GameError } from './errors';

/**
 * FNV-1a 32-bit string hash. Fast and stable across platforms — used for
 * save checksums and deterministic state hashing (not cryptographic).
 */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Deterministic JSON serializer with object keys sorted, so that key
 * insertion order never affects the output. Maps and Sets are supported.
 * Used for save checksums and state hashing in determinism tests.
 */
export function stableStringify(value: unknown): string {
  return stableSerialize(value, 0);
}

function stableSerialize(value: unknown, depth: number): string {
  if (depth > 64) {
    throw new GameError('E_GENERIC', 'stableStringify: maximum nesting depth exceeded');
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined';
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => stableSerialize(item, depth + 1));
    return `[${items.join(',')}]`;
  }
  if (value instanceof Map) {
    const entries = [...value.entries()].sort(([a], [b]) => String(a).localeCompare(String(b)));
    return stableSerialize(Object.fromEntries(entries), depth);
  }
  if (value instanceof Set) {
    const items = [...value].sort((a, b) => String(a).localeCompare(String(b)));
    return stableSerialize(items, depth);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts = keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key], depth + 1)}`);
  return `{${parts.join(',')}}`;
}

/** Convenience: stableStringify + fnv1a32 in one step. */
export function hashValue(value: unknown): number {
  return fnv1a32(stableStringify(value));
}
