import { describe, it, expect } from 'vitest';
import { validate, validateOrThrow } from '../../../utils/validation';
import { DataValidationError } from '../../../utils/errors';

describe('schema validator', () => {
  const personSchema = {
    type: 'object' as const,
    fields: {
      name: { type: 'string' as const, minLength: 1 },
      age: { type: 'number' as const, min: 0, max: 150, integer: true },
      role: { type: 'enum' as const, values: ['leader', 'commander'] },
      nickname: { type: 'optional' as const, inner: { type: 'string' as const } },
      tags: { type: 'array' as const, items: { type: 'string' as const } }
    }
  };

  it('accepts a valid object', () => {
    const result = validate(
      { name: 'Ada', age: 40, role: 'leader', tags: ['a', 'b'] },
      personSchema
    );
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('rejects wrong types and reports precise paths', () => {
    const result = validate({ name: 42, age: 'old', role: 'general' }, personSchema);
    expect(result.valid).toBe(false);
    const paths = result.issues.map((issue) => issue.path);
    expect(paths).toContain('$.name');
    expect(paths).toContain('$.age');
    expect(paths).toContain('$.role');
  });

  it('rejects unknown fields unless allowed', () => {
    const result = validate({ name: 'Ada', age: 1, role: 'leader', extra: true, tags: [] }, personSchema);
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.path === '$.extra')).toBe(true);
  });

  it('optional fields may be missing but not invalid', () => {
    expect(validate({ name: 'A', age: 1, role: 'leader', tags: [] }, personSchema).valid).toBe(true);
    expect(validate({ name: 'A', age: 1, role: 'leader', nickname: 5, tags: [] }, personSchema).valid).toBe(false);
  });

  it('validates nested arrays with indexed paths', () => {
    const result = validate({ name: 'A', age: 1, role: 'leader', tags: ['ok', 42] }, personSchema);
    expect(result.issues.some((issue) => issue.path === '$.tags[1]')).toBe(true);
  });

  it('validates records', () => {
    const schema = { type: 'record' as const, values: { type: 'number' as const, min: 0 } };
    expect(validate({ a: 1, b: 2.5 }, schema).valid).toBe(true);
    expect(validate({ a: -1 }, schema).valid).toBe(false);
  });

  it('validates unions', () => {
    const schema = {
      type: 'union' as const,
      options: [
        { type: 'string' as const, minLength: 3 },
        { type: 'number' as const, min: 0 }
      ]
    };
    expect(validate('abc', schema).valid).toBe(true);
    expect(validate(5, schema).valid).toBe(true);
    expect(validate('ab', schema).valid).toBe(false);
    expect(validate(-1, schema).valid).toBe(false);
  });

  it('validates null via the dedicated schema', () => {
    expect(validate(null, { type: 'null' }).valid).toBe(true);
    expect(validate(0, { type: 'null' }).valid).toBe(false);
  });

  it('validateOrThrow throws DataValidationError with a summary', () => {
    expect(() => validateOrThrow({ name: '', age: -5, role: 'x', tags: [] }, personSchema, 'person')).toThrowError(
      DataValidationError
    );
  });
});
