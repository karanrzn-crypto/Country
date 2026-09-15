import { describe, it, expect } from 'vitest';
import { IdGenerator, splitId } from '../../../core/IdGenerator';

describe('IdGenerator', () => {
  it('generates sequential, prefixed, zero-padded ids', () => {
    const ids = new IdGenerator();
    expect(ids.next('unit')).toBe('unit-000001');
    expect(ids.next('unit')).toBe('unit-000002');
    expect(ids.next('agent')).toBe('agent-000001');
    expect(ids.next('unit')).toBe('unit-000003');
  });

  it('peek does not consume the counter', () => {
    const ids = new IdGenerator();
    expect(ids.peek('unit')).toBe('unit-000001');
    expect(ids.next('unit')).toBe('unit-000001');
  });

  it('serialize/restore keeps counters stable across save/load', () => {
    const first = new IdGenerator();
    first.next('unit');
    first.next('unit');
    const state = first.serialize();

    const second = new IdGenerator();
    second.restore(state);
    expect(second.next('unit')).toBe('unit-000003');
  });

  it('observe() lifts the counter above external ids', () => {
    const ids = new IdGenerator();
    ids.observe('unit-000500');
    expect(ids.next('unit')).toBe('unit-000501');
  });

  it('splitId parses kind and numeric part', () => {
    expect(splitId('unit-000042')).toEqual(['unit', '000042']);
  });
});
