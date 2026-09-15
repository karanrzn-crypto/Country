import { describe, it, expect } from 'vitest';
import { fnv1a32, stableStringify, hashValue } from '../../../utils/hash';

describe('hash utilities', () => {
  it('fnv1a32 is deterministic and sensitive to input', () => {
    expect(fnv1a32('abc')).toBe(fnv1a32('abc'));
    expect(fnv1a32('abc')).not.toBe(fnv1a32('abd'));
  });

  it('stableStringify is independent of key insertion order', () => {
    const a = stableStringify({ b: 1, a: { d: 2, c: 3 } });
    const b = stableStringify({ a: { c: 3, d: 2 }, b: 1 });
    expect(a).toBe(b);
  });

  it('stableStringify handles arrays, nulls and nested structures', () => {
    const value = { list: [3, 1, { z: null, y: true }], empty: '' };
    expect(stableStringify(value)).toBe(stableStringify(JSON.parse(JSON.stringify(value))));
    expect(stableStringify([1, 2])).toBe('[1,2]');
  });

  it('stableStringify serializes Maps and Sets deterministically', () => {
    const a = stableStringify(new Map([
      ['b', 1],
      ['a', 2]
    ]));
    expect(a).toBe(stableStringify({ a: 2, b: 1 }));
    expect(stableStringify(new Set([2, 1]))).toBe(stableStringify([1, 2]));
  });

  it('hashValue changes when nested content changes', () => {
    const base = { economy: { treasury: { republic: 100 } } };
    const changed = { economy: { treasury: { republic: 101 } } };
    expect(hashValue(base)).not.toBe(hashValue(changed));
  });
});
