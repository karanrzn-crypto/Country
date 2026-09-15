/**
 * Minimal, dependency-free schema validator.
 *
 * Used for: configuration, static game data (units, weapons, strategies...)
 * and save files. Produces precise path-based issues instead of failing at
 * the first problem, so corrupted inputs can be diagnosed in one pass.
 */

import { DataValidationError } from './errors';

export type FieldSchema =
  | { readonly type: 'string'; readonly minLength?: number; readonly pattern?: string }
  | { readonly type: 'number'; readonly min?: number; readonly max?: number; readonly integer?: boolean }
  | { readonly type: 'boolean' }
  | { readonly type: 'enum'; readonly values: readonly (string | number)[] }
  | { readonly type: 'array'; readonly items: FieldSchema; readonly minLength?: number }
  | { readonly type: 'object'; readonly fields: Readonly<Record<string, FieldSchema>>; readonly allowUnknown?: boolean }
  | { readonly type: 'record'; readonly values: FieldSchema }
  | { readonly type: 'optional'; readonly inner: FieldSchema }
  | { readonly type: 'null' }
  | { readonly type: 'union'; readonly options: readonly FieldSchema[] }
  | { readonly type: 'any' };

export interface SchemaIssue {
  readonly path: string;
  readonly message: string;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly issues: readonly SchemaIssue[];
}

class Validator {
  private readonly issues: SchemaIssue[] = [];

  validate(value: unknown, schema: FieldSchema, rootPath = '$'): ValidationResult {
    this.check(value, schema, rootPath);
    return { valid: this.issues.length === 0, issues: this.issues };
  }

  private fail(path: string, message: string): void {
    this.issues.push({ path, message });
  }

  private check(value: unknown, schema: FieldSchema, path: string): void {
    switch (schema.type) {
      case 'any':
        return;

      case 'optional':
        if (value === undefined) return;
        this.check(value, schema.inner, path);
        return;

      case 'null':
        if (value !== null) this.fail(path, `expected null, got ${typeName(value)}`);
        return;

      case 'string': {
        if (typeof value !== 'string') {
          this.fail(path, `expected string, got ${typeName(value)}`);
          return;
        }
        if (schema.minLength !== undefined && value.length < schema.minLength) {
          this.fail(path, `string shorter than ${schema.minLength} characters`);
        }
        if (schema.pattern !== undefined && new RegExp(schema.pattern).test(value) === false) {
          this.fail(path, `string does not match pattern ${schema.pattern}`);
        }
        return;
      }

      case 'number': {
        if (typeof value !== 'number' || Number.isNaN(value)) {
          this.fail(path, `expected number, got ${typeName(value)}`);
          return;
        }
        if (schema.integer && !Number.isInteger(value)) this.fail(path, 'expected integer');
        if (schema.min !== undefined && value < schema.min) this.fail(path, `number below minimum ${schema.min}`);
        if (schema.max !== undefined && value > schema.max) this.fail(path, `number above maximum ${schema.max}`);
        return;
      }

      case 'boolean':
        if (typeof value !== 'boolean') this.fail(path, `expected boolean, got ${typeName(value)}`);
        return;

      case 'enum':
        if (!schema.values.includes(value as string | number)) {
          this.fail(path, `value not in [${schema.values.join(', ')}]`);
        }
        return;

      case 'array': {
        if (!Array.isArray(value)) {
          this.fail(path, `expected array, got ${typeName(value)}`);
          return;
        }
        if (schema.minLength !== undefined && value.length < schema.minLength) {
          this.fail(path, `array shorter than ${schema.minLength} items`);
        }
        value.forEach((item, index) => this.check(item, schema.items, `${path}[${index}]`));
        return;
      }

      case 'object': {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          this.fail(path, `expected object, got ${typeName(value)}`);
          return;
        }
        const record = value as Record<string, unknown>;
        for (const [key, fieldSchema] of Object.entries(schema.fields)) {
          this.check(record[key], fieldSchema, `${path}.${key}`);
        }
        if (schema.allowUnknown !== true) {
          for (const key of Object.keys(record)) {
            if (!(key in schema.fields)) this.fail(`${path}.${key}`, 'unknown field');
          }
        }
        return;
      }

      case 'record': {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          this.fail(path, `expected record, got ${typeName(value)}`);
          return;
        }
        for (const [key, item] of Object.entries(value)) {
          this.check(item, schema.values, `${path}.${key}`);
        }
        return;
      }

      case 'union': {
        const probe = new Validator();
        for (const option of schema.options) {
          probe.issues.length = 0;
          probe.check(value, option, path);
          if (probe.issues.length === 0) return;
        }
        this.fail(path, 'value did not match any union option');
        return;
      }
    }
  }
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export function validate(value: unknown, schema: FieldSchema, rootPath = '$'): ValidationResult {
  return new Validator().validate(value, schema, rootPath);
}

/** Validates and throws DataValidationError with a joined issue summary. */
export function validateOrThrow(value: unknown, schema: FieldSchema, label: string): void {
  const result = validate(value, schema, label);
  if (!result.valid) {
    const summary = result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
    throw new DataValidationError(
      `Validation failed for ${label} (${result.issues.length} issue(s)): ${summary}`,
      { issues: result.issues }
    );
  }
}
