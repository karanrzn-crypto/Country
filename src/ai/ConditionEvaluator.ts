import type { AICondition, ConditionOp } from './types';

/**
 * Evaluates data-driven conditions against a metrics snapshot.
 * Unknown metrics fail closed (condition = false) so a typo in JSON never
 * crashes the simulation.
 */
export function evaluateCondition(condition: AICondition, metrics: Readonly<Record<string, number>>): boolean {
  const value = metrics[condition.metric];
  if (value === undefined) return false;
  return compare(value, condition.op, condition.value);
}

export function evaluateAll(conditions: readonly AICondition[], metrics: Readonly<Record<string, number>>): boolean {
  return conditions.every((condition) => evaluateCondition(condition, metrics));
}

function compare(left: number, op: ConditionOp, right: number): boolean {
  switch (op) {
    case '>':
      return left > right;
    case '>=':
      return left >= right;
    case '<':
      return left < right;
    case '<=':
      return left <= right;
    case '==':
      return left === right;
    case '!=':
      return left !== right;
  }
}
